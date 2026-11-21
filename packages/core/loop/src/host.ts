import type { HookName, Hooks, HookTrace, RegisteredToolInfo, ToolDefinition } from "@plume/contract";

/** 循环用到的插件宿主能力，由 agent 装配。 */
export interface LoopHost {
	run<N extends HookName>(
		name: N,
		input: Hooks[N][0],
		inner: (input: Hooks[N][0]) => Promise<Hooks[N][1]>,
		options?: {
			settle?: (value: never) => unknown;
			stop?: (input: Hooks[N][0]) => Hooks[N][1] | undefined;
			trace?: (trace: HookTrace) => void;
		},
	): Promise<Hooks[N][1]>;
	tool(name: string): RegisteredTool | undefined;
	toolOwners(): RegisteredToolInfo[];
	sessionContextReset(sessionId: string): void;
}

export interface RegisteredTool {
	definition: ToolDefinition;
	/** 注册它的插件。 */
	plugin: string;
	/** 注册它的插件是内置的：工具表里排在前面，见 `compareTools`。 */
	builtin: boolean;
}
