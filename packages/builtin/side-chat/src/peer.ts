/**
 * 侧边聊天向同项目 / 同 Git 仓库内的其他顶层会话直接发单向消息（`send_to_session`）。
 *
 * 走本体寄信原语（`ToolRun.letter`）：收件方会看到来自侧边聊天的提示行（不构成用户授权）、遵守收件方的暂停与防打转上限。
 * 收件方是这段侧边聊天开出、每轮交回这里的会话时，说明换成「答在收尾回复里」：它那一轮的结果随交回送到侧边聊天。
 * 作用范围限在同项目或同 Git 仓库（含工作树与子目录）内，与普通目录相邻的会话互不可写；要发给当前挂载的主会话仍走 `dispatch_task`。
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { Locale, SessionSummary, ToolDefinition, ToolOutput } from "@plume/contract";
import { gitEnv, gitFile } from "@plume/platform";
import type { SentToSessionDetails } from "./controls.ts";
import { MESSAGES } from "./messages.ts";

const execFileAsync = promisify(execFile);

/** `rev-parse` 只读目录位置，不读对象、不读 index；同时关掉惰性拉取，免得因配置触发连网。 */
const METADATA_GIT_ENV = { ...gitEnv(process.env), GIT_NO_LAZY_FETCH: "1" };
const GIT_TIMEOUT_MS = 3_000;
const MAX_MESSAGE_CHARS = 20_000;

/** 容忍模型把引用的 `session://<id>`（或带片段）原样传入 `session_id`。 */
export function normalizeSessionId(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("session://")) return trimmed;
	const rest = trimmed.slice("session://".length).split("/")[0] ?? "";
	try {
		return decodeURIComponent(rest).trim();
	} catch {
		return rest.trim();
	}
}

/** 返回目录所在 Git 仓库的共享 `.git` 目录（规范化后的绝对路径），不在 Git 仓库内时返回 null。 */
export async function gitCommonDir(cwd: string): Promise<string | null> {
	if (!cwd) return null;
	try {
		const { stdout } = await execFileAsync(gitFile(), ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd,
			env: METADATA_GIT_ENV,
			timeout: GIT_TIMEOUT_MS,
			windowsHide: true,
		});
		const dir = stdout.trim();
		if (!dir) return null;
		return await realpath(dir).catch(() => dir);
	} catch {
		return null;
	}
}

/** 判断两个顶层会话是否属于同一项目，或在同一 Git 仓库（含其工作树与子目录）内。 */
export async function sameProjectOrRepo(
	parent: Pick<SessionSummary, "project" | "cwd">,
	target: Pick<SessionSummary, "project" | "cwd">,
	commonDirOf: (cwd: string) => Promise<string | null> = gitCommonDir,
): Promise<boolean> {
	if (parent.project && target.project && parent.project === target.project) return true;
	const [parentRepo, targetRepo] = await Promise.all([commonDirOf(parent.cwd), commonDirOf(target.cwd)]);
	return Boolean(parentRepo && targetRepo && parentRepo === targetRepo);
}

export interface SendToSessionDeps {
	parentOf(sideId: string): string | undefined;
	getSession(sessionId: string): Promise<SessionSummary | undefined>;
	locale(): Locale;
	commonDirOf?: (cwd: string) => Promise<string | null>;
}

// i18n-exempt：工具说明、参数、给模型的说明和结果都是发给模型的。
const NOT_HERE: ToolOutput = { output: "send_to_session only works in a side chat.", isError: true };

// i18n-exempt：附加在收件方抬头后的单向说明。
const ONE_WAY_GUIDE = "（这条消息来自侧边聊天，是单向转交，对方无法接收回信，请勿尝试回复给侧边聊天。）";

// i18n-exempt：收件方是这段侧边聊天开出、每轮交回这里的会话时的说明：答案随交回送到，不用回信。
const REPORTED_GUIDE = "（这条消息来自开出你的侧边聊天。你这一轮收尾那段回复会交回侧边聊天：结果和要问的都写在收尾回复里，不用、也没法给侧边聊天回信。）";

// i18n-exempt：工具说明、参数和返回给模型的回执都是模型看的，不经界面展示。
export function createSendToSession(deps: SendToSessionDeps): ToolDefinition {
	return {
		name: "send_to_session",
		description:
			"向同项目或同 Git 仓库内的另一个已有顶层会话直接发送一条单向消息（不弹确认卡）。" +
			"只在用户明确要求把内容发给另一个已有会话时调用；用户仅引用会话作参考时不要擅自发送。" +
			"要交给当前挂载的主会话，请使用 dispatch_task 而不是这个工具。" +
			"session_id 可从用户引用的 session://<id> 或读取 session:// 获取；message 必须完整、独立——对方看不到侧边聊天的上下文。",
		parameters: {
			type: "object",
			properties: {
				session_id: { type: "string", description: "目标顶层会话的 id（可传 session://<id> 或纯 id）。" },
				message: { type: "string", description: "要发送的完整消息正文（不超过 20000 字），自成一体、不依赖侧边聊天上下文。" },
			},
			required: ["session_id", "message"],
		},
		async execute(args, run) {
			const parentId = deps.parentOf(run.sessionId);
			if (!parentId || !run.letter) return NOT_HERE;
			const targetId = typeof args.session_id === "string" ? normalizeSessionId(args.session_id) : "";
			if (!targetId) return { output: "缺少目标会话 id（session_id）。", isError: true };
			const message = typeof args.message === "string" ? args.message.trim() : "";
			if (!message) return { output: "消息内容不能为空。", isError: true };
			if (message.length > MAX_MESSAGE_CHARS)
				return { output: `消息过长（${message.length} 字），最多允许 ${MAX_MESSAGE_CHARS} 字；请精简或写入文件后附路径。`, isError: true };
			if (targetId === parentId) return { output: "目标会话就是当前挂载的主会话，请改用 dispatch_task。", isError: true };
			const [parent, target] = await Promise.all([deps.getSession(parentId), deps.getSession(targetId)]);
			if (!parent) return { output: "当前关联的主会话已不存在，无法发送。", isError: true };
			if (!target) return { output: `找不到 id 为“${targetId}”的会话。`, isError: true };
			if (target.kind !== "top") return { output: "只能向顶层会话发送消息，不能发给子会话或独立会话。", isError: true };
			if (target.archived) return { output: `目标会话「${target.title || target.id}」已归档，无法发送消息。`, isError: true };
			const allowed = await sameProjectOrRepo(parent, target, deps.commonDirOf);
			if (!allowed)
				return {
					output: `目标会话「${target.title || target.id}」不在当前主会话所属的项目或同一个 Git 仓库内，不能直接发送消息。`,
					isError: true,
				};
			const from = MESSAGES[deps.locale()].letterFrom(parent.title);
			// 这段侧边聊天开出、要了交回的会话：它每做完一轮，本体把结果交回这里（见 index.ts 的 `launch`）。
			const reported = target.spawnedFrom?.callIn === run.sessionId && target.spawnedFrom.reportBack === true;
			const receipt = run.letter(target.id, { from, text: message, guide: reported ? REPORTED_GUIDE : ONE_WAY_GUIDE });
			const label = target.title || target.id;
			const back = reported ? "它这一轮做完会把结果交回这里。" : "";
			const details: SentToSessionDetails = { kind: "sent_to_session", sessionId: target.id, title: label };
			if (receipt.held) {
				return {
					output: `消息已投递给「${label}」，但该会话当前已暂停或已达自动唤醒上限，不会立即开跑；消息会在用户下次在该会话开口时读到。${back}`,
					details,
				};
			}
			if (receipt.queued) {
				return {
					output: `消息已投递给「${label}」；对方当前正在执行，会在完成手上这一步后读到。${back}`,
					details,
				};
			}
			return {
				output: `消息已发送给「${label}」，对方当前空闲，已开始处理。${back}`,
				details,
			};
		},
	};
}
