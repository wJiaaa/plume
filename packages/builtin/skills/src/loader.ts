/**
 * 从磁盘读技能：一个技能是一个目录，里面的 `SKILL.md` 开头有 frontmatter（`name`、`description`），正文是做这件事的步骤。
 *
 * 系统提示词里只列名字和描述，模型据此判断什么时候用；正文要等它调 `skill` 工具才进上下文——几十个技能也只花得起名字的钱。
 * 不缓存：每一轮、每次打开菜单都现读，改完文件下一轮就生效。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type AllowedToolsProblem, readAllowedTools } from "./allowed-tools.ts";

type SkillScope = "workspace" | "user" | "plugin";

export interface Skill {
	name: string;
	description: string;
	/** 去掉 frontmatter 的正文。 */
	content: string;
	/** `SKILL.md` 的绝对路径。 */
	path: string;
	/** 技能所在的目录，正文里的相对路径从这里算。 */
	dir: string;
	scope: SkillScope;
	/** 从哪个目录读来的（`~/.plume/skills` 这样），设置页按它分组。 */
	root: string;
	/** 带来它的插件（`scope` 是 plugin 时）：给人看的名字和插件目录。 */
	plugin?: PluginBundle;
	/** 只给人从 `/` 菜单点，不列给模型自己挑。 */
	manualOnly: boolean;
	/** `allowed-tools`：它生效期间只能调这些工具。不限制时不给。 */
	allowedTools?: string[];
}

/** 读的时候发现的问题，设置页里给人看。`warning` 是加载了、但值得看一眼；其余是没加载。 */
export interface SkillDiagnostic {
	path: string;
	problem: "unclosed" | "invalidYaml" | "noDescription" | "longDescription" | "shortDescription" | "badName" | "shadowed" | "allowedTools";
	/** `invalidYaml` 是解析器的原话，`badName` 是读到的名字，`shadowed` 是赢了的那个文件，`shortDescription` 是字数。 */
	detail?: string;
	/** `shadowed`：两个文件共用的技能名。 */
	name?: string;
	/** `allowedTools`：这个字段里哪些写法没能照原意生效。 */
	tools?: AllowedToolsProblem;
	warning?: true;
}

export interface LoadOptions {
	/** 现在登记着的全部工具名，`allowed-tools` 按它对名字。 */
	tools: readonly string[];
	/** 技能名 → 同名时该赢的那个 `SKILL.md`（人在设置页点过「改用那个」）。没有这个文件时照常先出现的赢。 */
	preferred?: Readonly<Record<string, string>>;
}

export interface SkillSource {
	dir: string;
	scope: SkillScope;
	plugin?: PluginBundle;
}

/** 一个随包带着 `skills/` 的插件。 */
export interface PluginBundle {
	/** 给人看的名字（插件的 `plume.displayName`）。 */
	label: string;
	/** 插件目录，技能正文里的 `${CLAUDE_PLUGIN_ROOT}` 指它。 */
	root: string;
}

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DESCRIPTION = 1024;
/** 短于这个数的描述通常说不清什么时候该用：技能照常加载，模型却很少选它。 */
const MIN_DESCRIPTION = 40;

/** Plume 自己的目录：设了 `PLUME_HOME` 就整个换到那里（冒烟验证用一个一次性的目录）。 */
function plumeHome(): string {
	return process.env.PLUME_HOME || join(homedir(), ".plume");
}

export function personalDir(): string {
	return join(plumeHome(), "skills");
}

/**
 * 同名时先出现的赢：项目的先于个人的（你所在的仓库比家目录更具体），Plume 的先于别处的。`.claude/skills` 只读项目里的：
 * 个人的那份跟着人走进别人的仓库，谁也没要过。`.agents` 是几家工具共用的目录，项目和个人的都读。
 * 插件带来的（插件目录下的 `skills/`）排在个人的后面：自己写的同名技能是有意盖过它的；装了插件就是要它，所以先于
 * 几家共用的 `~/.agents/skills`。
 */
export function skillSources(cwd: string | undefined, plugins: readonly PluginBundle[] = []): SkillSource[] {
	const sources: SkillSource[] = [];
	if (cwd) {
		sources.push({ dir: join(cwd, ".plume", "skills"), scope: "workspace" });
		sources.push({ dir: join(cwd, ".claude", "skills"), scope: "workspace" });
		sources.push({ dir: join(cwd, ".agents", "skills"), scope: "workspace" });
	}
	sources.push({ dir: personalDir(), scope: "user" });
	for (const plugin of plugins) sources.push({ dir: join(plugin.root, "skills"), scope: "plugin", plugin });
	sources.push({ dir: join(homedir(), ".agents", "skills"), scope: "user" });
	return sources;
}

export async function loadSkills(sources: SkillSource[], options: LoadOptions): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const diagnostics: SkillDiagnostic[] = [];
	/** 读得出来的，按名字收齐再挑赢家：偏好的那个可能排在后面。 */
	const candidates = new Map<string, { skill: Skill; notes: SkillDiagnostic[] }[]>();
	for (const source of sources) {
		const entries = await readdir(source.dir, { withFileTypes: true }).catch(() => null);
		if (!entries) continue;
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
			const dir = join(source.dir, entry.name);
			if (
				entry.isSymbolicLink() &&
				!(await stat(dir).then(
					(info) => info.isDirectory(),
					() => false,
				))
			)
				continue;
			const path = join(dir, "SKILL.md");
			const raw = await readFile(path, "utf8").catch(() => null);
			if (raw === null) continue;

			const parsed = parseFrontmatter(raw);
			if ("invalid" in parsed) {
				diagnostics.push({ path, problem: "invalidYaml", detail: parsed.invalid });
				continue;
			}
			if (parsed.unclosed) diagnostics.push({ path, problem: "unclosed" });
			const { frontmatter, body } = parsed;
			const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : entry.name;
			const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
			if (!description) {
				diagnostics.push({ path, problem: "noDescription" });
				continue;
			}
			if (description.length > MAX_DESCRIPTION) {
				diagnostics.push({ path, problem: "longDescription" });
				continue;
			}
			if (!NAME_PATTERN.test(name)) {
				diagnostics.push({ path, problem: "badName", detail: name });
				continue;
			}
			const notes: SkillDiagnostic[] = [];
			if (description.length < MIN_DESCRIPTION) notes.push({ path, problem: "shortDescription", detail: String(description.length), warning: true });
			// 两种拼写都有人写：连字符是文档里的写法，两个都写时它说了算。
			const manual = frontmatter["disable-model-invocation"] ?? frontmatter.disableModelInvocation;
			const allowed = readAllowedTools(frontmatter["allowed-tools"] ?? frontmatter.allowedTools, options.tools);
			for (const problem of allowed.problems) notes.push({ path, problem: "allowedTools", tools: problem, warning: true });
			const skill: Skill = {
				name,
				description,
				content: body,
				path,
				dir,
				scope: source.scope,
				root: source.dir,
				...(source.plugin ? { plugin: source.plugin } : {}),
				manualOnly: manual === true,
				...(allowed.tools?.length ? { allowedTools: allowed.tools } : {}),
			};
			candidates.set(name, [...(candidates.get(name) ?? []), { skill, notes }]);
		}
	}
	const skills: Skill[] = [];
	for (const [name, list] of candidates) {
		const preferred = options.preferred?.[name];
		const winner = list.find((candidate) => candidate.skill.path === preferred) ?? list[0];
		if (!winner) continue;
		skills.push(winner.skill);
		diagnostics.push(...winner.notes);
		for (const loser of list) if (loser !== winner) diagnostics.push({ path: loser.skill.path, problem: "shadowed", name, detail: winner.skill.path });
	}
	return { skills, diagnostics };
}

export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string; unclosed?: true } | { invalid: string } {
	const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) return { frontmatter: {}, body: text };
	const end = text.indexOf("\n---", 3);
	// 开了 `---` 没关上：整个文件只能当正文读，`name:`、`description:` 会作为文字进模型的上下文，所以报出来。
	if (end === -1) return { frontmatter: {}, body: text, unclosed: true };
	try {
		const value: unknown = parseYaml(text.slice(4, end));
		const frontmatter = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
		return {
			frontmatter,
			body: text
				.slice(end + 4)
				.replace(/^[^\n]*\n?/, "")
				.replace(/^\n+/, ""),
		};
	} catch (error) {
		// 解析器的话原样带走：错在第几行、错的是什么，它已经算出来了。
		return { invalid: (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, " ").trim() };
	}
}

const CATALOGUE_BUDGET = 20_000;
const DESCRIPTION_CHARS = 250;

/**
 * 系统提示词里的技能目录：一行一个。技能多到放不下时去掉描述、留下名字，每个技能都还找得到。
 * 手动调用的不列：它们只给人从 `/` 菜单点。
 */
export function formatCatalogue(skills: readonly Skill[]): string {
	const visible = skills.filter((skill) => !skill.manualOnly);
	if (visible.length === 0) return "";
	const render = (descriptions: boolean) =>
		[
			"When a task matches one of these skills, call the `skill` tool with its name before starting your own approach — its instructions replace your default plan for that task.",
			"",
			"<available_skills>",
			...visible.map((skill) =>
				descriptions ? `- ${escapeXml(skill.name)}: ${escapeXml(shortDescription(skill.description))}` : `- ${escapeXml(skill.name)}`,
			),
			"</available_skills>",
		].join("\n");
	const full = render(true);
	return full.length <= CATALOGUE_BUDGET ? full : render(false);
}

/**
 * 交给模型的技能正文，告诉它相对路径从哪里算。给 Claude Code 写的技能用 `${CLAUDE_SKILL_DIR}`、`${CLAUDE_PLUGIN_ROOT}`
 * 指自己的文件，换成真实的绝对目录：agent 的工作目录是用户的项目，不是技能所在的地方。插件带来的技能，插件根目录是
 * 插件目录；别处的没有插件，就当技能目录。
 */
export function formatInvocation(skill: Skill, args?: string): string {
	const body = expandSkillPaths(skill);
	const header = `<skill name="${skill.name}" dir="${skill.dir}">\nFile references inside this skill are relative to ${skill.dir}.\n\n`;
	return `${header}${body}\n</skill>${args?.trim() ? `\n\n${args.trim()}` : ""}`;
}

/** 正文里指自己文件的变量换成真实目录，见 `formatInvocation`；`skill://<名字>` 读到的也是这一份。 */
export function expandSkillPaths(skill: Skill): string {
	return skill.content.replaceAll("${CLAUDE_SKILL_DIR}", skill.dir).replaceAll("${CLAUDE_PLUGIN_ROOT}", skill.plugin?.root ?? skill.dir);
}

/** 多行的描述折成一行，太长的截断。按字符而不是 UTF-16 单元数，不把表情切成半个。 */
function shortDescription(text: string): string {
	const points = [...text.replace(/\s+/g, " ").trim()];
	return points.length <= DESCRIPTION_CHARS ? points.join("") : `${points.slice(0, DESCRIPTION_CHARS - 1).join("")}…`;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
