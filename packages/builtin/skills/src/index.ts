/**
 * plume.skills 的逻辑入口，跑在 agent 进程：系统提示词里列出技能（`model.context` 加一段），模型调 `skill` 工具时把那个技能的
 * 正文交回去；技能也进输入框的 `/` 菜单，人点了、或在话里写 `/skill:名字` 就让模型用它。技能写了 `allowed-tools` 的，
 * 生效期间别的工具经 tool.execute 的层拒掉。别的插件随包带的 `skills/` 也读（`ctx.plugins.list()`）。「扩展 › 技能」经 `ctx.serve`
 * 列选中项目的、个人的和插件带来的技能、开关、打开、删除、处理同名的。经服务 `resources` 登记 `skill://` 地址，read、ls 能读技能的正文和目录。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { Plugin, SlashCommand } from "@plume/contract";
import type { SkillRow, SkillsApi, SkillsView } from "./api.ts";
import { computeDiff } from "./line-diff.ts";
import { formatCatalogue, formatInvocation, loadSkills, personalDir, type PluginBundle, type Skill, skillSources } from "./loader.ts";
import { MESSAGES } from "./messages.ts";
import { skillResource } from "./resource.ts";

const TOOL = "skill";
/** plume.mcp 的两个工具：搜索只是看说明书，不受限制；`mcp_call` 按它要调的那个工具的名字查。 */
const MCP_SEARCH = "mcp_search";
const MCP_CALL = "mcp_call";

/** 话里点名一个技能：「帮我 /skill:pdf 处理一下这个文件」。 */
const MENTION = /(^|\s)\/skill:([a-z0-9:-]+)(?=\s|$)/i;

/** 给人看的目录：家目录写成 `~`。 */
function tilde(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/**
 * 用系统的默认程序打开，目录在文件管理器里打开。Windows 上交给 explorer，不经 cmd 的 `start`：文件名里的 `&` 会被它当成
 * 命令分隔符。explorer 打开成功也报退出码 1，所以那边只看起没起得来。
 */
function openWith(path: string): Promise<void> {
	const [command, args] = process.platform === "darwin" ? ["open", [path]] : process.platform === "win32" ? ["explorer.exe", [path]] : ["xdg-open", [path]];
	return new Promise((resolve, reject) =>
		execFile(command as string, args as string[], (error) =>
			error && (process.platform !== "win32" || typeof error.code !== "number") ? reject(error) : resolve(),
		),
	);
}

/** 插件给人看的名字：`package.json` 里的 `plume.displayName`。 */
async function displayName(dir: string): Promise<string | undefined> {
	try {
		const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { plume?: { displayName?: unknown } };
		const name = manifest.plume?.displayName;
		return typeof name === "string" && name.trim() ? name.trim() : undefined;
	} catch {
		return undefined;
	}
}

const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");

interface Settings {
	/** 关掉的技能，按 `SKILL.md` 的路径；只记关掉的，打开就是删掉那一条。 */
	disabled: Set<string>;
	/** 技能名 → 同名时该赢的那个 `SKILL.md`。 */
	preferred: Record<string, string>;
}

/** 生效中的技能和它允许的工具；没限制时 `allowedTools` 不给。 */
interface ActiveSkill {
	name: string;
	allowedTools?: string[];
}

export default {
	name: "plume.skills",
	inject: ["resources"],
	apply(ctx) {
		const text = () => MESSAGES[ctx.locale()];
		const settingsFile = join(ctx.dataDir, "settings.json");
		const readSettings = async (): Promise<Settings> => {
			const raw = await readFile(settingsFile, "utf8").catch(() => null);
			const settings: Settings = { disabled: new Set(), preferred: {} };
			if (raw === null) return settings;
			try {
				const parsed = JSON.parse(raw) as { disabled?: unknown; preferred?: unknown };
				if (Array.isArray(parsed.disabled)) settings.disabled = new Set(parsed.disabled.filter((item): item is string => typeof item === "string"));
				if (parsed.preferred && typeof parsed.preferred === "object") {
					for (const [name, path] of Object.entries(parsed.preferred)) if (typeof path === "string") settings.preferred[name] = path;
				}
			} catch {
				ctx.log.warn(`${settingsFile} 不是有效的 JSON，按没有关掉的技能处理`);
			}
			return settings;
		};
		const writeSettings = (settings: Settings) =>
			writeFile(settingsFile, `${JSON.stringify({ disabled: [...settings.disabled], preferred: settings.preferred }, null, "\t")}\n`);

		/**
		 * 加载着的插件，连自己：自己随包带着写插件的技能 plume-plugin（插件市场的「新建插件」点名它）。
		 * 每次现问：装上、停用一个插件，下一轮就对。
		 */
		const bundles = (): Promise<PluginBundle[]> =>
			Promise.all(ctx.plugins.list().map(async (plugin) => ({ label: (await displayName(plugin.dir)) ?? plugin.name, root: plugin.dir })));
		const load = async (cwd: string | undefined) => {
			const settings = await readSettings();
			const loaded = await loadSkills(skillSources(cwd || undefined, await bundles()), { tools: ctx.tools.names(), preferred: settings.preferred });
			return { ...loaded, settings };
		};
		const enabledSkills = async (cwd: string | undefined): Promise<Skill[]> => {
			const { skills, settings } = await load(cwd);
			return skills.filter((skill) => !settings.disabled.has(skill.path));
		};

		/**
		 * 按会话记：生效中的技能，和上下文里已经有的技能正文（指纹）。生效的技能到人说下一句话、或换了一个技能时为止：
		 * 只在这次工具调用里算数的限制，管不到技能要指挥的那些活。
		 */
		ctx.effect(ctx.use("resources").register(skillResource(enabledSkills)));

		const active = new Map<string, ActiveSkill>();
		const injected = new Map<string, Set<string>>();
		ctx.sessions.onDeleted((sessionId) => {
			active.delete(sessionId);
			injected.delete(sessionId);
		});

		ctx.tools.register({
			name: TOOL,
			// i18n-exempt：写给模型的工具说明。
			description: "Load a skill's instructions. They come back as the result and take precedence over your default approach.",
			parameters: {
				type: "object",
				properties: {
					name: { type: "string", description: "Exact skill name from the skill list." },
					args: { type: "string", description: "Optional arguments or context to pass to the skill." },
				},
				required: ["name"],
				additionalProperties: false,
			},
			async execute(args, run) {
				const name = typeof args.name === "string" ? args.name.trim() : "";
				const skills = await enabledSkills(run.cwd);
				const skill = skills.find((candidate) => candidate.name === name);
				if (!skill) {
					const available = skills.filter((candidate) => !candidate.manualOnly).map((candidate) => candidate.name);
					return {
						output:
							available.length > 0 ? `No skill named "${name}". Available: ${available.join(", ")}.` : `No skill named "${name}", and no skills are installed.`,
						isError: true,
					};
				}
				active.set(run.sessionId, { name: skill.name, ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}) });
				const limit = skill.allowedTools
					? // i18n-exempt：写给模型的话。
						`\n\n<skill-tools>这个技能声明了它只用这些工具：${skill.allowedTools.join("、")}。其他工具在它生效期间会被拒绝。</skill-tools>`
					: "";
				const output = formatInvocation(skill, typeof args.args === "string" ? args.args : undefined) + limit;
				// 同一份正文已经在上下文里了，再放一遍只是占地方。压缩掉以后 model.context 重新数，就又能放了。
				const seen = injected.get(run.sessionId) ?? new Set<string>();
				injected.set(run.sessionId, seen);
				const key = fingerprint(output);
				const duplicate = seen.has(key);
				seen.add(key);
				return {
					output: duplicate ? `Skill "${skill.name}" is already loaded in the current context. Follow its instructions above.${limit}` : output,
					details: { name: skill.name, path: skill.path, scope: skill.scope, ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}) },
				};
			},
		});

		// 没有可用的技能时连工具一起藏起来：一个永远只会报「没有这个技能」的工具只是占地方。
		ctx.hook("model.context", async (input, next) => {
			// 上下文里有哪些技能正文，按真正要发的历史重数：压缩过就该允许重新载入。
			const seen = new Set<string>();
			for (const message of input.messages) {
				if (message.role !== "toolResult" || message.toolName !== TOOL || message.isError) continue;
				for (const part of message.content) if (part.type === "text") seen.add(fingerprint(part.text));
			}
			injected.set(input.sessionId, seen);
			const skills = await enabledSkills(input.cwd);
			if (skills.length === 0) return next({ ...input, tools: input.tools.filter((tool) => tool.name !== TOOL) });
			const catalogue = formatCatalogue(skills);
			return next(catalogue ? { ...input, sections: [...input.sections, { id: "skills", text: catalogue }] } : input);
		});

		ctx.hook("tool.execute", async (input, next) => {
			const skill = active.get(input.sessionId);
			const name = input.tool.name === MCP_CALL && typeof input.call.args.tool === "string" ? input.call.args.tool : input.tool.name;
			// `skill` 本身总能调：限制了工具的技能不能把会话困在自己里面，换一个技能就是出去的路。
			if (!skill?.allowedTools || name === TOOL || name === MCP_SEARCH || skill.allowedTools.includes(name)) return next(input);
			return {
				// i18n-exempt：写给模型的话。
				output: `技能“${skill.name}”声明了它只用 ${skill.allowedTools.join("、")}，所以 \`${name}\` 在它生效期间不可用。如果这一步确实需要它，先说明为什么，让用户决定。`,
				isError: true,
			};
		});

		ctx.hook("prompt.submit", async (input, next) => {
			// 人说的新一句是新的吩咐：上一个技能的工具限制留过这句话，会悄悄拒掉人刚要的活。
			if (!input.synthetic) active.delete(input.sessionId);
			const verdict = await next(input);
			// 话以命令开头时，里面的 `/skill:x` 是那条命令的参数，不是又点了一个技能。
			const match = verdict.block || input.text.trimStart().startsWith("/") ? null : MENTION.exec(input.text);
			const name = match?.[2]?.toLowerCase();
			if (verdict.block || !name || !(await enabledSkills(input.cwd)).some((skill) => skill.name === name)) return verdict;
			// i18n-exempt：写给模型的话，不随界面语言变。
			const ask = `Use the \`${name}\` skill.`;
			return { ...verdict, context: verdict.context ? `${verdict.context}\n\n${ask}` : ask };
		});

		ctx.commands.provide({
			async list({ cwd }) {
				const messages = text();
				return (await enabledSkills(cwd)).map((skill): SlashCommand => ({
					name: skill.name,
					description: skill.description,
					source: skill.plugin ? messages.pluginSkill(skill.plugin.label) : skill.scope === "workspace" ? messages.projectSkill : messages.personalSkill,
				}));
			},
			/**
			 * 展开成一句「用这个技能」，不展开成技能正文：正文可能有几千字，该在工具结果里，`skill` 工具会把它放进去。
			 * 手动调用的技能也能这样用：它的意思是「别自己挑」，不是「不许用」。
			 */
			async expand(name, rest, { cwd }) {
				const skill = (await enabledSkills(cwd)).find((candidate) => candidate.name === name);
				if (!skill) throw new Error(text().notFound(name));
				// i18n-exempt：写给模型的话，不随界面语言变。
				const ask = `Use the \`${skill.name}\` skill.`;
				return { text: rest ? `${ask}\n\n${rest}` : ask, displayText: rest ? `/${name} ${rest}` : `/${name}` };
			},
		});

		/**
		 * 「扩展 › 技能」列的：选了项目时连那个项目的，加上个人的和插件带来的。`files` 是读到的全部 `SKILL.md`，被同名遮住的也在。
		 * 界面传来的 `cwd` 只用来拼出那几个技能目录去读，不是字符串就当没选项目。
		 */
		const listed = async (cwd: unknown): Promise<{ view: SkillsView; files: Set<string> }> => {
			const { skills, diagnostics, settings } = await load(typeof cwd === "string" && cwd ? cwd : undefined);
			const rows = skills.map((skill): SkillRow => ({
				name: skill.name,
				description: skill.description,
				path: skill.path,
				root: tilde(skill.root),
				...(skill.scope === "workspace" ? { project: true as const } : {}),
				...(skill.plugin ? { plugin: skill.plugin.label } : {}),
				manualOnly: skill.manualOnly,
				enabled: !settings.disabled.has(skill.path),
			}));
			const files = new Set([...skills.map((skill) => skill.path), ...diagnostics.filter((item) => item.problem === "shadowed").map((item) => item.path)]);
			return { view: { skills: rows, diagnostics, dir: personalDir() }, files };
		};
		/** 只认读到过的技能：界面传来的路径不能指到别处去。 */
		const known = async (path: unknown, cwd: unknown) => {
			if (typeof path !== "string" || !(await listed(cwd)).files.has(path)) throw new Error(text().notALoadedSkill);
			return path;
		};

		ctx.serve({
			list: async (cwd) => (await listed(cwd)).view,
			async setEnabled(paths, enabled, cwd) {
				const { files } = await listed(cwd);
				if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && files.has(path))) throw new Error(text().notALoadedSkill);
				const settings = await readSettings();
				for (const path of paths) {
					if (enabled) settings.disabled.delete(path);
					else settings.disabled.add(path);
				}
				await writeSettings(settings);
			},
			open: async (path, cwd) => openWith(await known(path, cwd)),
			async reveal() {
				const dir = personalDir();
				await mkdir(dir, { recursive: true });
				await openWith(dir);
			},
			async remove(path, cwd) {
				const file = await known(path, cwd);
				// 插件带来的随插件装卸：删掉它的目录是改坏了那个插件，不想要就关掉。
				if ((await bundles()).some((plugin) => file.startsWith(`${join(plugin.root, "skills")}${sep}`))) throw new Error(text().pluginSkillKept);
				// 移到系统的废纸篓（回收站），不直接删：技能是人写的或装的，删错了还能拿回来。
				await ctx.trash(dirname(file));
			},
			async diff(winner, loser, cwd) {
				const [before, after] = await Promise.all([readFile(await known(winner, cwd), "utf8"), readFile(await known(loser, cwd), "utf8")]);
				return computeDiff(before, after);
			},
			async prefer(name, path, cwd) {
				const { view } = await listed(cwd);
				const same = view.diagnostics.some((item) => item.problem === "shadowed" && item.name === name && (item.path === path || item.detail === path));
				if (typeof name !== "string" || !same) throw new Error(text().notALoadedSkill);
				const settings = await readSettings();
				settings.preferred[name] = await known(path, cwd);
				await writeSettings(settings);
				return { wroteTo: tilde(settingsFile) };
			},
		} satisfies SkillsApi);
	},
} satisfies Plugin;
