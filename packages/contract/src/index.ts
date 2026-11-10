/**
 * 共享类型：跨包、跨进程的约定都在这里，只有类型，没有运行时代码。按用途分文件：
 *
 * - `plugin.ts`：插件逻辑入口的 API（钩子、工具、ctx）；界面入口的在 `ui.ts`（`@plume/contract/ui`）；`resources.ts`：服务 `resources` 的资源地址；
 * - `service.ts`：agent 进程给界面的 AgentService、事件和视图；`usage.ts`：存储页和插件读的使用统计数据；
 * - `app.ts`：agent 和装配它的应用之间的约定（待加载的插件、日志）。
 *
 * 消息类型定义在 `@plume/llm`，在这里转出，使用方一律从 `@plume/contract` 引用。
 */

export type {
	ApiFormat,
	AssistantMessage,
	DeliveredReport,
	ImageContent,
	Message,
	MessageAttachment,
	PeerLetter,
	TextContent,
	ToolResultMessage,
	ToolSpec,
	UserContent,
	UserMessage,
} from "@plume/llm/types";
export type { CallContext } from "@plume/rpc";
export type * from "./app.ts";
export type * from "./changes.ts";
export type * from "./diagnostics.ts";
export type * from "./plugin.ts";
export type * from "./resources.ts";
export type * from "./service.ts";
export type * from "./usage.ts";
