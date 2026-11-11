/**
 * 子智能体怎么交差：`yield` 的参数就是定义里写的输出结构（`output`），交回来的是一个校验过的对象，而不是父会话还得
 * 从一段话里再读一遍的路径和结论。调了 `yield` 就是交差，没调就不是——「做完没有」不再靠猜那段话像不像结论。
 *
 * 没写输出结构的种类做完了照样用正文回答；它们挂的是交接用的那一份（`HANDOFF_SCHEMA`），只在停在检查点时
 * 讨一次（`checkpoint.ts`），让停在半路的子智能体交回做到了哪、还剩什么，而不是停下前随口说的最后一句。
 */

/** 定义里能写的那一小撮 JSON Schema：类型、`required`、`properties`、`items`、`enum`。 */
export interface JsonSchema {
	type?: string;
	description?: string;
	required?: string[];
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema | JsonSchema[];
	enum?: unknown[];
	[key: string]: unknown;
}

export type SchemaMode = "permissive" | "strict";

/** 校验过（或用完重试后照收）的交付；`warnings` 是照收下来的不合格之处，干净的是空的。 */
export interface YieldOutcome {
	value: Record<string, unknown>;
	warnings: string[];
}

/** 校验不过时退回重试，第三次还不过按定义的 `schemaMode` 收场：一个写坏的结构不该把整轮都耗在跟校验器较劲上。 */
const MAX_YIELD_ATTEMPTS = 3;

// i18n-exempt：下面是发给模型的工具说明和参数说明。
export const YIELD_DESCRIPTION =
	"Submit your finished result when the task is done. This is the ONLY way the work reaches whoever dispatched you — " +
	"anything you write outside this call is not delivered. Fill in every required field.";

/**
 * 交接用的 `yield` 怎么介绍自己：没有输出结构的子智能体做完了就是用正文回答，所以不能用上面那句「做完必须调用」，
 * 否则每一次正常收尾都变成一份 summary / remaining 的交接。
 */
// i18n-exempt：发给模型的工具说明。
export const HANDOFF_DESCRIPTION =
	"Hand over unfinished work to whoever dispatched you. Call this only when you are told you have reached a checkpoint; " +
	"calling it ends your run. When you finish the task, answer in plain text instead — that is how a finished answer is delivered.";

/** 三个字段对着续跑的人要问的三件事：已经知道了什么、还差什么、打算怎么干。 */
// i18n-exempt：发给模型的参数说明。
export const HANDOFF_SCHEMA: JsonSchema = {
	type: "object",
	required: ["summary", "remaining"],
	properties: {
		summary: { type: "string", description: "已经做完了什么、查到的关键事实——带上 `path:line`，接手的人不用再查一遍。" },
		remaining: { type: "string", description: "还没做完的部分，以及卡在哪。" },
		next: { type: "string", description: "你打算接下来怎么做——接着跑的时候照这个走。" },
	},
};

/**
 * 按定义能写的那几个关键字查一遍结构。认不得的关键字一律放过：一个不认识的关键字不该变成对一份写对了的结果的拒绝。
 */
// i18n-exempt：校验失败的说明是发给模型的工具结果。
function validateAgainstSchema(value: unknown, schema: JsonSchema, path = ""): string[] {
	const where = path || "结果";
	const errors: string[] = [];
	if (schema.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${where} 应该是一个对象，实际是 ${describe(value)}。`];
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in record) || record[key] === undefined) errors.push(`${where} 缺少必需的字段 \`${key}\`。`);
		}
		for (const [key, sub] of Object.entries(schema.properties ?? {})) {
			if (key in record && record[key] !== undefined) errors.push(...validateAgainstSchema(record[key], sub, path ? `${path}.${key}` : key));
		}
		return errors;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value)) return [`${where} 应该是一个数组，实际是 ${describe(value)}。`];
		const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
		if (items) value.forEach((entry, index) => errors.push(...validateAgainstSchema(entry, items, `${path}[${index}]`)));
		return errors;
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		return [`${where} 只能是 ${schema.enum.map((entry) => JSON.stringify(entry)).join("、")} 之一，实际是 ${JSON.stringify(value)}。`];
	}
	if (schema.type === "string" && typeof value !== "string") return [`${where} 应该是字符串，实际是 ${describe(value)}。`];
	if (schema.type === "number" || schema.type === "integer") {
		if (typeof value !== "number") return [`${where} 应该是数字，实际是 ${describe(value)}。`];
		if (schema.type === "integer" && !Number.isInteger(value)) return [`${where} 应该是整数，实际是 ${value}。`];
	}
	if (schema.type === "boolean" && typeof value !== "boolean") return [`${where} 应该是布尔值，实际是 ${describe(value)}。`];
	return errors;
}

// i18n-exempt：发给模型的类型名。
function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "数组";
	return typeof value;
}

/** 这一次调用 `yield` 的结论：要不要收下、交给模型的那句话、要不要就此结束这一轮。 */
export interface YieldVerdict {
	accepted?: YieldOutcome;
	output: string;
	isError?: true;
	terminate?: true;
}

/**
 * 判一次 `yield`。`attempt` 从 1 数，每次派发、续跑重新数：用完了重试的那一次不该把空了的额度留给下一次。
 *
 * 校验不过的作为工具错误退回，点名哪个字段——「缺少 summary」是一行就能改好的事。用完重试后 `permissive`（默认）照收
 * 并带上不合格之处：九成对的结果比没有结果有用，带着警告是为了父会话别把缺了字段的对象当成完整的。`strict` 不收。
 */
// i18n-exempt：发给模型的工具结果。
export function judgeYield(args: Record<string, unknown>, schema: JsonSchema, mode: SchemaMode | undefined, attempt: number): YieldVerdict {
	const errors = validateAgainstSchema(args, schema);
	if (errors.length === 0) {
		const accepted = { value: args, warnings: [] };
		// 交了个空壳（校验只问字段在不在、类型对不对，不问填没填）时不结束：留着这一轮，它还能用正文说点什么。
		return { accepted, output: "结果已提交。", ...(renderYield(accepted) ? { terminate: true as const } : {}) };
	}
	const list = errors.map((error) => `- ${error}`).join("\n");
	if (attempt < MAX_YIELD_ATTEMPTS) return { output: `结果不符合要求，没有提交。请修正后重新调用 \`yield\`：\n${list}`, isError: true };
	if (mode === "strict") return { output: `结果连续 ${MAX_YIELD_ATTEMPTS} 次不符合要求，这次派生失败：\n${list}`, isError: true };
	return { accepted: { value: args, warnings: errors }, output: `结果已提交，但有 ${errors.length} 处不符合要求，已按原样接受。`, terminate: true };
}

/** 有输出结构时接在子智能体提示词后面的一段：做完了写成正文、不调 `yield`，就什么都没交。 */
// i18n-exempt：发给模型的提示词。
export function yieldInstruction(schema: JsonSchema): string {
	const required = schema.required ?? [];
	return [
		"## 交付",
		"",
		"做完之后**必须调用 `yield`** 提交结果。它是你唯一的交付方式——不调用 `yield` 的回复，派你来的人看不到。",
		required.length > 0 ? `必填字段：${required.map((name) => `\`${name}\``).join("、")}。` : "",
		"字段的含义看 `yield` 的参数说明。填不出来的字段就如实说明，不要编。",
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * 停在检查点时对子智能体说的那句：接下来两步只有 `yield` 能执行。「不完整也要交」是要紧的那半句——知道自己
 * 没时间了的模型，不这么说就会道个歉什么都不交；「上下文会留着」让它把下一步写成能照着走的样子。
 */
// i18n-exempt：发给模型的话。
export function finalDemand(rounds: number): string {
	return (
		`（自动追加）到检查点了：这一段的 ${rounds} 轮已经用完，这一轮只能调用 \`yield\`，别的工具都会被拒绝。` +
		"按它的字段把目前的进展交上去：做完了什么、查到的关键事实（带 `path:line`）、还剩什么没做、下一步打算怎么做——" +
		"没有对应字段的写进 `summary`。不完整也要交。" +
		"你的上下文会原样留着，派你来的人可能让你从这里接着做。不调用 `yield`，他就什么都拿不到。"
	);
}

/** 讨交接那两步里调别的工具得到的话。 */
// i18n-exempt：发给模型的工具结果。
export function yieldOnly(tool: string): string {
	return `到检查点了，这一轮不能再调用 \`${tool}\`。现在只能调用 \`yield\`，把目前的进展交上去。`;
}

/**
 * 交回的对象写成一段人和模型都读得下去的字：`summary` 打头（这就是派它去的目的），`report` 收尾（它最长），
 * 中间每个字段一段，记录压成一行。界面另按结构画卡片，这一份是交给父会话、复制出去的那一份。
 */
// i18n-exempt：交给父会话的正文。
export function renderYield(outcome: YieldOutcome): string {
	const { value, warnings } = outcome;
	const lines: string[] = [];
	if (typeof value.summary === "string") lines.push(value.summary.trim());
	for (const [key, entry] of Object.entries(value)) {
		if (key === "summary" || key === "report" || entry === undefined || entry === null) continue;
		if (Array.isArray(entry)) {
			if (entry.length === 0) continue;
			lines.push("", `**${key}**`);
			for (const item of entry)
				lines.push(typeof item === "object" && item !== null ? `- ${objectLine(item as Record<string, unknown>)}` : `- ${String(item)}`);
			continue;
		}
		if (typeof entry === "object") continue;
		lines.push("", `**${key}**: ${String(entry)}`);
	}
	if (typeof value.report === "string" && value.report.trim()) lines.push("", value.report.trim());
	if (warnings.length > 0) lines.push("", `⚠ 这个结果有 ${warnings.length} 处不符合约定的格式：`, ...warnings.map((warning) => `- ${warning}`));
	return lines.join("\n").trim();
}

function objectLine(item: Record<string, unknown>): string {
	const entries = Object.entries(item).filter(([, value]) => value !== undefined && value !== null);
	const head = entries.find(([key]) => key === "path" || key === "name" || key === "title");
	const rest = entries.filter(([key, value]) => key !== head?.[0] && typeof value !== "object");
	// i18n-exempt：交给父会话的正文里的分隔符。
	const tail = rest.map(([key, value]) => `${key}: ${String(value)}`).join("，");
	return head ? `\`${String(head[1])}\`${tail ? ` — ${tail}` : ""}` : tail;
}

/**
 * 一轮没把活干完时，写在交回正文最前面的一句：先于结论读到，部分发现才不会被当成结论。写给要决定续跑、接手还是
 * 带着半份答案往下走的父会话；每一句都说清原因和还剩什么，并提醒上下文还在、可以接着跑，不必重派。
 */
// i18n-exempt：交给父会话的正文。
export function incompleteNote(reason: string, error: string | undefined, salvaged: boolean, rounds: number): string | undefined {
	if (reason === "max_turns") {
		return salvaged
			? `⚠ 到了检查点（这一段 ${rounds} 轮），它还没做完。下面是它交的阶段性交接，不是完整结论。它的上下文都还留着，可以接着跑。`
			: `⚠ 到了检查点（这一段 ${rounds} 轮），它还没做完，也没交出交接，下面是它停下前最后说的话。它的上下文都还留着，可以接着跑。`;
	}
	if (reason === "stalled")
		return "⚠ 它反复用同样的参数调同一个工具、每次拿到的结果都一样，已经停下。下面是它停下前最后说的话，不是完整结论。它的上下文还留着，可以换个方向让它接着跑。";
	if (reason === "error")
		return `⚠ 模型服务出错，这次派发没跑完${error ? `：${error}` : ""}。下面是它中断前最后说的话，不是完整结论。它的上下文还留着，服务恢复后可以让它接着跑，不必重派。`;
	return undefined;
}
