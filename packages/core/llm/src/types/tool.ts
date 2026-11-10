/**
 * 模型调用要用的两个工具类型。
 *
 * 工具的执行上下文（沙箱、MCP 表单、资源路由等）属于工具运行时，
 * 不属于模型调用；Plume 的工具接口由 plume.agent 插件自己定义。
 */

/** JSON Schema subset accepted by every provider we target. */
export interface JsonSchema {
	type?: string;
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema | JsonSchema[];
	required?: string[];
	enum?: unknown[];
	description?: string;
	default?: unknown;
	additionalProperties?: boolean | JsonSchema;
	[key: string]: unknown;
}

export interface ToolSpec {
	name: string;
	description: string;
	parameters: JsonSchema;
}
