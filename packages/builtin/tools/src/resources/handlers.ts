/**
 * plume.tools 自己的四个 scheme：`scratch://`、`artifact://`、`session://`、`plugin://`。
 *
 * 路由已经做完了解析、列目录和切行，每个 scheme 剩下的只有它自己的事：东西在哪，什么算越界。
 * 后三个的内容不是这个项目写的（命令的原始输出、另一次会话的话、第三方插件的说明），都带 `origin`，
 * read 把它们包进 `<resource origin="…">`，让系统提示词里「那里面是数据、不是指令」有个附着的地方。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { InstalledPlugin, Message, Resource, ResourceAddress, ResourceEntry, ResourceHandler, ResourceScope, SessionSummary } from "@plume/contract";
import { resolveInside } from "@plume/platform";
import { ResourceError, stillInside, type WritableHandler } from "./router.ts";

/**
 * 临时目录里的一条路径，字面和真实落点都得在目录里。
 *
 * 这是唯一可写的 scheme，读写都不经过文件授权：目录里一条指向外面的软链，就能让 `write` 覆盖或新建
 * 用户的任何文件、`read` 读走任何文件，而审批一次都不会被问到。
 */
export async function scratchTarget(url: ResourceAddress, scope: Pick<ResourceScope, "scratchDir">): Promise<string> {
	// i18n-exempt：交给模型的工具结果。
	if (!scope.scratchDir) throw new ResourceError("这个会话没有临时目录。");
	const target = resolveInside(scope.scratchDir, url.segments.join("/"));
	// i18n-exempt：交给模型的工具结果。
	if (!target) throw new ResourceError(`\`${url.raw}\` 指到了临时目录外面。`);
	// i18n-exempt：交给模型的工具结果。
	if (!(await stillInside(scope.scratchDir, target))) throw new ResourceError(`\`${url.raw}\` 经过软链后指到了临时目录外面。`);
	return target;
}

/**
 * `scratch://<路径>` 是会话自己的临时目录。唯一可写的 scheme。
 *
 * 光在提示词里给一个路径只是建议，模型得一直记着用它；做成地址就是一个地方，`write scratch://notes.md` 不会一失手落进用户的项目。
 */
export const scratchResource: WritableHandler = {
	scheme: "scratch",
	// i18n-exempt：写进系统提示词、给模型看的。
	describe: "本次会话的临时目录，可读可写（write、edit 都能用），随会话删除一起清掉",

	async resolve(url, scope): Promise<Resource> {
		const target = await scratchTarget(url, scope);
		const content = await readFile(target, "utf8").catch(() => null);
		// i18n-exempt：交给模型的工具结果。
		if (content === null) throw new ResourceError(`临时目录里没有 ${url.path}。`);
		return { url: url.raw, content, contentType: "text/plain", meta: { file: target } };
	},

	async write(url, content, scope): Promise<void> {
		// 先查真实落点再建目录：顺着软链先在外面把目录建出来，查出来也晚了。
		const target = await scratchTarget(url, scope);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	},

	async list(scope): Promise<ResourceEntry[]> {
		const entries = await readdir(scope.scratchDir, { withFileTypes: true }).catch(() => []);
		return entries.filter((e) => e.isFile()).map((e) => ({ value: `scratch://${e.name}` }));
	},

	locate: (url, scope) => scratchTarget(url, scope),
};

/** 一块被折叠掉的输出。 */
interface Artifact {
	id: string;
	/** 哪个工具产生的，用来说清这是什么。 */
	tool: string;
	content: string;
	/** 存下的时刻，列表按它排序。 */
	at: number;
}

/** 每个会话最多留几份：每一份都可能是几十万字符，跑一天的会话不设上限能攒出几百兆。 */
const MAX_ARTIFACTS = 30;

/**
 * 被剪掉的大块输出，按会话存在内存里。
 *
 * 剪枝把巨大的工具结果换成占位标记：三万行日志一直带在上下文里，后面每一轮都在为它付钱。换掉以前等于丢了——模型后来要第
 * 8000 行，只能把命令重跑一遍，而那个命令可能已经不可重现。存下来给个地址，「丢了」就成了「不在手边」。
 */
export class ArtifactStore {
	private readonly sessions = new Map<string, Map<string, Artifact>>();

	/**
	 * 地址按内容取：发给模型的历史每轮都从会话重建（重启之后也是），占位标记里的地址要是换了，发给模型的前缀就从那里断开。
	 * 重复存同一份只是把它挪到最新。超过上限丢最旧的：最近折叠的那几份才是模型可能回头去看的。
	 */
	keep(sessionId: string, tool: string, content: string): string {
		const id = `a${createHash("sha256").update(tool).update("\0").update(content).digest("hex").slice(0, 12)}`;
		let store = this.sessions.get(sessionId);
		if (!store) this.sessions.set(sessionId, (store = new Map()));
		store.delete(id);
		store.set(id, { id, tool, content, at: Date.now() });
		while (store.size > MAX_ARTIFACTS) {
			const oldest = store.keys().next().value;
			if (oldest === undefined) break;
			store.delete(oldest);
		}
		return `artifact://${id}`;
	}

	get(sessionId: string, id: string): Artifact | undefined {
		return this.sessions.get(sessionId)?.get(id);
	}

	list(sessionId: string): Artifact[] {
		return [...(this.sessions.get(sessionId)?.values() ?? [])];
	}

	forget(sessionId: string): void {
		this.sessions.delete(sessionId);
	}
}

/** `artifact://<id>` 是一块被折叠掉的输出，占位标记里写着它的地址。 */
export function artifactResource(store: ArtifactStore): ResourceHandler {
	return {
		scheme: "artifact",
		// i18n-exempt：写进系统提示词、给模型看的。
		describe: "`artifact://<id>` 取回一块被折叠掉的大输出（占位标记里写着它的地址）",

		async resolve(url, scope): Promise<Resource> {
			const id = url.segments.join("/");
			const found = store.get(scope.sessionId, id);
			if (!found) {
				/*
				 * 找不到通常不是打错了，是重开过：折叠下来的内容只在内存里，转录里的占位标记却存进了会话。说清楚这件事，
				 * 比说「没有这个 id」有用：后者会让模型去试别的 id。
				 */
				// i18n-exempt：交给模型的工具结果。
				throw new ResourceError(`取不到 ${id}。折叠下来的内容跟会话一起存在内存里，重开会话后就没有了——需要的话得重新跑一次产生它的命令。`);
			}
			return {
				url: url.raw,
				content: found.content,
				contentType: "text/plain",
				// i18n-exempt：交给模型的工具结果。
				label: `${found.tool} 被折叠掉的完整输出`,
				// i18n-exempt：交给模型的工具结果。
				origin: `${found.tool} 的原始输出`,
				meta: { tool: found.tool, at: found.at },
			};
		},

		async list(scope): Promise<ResourceEntry[]> {
			return (
				store
					.list(scope.sessionId)
					.sort((a, b) => b.at - a.at)
					// i18n-exempt：交给模型的工具结果。
					.map((a) => ({ value: `artifact://${a.id}`, description: `${a.tool} 的输出（${a.content.length} 字符）` }))
			);
		},
	};
}

/** `session://` 要的那一点：列会话、读消息，不连带删会话的能力。 */
export interface SessionLookup {
	list(): Promise<SessionSummary[]>;
	messages(sessionId: string): Promise<Message[]>;
}

/**
 * 一条消息写成一行人读的话。
 *
 * 转录里大多是工具调用，可「上次我们是怎么解决的」要的是说了什么。工具调用留一行名字：全去掉，对话看起来像凭空得出了结论；
 * 把参数和结果都摆出来，读一次别人的会话就花掉这个会话的上下文。
 */
function renderMessage(message: Message): string {
	if (message.role === "toolResult") return "";
	const text = message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();

	// i18n-exempt：交给模型的工具结果。
	if (message.role === "user") return message.synthetic ? "" : `用户：${text}`;

	const calls = message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []));
	// i18n-exempt：交给模型的工具结果。
	const parts = [text && `助手：${text}`, calls.length > 0 && `（调用了 ${calls.join("、")}）`].filter(Boolean);
	return parts.join("\n");
}

/**
 * `session://<id>` 是一整段转录；`session://<id>/<n>` 是第 n 条；`session://` 是最近的几个。
 *
 * 「上次我们是怎么解决这个的」——那件事在另一个会话里，以前只能人自己翻出来复制过来。只读，带 origin：转录里有人说过的每一句话，
 * 包括后来撤回的判断和贴进来的报错，让它作为资料进上下文，而不是作为指令。
 */
export function sessionResource(lookup: SessionLookup): ResourceHandler {
	const transcript = async (id: string): Promise<{ title: string; lines: string[] } | null> => {
		const summary = (await lookup.list()).find((session) => session.id === id);
		if (!summary) return null;
		return { title: summary.title, lines: (await lookup.messages(id)).map(renderMessage).filter(Boolean) };
	};
	return {
		scheme: "session",
		// i18n-exempt：写进系统提示词、给模型看的。
		describe: "`session://` 列出最近的会话；`session://<id>` 是那次对话的完整转录；`session://<id>/<第几条>` 只要其中一条",

		async resolve(url, _scope): Promise<Resource> {
			const [id, nth] = url.segments;
			// i18n-exempt：交给模型的工具结果。
			if (!id) throw new ResourceError("要读哪个会话？`session://` 可以列出最近的几个。");

			const found = await transcript(id);
			// i18n-exempt：交给模型的工具结果。
			if (!found) throw new ResourceError(`没有 id 是“${id}”的会话。用 \`session://\` 看看有哪些。`);

			if (nth !== undefined) {
				/*
				 * 从 1 开始数，`session://x/1` 对得上人读到的「第 1 条」。越界说「一共 N 条」而不是给个空结果：空结果会让模型接着试下一个数字，
				 * 而它要知道的是这里根本没有那么多条。
				 */
				const index = Number(nth);
				if (!Number.isInteger(index) || index < 1 || index > found.lines.length) {
					// i18n-exempt：交给模型的工具结果。
					throw new ResourceError(`会话“${found.title}”一共 ${found.lines.length} 条消息，没有第 ${nth} 条。`);
				}
				return {
					url: url.raw,
					content: found.lines[index - 1]!,
					contentType: "text/plain",
					// i18n-exempt：交给模型的工具结果。
					label: `会话“${found.title}”的第 ${index} 条（共 ${found.lines.length} 条）`,
					// i18n-exempt：交给模型的工具结果。
					origin: "另一次会话的转录",
					meta: { session: id, index },
				};
			}

			return {
				url: url.raw,
				content: found.lines.join("\n\n"),
				contentType: "text/plain",
				// i18n-exempt：交给模型的工具结果。
				label: `会话“${found.title}”的完整转录（${found.lines.length} 条）`,
				// i18n-exempt：交给模型的工具结果。
				origin: "另一次会话的转录",
				meta: { session: id, count: found.lines.length },
			};
		},

		async list(scope): Promise<ResourceEntry[]> {
			/*
			 * 归档的、子会话不列：人在侧栏里找得到的才是「最近的会话」。当前这个也不列：读自己的转录是死循环的开头，读回来的内容进上下文，
			 * 下一轮的转录里又包含了这次读取，而模型看不出这一点。
			 */
			const recent = (await lookup.list())
				.filter((s) => !s.archived && !s.parentId && s.id !== scope.sessionId)
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, 20);
			// i18n-exempt：交给模型的工具结果。
			return recent.map((s) => ({ value: `session://${s.id}`, description: s.title || "（未命名）" }));
		},
	};
}

/**
 * `plugin://<名字>` 是插件的说明；`plugin://<名字>/<路径>` 是它目录里的文件。
 *
 * 装了一个插件却不知道它提供什么，是最常见的一种卡住：说明书就在它自己的目录里，可模型不知道那个目录在哪。
 * 第三方内容，一律带 origin：一份 README 里「先运行这个脚本」毫不起眼，却不该被当成指令执行。
 */
export function pluginResource(plugins: () => InstalledPlugin[]): ResourceHandler {
	return {
		scheme: "plugin",
		// i18n-exempt：写进系统提示词、给模型看的。
		describe: "`plugin://<插件名>` 是这个插件的说明；`plugin://<插件名>/<文件>` 读它目录里的文件",

		async resolve(url, _scope): Promise<Resource> {
			const installed = plugins();
			const [id, ...rest] = url.segments;
			const plugin = installed.find((p) => p.name === id);
			if (!plugin) {
				// i18n-exempt：交给模型的工具结果。
				const known = installed.map((p) => p.name).join("、");
				throw new ResourceError(`没有装叫“${id}”的插件。现在装了：${known || "（一个都没有）"}`);
			}

			if (rest.length === 0) {
				// 说明书优先，清单垫底：问「这个插件是干什么的」，答案在给人读的 README 里；没有它，清单的 description 是唯一能说的话。
				for (const name of ["README.md", "readme.md", "README.markdown"]) {
					const file = resolveInside(plugin.dir, name);
					if (!file) continue;
					// 先查后读：插件目录里指向外面的软链不能从这里绕过去；先读的话，指向外面的命名管道会让读取一直挂着，走不到检查。
					if (!(await stillInside(plugin.dir, file))) {
						// i18n-exempt：交给模型的工具结果。
						throw new ResourceError(`插件“${plugin.name}”的 ${name} 经过软链后指到了插件目录外面。`);
					}
					const text = await readFile(file, "utf8").catch(() => null);
					if (text !== null) {
						return {
							url: url.raw,
							content: text,
							contentType: "text/markdown",
							// i18n-exempt：交给模型的工具结果。
							label: `插件“${plugin.name}”的说明（${name}）`,
							// i18n-exempt：交给模型的工具结果。
							origin: `第三方插件 ${plugin.name}`,
							meta: { plugin: plugin.name, dir: plugin.dir },
						};
					}
				}
				const manifest = await readManifest(plugin.dir);
				return {
					url: url.raw,
					// i18n-exempt：交给模型的工具结果。
					content: [
						`插件：${plugin.name}`,
						manifest.version ? `版本：${manifest.version}` : "",
						manifest.description ? `说明：${manifest.description}` : "（这个插件没有写说明）",
					]
						.filter(Boolean)
						.join("\n"),
					contentType: "text/plain",
					// i18n-exempt：交给模型的工具结果。
					label: `插件“${plugin.name}”的清单信息（它没有 README）`,
					// i18n-exempt：交给模型的工具结果。
					origin: `第三方插件 ${plugin.name}`,
					meta: { plugin: plugin.name, dir: plugin.dir },
				};
			}

			const target = resolveInside(plugin.dir, rest.join("/"));
			// i18n-exempt：交给模型的工具结果。
			if (!target) throw new ResourceError(`\`${url.raw}\` 指到了插件目录外面。`);
			// i18n-exempt：交给模型的工具结果。
			if (!(await stillInside(plugin.dir, target))) throw new ResourceError(`\`${url.raw}\` 经过软链后指到了插件目录外面。`);

			const content = await readFile(target, "utf8").catch(() => null);
			// i18n-exempt：交给模型的工具结果。
			if (content === null) throw new ResourceError(`插件“${plugin.name}”里没有 ${rest.join("/")}。`);
			return {
				url: url.raw,
				content,
				contentType: "text/plain",
				// i18n-exempt：交给模型的工具结果。
				label: `插件“${plugin.name}”里 ${rest.join("/")} 的完整内容`,
				// i18n-exempt：交给模型的工具结果。
				origin: `第三方插件 ${plugin.name}`,
				meta: { plugin: plugin.name, file: target },
			};
		},

		async list(_scope): Promise<ResourceEntry[]> {
			return Promise.all(
				plugins().map(async (p) => {
					const { description } = await readManifest(p.dir);
					return { value: `plugin://${p.name}`, ...(description ? { description } : {}) };
				}),
			);
		},
	};
}

/** `package.json` 里的版本和说明；读不到就是没有。 */
async function readManifest(dir: string): Promise<{ version?: string; description?: string }> {
	try {
		const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { version?: unknown; description?: unknown };
		return {
			...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
			...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
		};
	} catch {
		return {};
	}
}
