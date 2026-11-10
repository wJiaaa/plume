/**
 * 工具名在流进来、发出去两头的规整。三条链共用，各自的 adapter / encoder 只调这里。
 *
 * 模型给的名字不一定合规：空的、两头带空白的，gpt-oss 经 vLLM 还会给出 `read<|channel|>commentary`。
 * 工具找不到不要紧——那一轮照常以「工具不存在」收场；要紧的是那次调用留在了历史里，而两种 OpenAI 格式
 * 对 `function.name` 要求 `^[a-zA-Z0-9_-]+$` 且非空，原样回放就是之后每一轮 400，没有学习器认领，会话报废。
 */

/** 流里收到的工具名：两头的空白去掉。别的不动——名字认不认得是执行那一层的事（`agent/tool-args.ts`）。 */
export function toolNameFromStream(raw: unknown): string {
	return typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
}

/** 三种格式里最窄的那条：OpenAI 的 `function.name`，Anthropic 的工具名也是这个字符集、这个长度。 */
const WIRE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 回放历史里一次工具调用时发的名字。
 *
 * 合规的名字原样返回，一个字节都不动——这在每一轮的整段历史上跑一遍，改动合规的名字会让提示缓存作废。
 * 不合规的逐字符替换而不是换成固定占位：`read__channel__commentary` 比 `unknown_tool` 更能让模型看出自己
 * 上次叫错了什么。只改名字不改 id，调用和结果的配对不受影响；名字也不参与配对（三种格式的结果都只带 id）。
 */
export function toolNameForReplay(name: string): string {
	if (WIRE_TOOL_NAME.test(name)) return name;
	const safe = name.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	return safe || "unknown_tool";
}
