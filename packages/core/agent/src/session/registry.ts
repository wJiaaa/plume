import { isAbsolute, join, resolve } from "node:path";
import type { AgentEvent, Message, SessionSummary } from "@plume/contract";
import { emptyRecord, settleStaleRuns, type ContextRecord } from "@plume/loop";
import { text } from "../i18n.ts";
import type { SessionDb } from "../session-db.ts";
import { newSession, type Session } from "./session.ts";

export interface RegistryDeps {
	dataDir: string;
	store: Pick<SessionDb, "summaries" | "saveSummary" | "messages" | "context">;
	emit(event: AgentEvent): void;
	/** 回边：插件宿主后建，在 `createAgent` 里接上。 */
	sessionContextReset(sessionId: string): void;
	/** 项目列表在启动清理之后创建，在 `createAgent` 里接上。 */
	projectRoots(cwd: string, project: string | undefined): string[];
}

export interface Registry {
	sessions: Map<string, Session>;
	scratchDir(sessionId: string): string;
	lineageScratchDirs(sessionId: string): string[];
	sessionRoots(summary: SessionSummary): string[];
	summaries(): SessionSummary[];
	rootSession(id: string): string | undefined;
	saveSummary(session: Session): void;
	find(sessionId: string): Session;
	modelOf(session: Session): string | undefined;
	thinkingOf(session: Session): SessionSummary["thinking"];
	withChildren(sessionId: string): string[];
	readMessages(session: Session): Message[];
	messagesOf(session: Session): Promise<Message[]>;
	attachedPaths(session: Session): Promise<string[]>;
	readRecord(session: Session): ContextRecord;
	recordOf(session: Session): Promise<ContextRecord>;
}

export function createRegistry(deps: RegistryDeps): Registry {
	const { dataDir, store, emit, sessionContextReset, projectRoots } = deps;
	/** 会话的临时目录，见 `ModelContext.scratchDir`。按会话 id 分开：两个会话（包括父子）的草稿不会互相踩。 */
	const scratchDir = (sessionId: string) => join(dataDir, "scratch", sessionId);

	const sessions = new Map<string, Session>();
	for (const summary of store.summaries()) {
		sessions.set(summary.id, newSession({ ...summary, running: false }, undefined));
	}

	/**
	 * 和这个会话同一脉的会话，含它自己：沿子会话（`parentId`）、分叉（`forkedFrom`）、建议开出的新会话（`spawnedFrom`）的来处
	 * 连在一起的那些。它们互相交接草稿：子智能体把报告写进父会话的临时目录；分叉、新会话复制或接过来的话里指着来源的临时目录，
	 * 接着用、接着改的就是那几份。两头都算，来源也够得着分叉和新会话的。来处已经删掉的，连线断在那里。
	 *
	 * 每次现算：子会话、分叉随时会多。别的会话不在里面，那是别的对话的草稿。
	 */
	function lineage(sessionId: string): string[] {
		const links = new Map<string, string[]>();
		for (const { summary } of sessions.values()) {
			for (const from of [summary.parentId, summary.forkedFrom?.sessionId, summary.spawnedFrom?.sessionId]) {
				if (!from || !sessions.has(from)) continue;
				links.set(summary.id, [...(links.get(summary.id) ?? []), from]);
				links.set(from, [...(links.get(from) ?? []), summary.id]);
			}
		}
		const found = new Set([sessionId]);
		for (const id of found) for (const next of links.get(id) ?? []) found.add(next);
		return [...found];
	}
	/** 同一脉的会话的临时目录（`ToolRun.scratchDirs`），见 `lineage`。 */
	const lineageScratchDirs = (sessionId: string) => lineage(sessionId).map(scratchDir);

	/**
	 * 界面经文件接口（读、列目录、改名、删、`plume-media`）能碰的、工作目录以外的那些目录：同项目的其他目录，加上同一脉的会话的
	 * 临时目录。和工具侧是同一个范围（`ToolRun.scratchDirs`）：模型写在那里的报告、截断前的全文，回复里就会指着它，界面不认的话
	 * 那些文件签都点不开。
	 *
	 * 这是访问边界，不是搜索范围：`@` 补全和 `locateFiles` 仍只在工作目录和项目目录里找，不然 `tool-output/` 里的日志
	 * 会混进补全和同名候选。
	 */
	const sessionRoots = ({ id, cwd, project }: SessionSummary) => [...projectRoots(cwd, project), ...lineageScratchDirs(id)];

	const summaries = () => [...sessions.values()].map((session) => session.summary).sort((a, b) => b.updatedAt - a.updatedAt);
	/** 使用统计里子会话算作它的顶层会话；已经删掉的会话是 undefined。 */
	const rootSession = (id: string): string | undefined => {
		let session = sessions.get(id);
		while (session?.summary.parentId && sessions.has(session.summary.parentId)) session = sessions.get(session.summary.parentId);
		return session?.summary.id;
	};
	/** 一个会话的摘要变了：告诉界面，写进库。 */
	const saveSummary = (session: Session) => {
		emit({ type: "sessions", sessions: summaries() });
		store.saveSummary(session.summary);
	};

	function find(sessionId: string): Session {
		const session = sessions.get(sessionId);
		if (!session) throw new Error(text("session.notFound", { id: sessionId }));
		return session;
	}

	/** 子会话没另选模型、思考档位时跟着父会话：现取，父会话中途换了模型，子会话下一个请求就跟上。 */
	function modelOf(session: Session): string | undefined {
		return session.summary.model ?? (session.summary.parentId ? sessions.get(session.summary.parentId)?.summary.model : undefined);
	}

	function thinkingOf(session: Session): SessionSummary["thinking"] {
		return session.summary.thinking ?? (session.summary.parentId ? sessions.get(session.summary.parentId)?.summary.thinking : undefined);
	}

	/** 这个会话和挂在它下面的子会话（子会话不再挂子会话，见 `createChild`）。 */
	function withChildren(sessionId: string): string[] {
		return [sessionId, ...[...sessions.values()].filter((session) => session.summary.parentId === sessionId).map((session) => session.summary.id)];
	}

	function readMessages(session: Session): Message[] {
		return session.messages ?? store.messages(session.summary.id);
	}

	async function messagesOf(session: Session): Promise<Message[]> {
		if (!session.messages) {
			session.messages = readMessages(session);
			sessionContextReset(session.summary.id);
		}
		return session.messages;
	}

	/**
	 * 人拖进来的、工作区外也能读的文件（`ToolRun.allowedPaths`）：这个会话和它的上级会话里用户消息附件上的绝对路径。
	 * 子会话（子 Agent、侧边聊天）替父会话办事，人在父会话里给的文件它也读得到。入库时相对路径已经丢掉（见 `userMessage`），
	 * 那种路径会按进程的工作目录补全，补出来的东西谁也没打算授权。
	 */
	async function attachedPaths(session: Session): Promise<string[]> {
		const paths = new Set<string>();
		for (let current: Session | undefined = session; current; current = current.summary.parentId ? sessions.get(current.summary.parentId) : undefined) {
			for (const message of await messagesOf(current)) {
				if (message.role !== "user") continue;
				for (const attachment of message.attachments ?? []) if (attachment.path && isAbsolute(attachment.path)) paths.add(resolve(attachment.path));
			}
		}
		return [...paths];
	}

	function readRecord(session: Session): ContextRecord {
		return session.record ?? settleStaleRuns(store.context(session.summary.id) ?? emptyRecord());
	}

	async function recordOf(session: Session): Promise<ContextRecord> {
		return (session.record ??= readRecord(session));
	}

	return {
		sessions,
		scratchDir,
		lineageScratchDirs,
		sessionRoots,
		summaries,
		rootSession,
		saveSummary,
		find,
		modelOf,
		thinkingOf,
		withChildren,
		readMessages,
		messagesOf,
		attachedPaths,
		readRecord,
		recordOf,
	};
}
