import type { CallContext, SessionMessage, SessionModel, ToolKind } from "@plume/contract";
import type { AgentRecord, AgentSave } from "./definitions.ts";
import type { AgentSettings, Face, ModelChoice, TaskRecord } from "./types.ts";

/**
 * 设置页一次要的全部：`project` 那一层（为空是个人）生效的名单、能挑的工具（和它们声明做的是哪种活：新建时默认勾哪些、
 * 哪些标成能改文件跑命令，按它定）、模型偏好、关掉的种类和模型目录。
 */
export interface AgentCatalog {
	records: AgentRecord[];
	tools: Array<{ name: string; kind?: ToolKind }>;
	choices: AgentSettings;
	disabled: string[];
	models: SessionModel[];
}

export interface SubagentsApi {
	list(parentId: string): TaskRecord[];
	watch(parentId: string, call: CallContext): AsyncGenerator<TaskRecord[], void>;
	stop(sessionId: string): void;
	steer(sessionId: string, message: SessionMessage): Promise<void>;
	/** 父会话目录下的名单里每个人写明的脸：面板和输入框上方那条按它排脸，和设置页是同一批人、同一张脸。 */
	faces(parentId: string): Promise<Face[]>;
	catalog(project: string | null): Promise<AgentCatalog>;
	/** 编辑前现读一份，拿到最新的修订号。 */
	read(project: string | null, id: string): Promise<AgentRecord>;
	save(project: string | null, input: AgentSave): Promise<void>;
	remove(project: string | null, id: string, revision: string): Promise<void>;
	setModel(agent: string, choice: ModelChoice): Promise<void>;
	setEnabled(agent: string, enabled: boolean): void;
}
