/**
 * 一次提问的形状和两头的校验，逻辑入口和界面入口共用（不引用 Node 的东西）。
 *
 * 问题是 `run.request` 的 `payload`，送到界面画成提问卡；人的回答从 `run.request` 回到逻辑入口，在那里再对一遍：界面里的检查
 * 拦得住手误，拦不住一个不照着问题答的客户端。
 */

export const ASK_USER = "ask_user";

interface QuestionOption {
	label: string;
	description?: string;
	recommended?: boolean;
}

/** 卡片要画的一个问题。 */
export interface Question {
	question: string;
	options: (string | QuestionOption)[];
	selectionMode: "single" | "multi";
	allowCustomInput: boolean;
	allowSkip: boolean;
	/** 跳过时采用的那一项：只有明确给了才有，推荐不等于默认。 */
	defaultOptionIndex?: number;
}

/** 人在卡上的回答：选了（或写了）什么，或者跳过。 */
export type QuestionReply = { answer: string | string[] } | { skip: true };

/** 校验好的回答：`skipped` 时 `answer` 是跳过所采用的默认项，没有默认项就没有 `answer`。 */
export type CheckedReply = { answer: string | string[]; skipped?: true } | { skipped: true };

const labelOf = (option: string | QuestionOption): string => (typeof option === "string" ? option : option.label);

function validOption(value: unknown): value is string | QuestionOption {
	if (typeof value === "string") return Boolean(value.trim());
	if (typeof value !== "object" || value === null) return false;
	const { label, description, recommended } = value as Record<string, unknown>;
	return (
		typeof label === "string" &&
		Boolean(label.trim()) &&
		(description === undefined || typeof description === "string") &&
		(recommended === undefined || typeof recommended === "boolean")
	);
}

/** 模型给的参数读成一个问题；不成立时是交给模型的那句话。 */
// i18n-exempt：参数错误是交给模型的工具结果。
export function readArgs(args: Record<string, unknown>): Question | string {
	const { question, options, selectionMode, allowCustomInput, allowSkip, defaultOptionIndex } = args;
	if (typeof question !== "string" || !question.trim() || !Array.isArray(options) || !options.every(validOption))
		return "Provide a question and choices with nonempty labels.";
	const choices = options.map((option) => (typeof option === "string" ? option.trim() : { ...option, label: option.label.trim() }));
	const labels = choices.map(labelOf);
	if ((!choices.length && allowCustomInput === false) || new Set(labels).size !== labels.length) return "Provide distinct choices, or enable custom input.";
	if (selectionMode !== undefined && selectionMode !== "single" && selectionMode !== "multi") return "selectionMode must be single or multi.";
	if (
		defaultOptionIndex !== undefined &&
		(typeof defaultOptionIndex !== "number" || !Number.isInteger(defaultOptionIndex) || defaultOptionIndex < 0 || defaultOptionIndex >= choices.length)
	)
		return "defaultOptionIndex must identify an existing choice.";
	return {
		question: question.trim(),
		options: choices,
		selectionMode: selectionMode ?? "single",
		allowCustomInput: allowCustomInput !== false,
		allowSkip: allowSkip !== false,
		...(defaultOptionIndex !== undefined ? { defaultOptionIndex } : {}),
	};
}

/** 卡片 `payload` 里的问题；认不出（不是这个插件问的、坏了）时是 undefined。 */
export function readQuestion(payload: unknown): Question | undefined {
	const value = (typeof payload === "object" ? payload : null) as Partial<Question> | null;
	if (
		!value ||
		typeof value.question !== "string" ||
		!Array.isArray(value.options) ||
		!value.options.every(validOption) ||
		(value.selectionMode !== "single" && value.selectionMode !== "multi") ||
		typeof value.allowCustomInput !== "boolean" ||
		typeof value.allowSkip !== "boolean" ||
		(value.defaultOptionIndex !== undefined && (typeof value.defaultOptionIndex !== "number" || !value.options[value.defaultOptionIndex]))
	)
		return undefined;
	return value as Question;
}

/**
 * 对着问题核一遍人的回答，对不上时是 undefined。跳过只在允许跳过时成立，有默认项就采用它；选的都要去掉首尾空白、不空、
 * 不重复，多个只在多选时成立，不许自填时只能是选项里的。
 */
export function checkReply(question: Question, reply: unknown): CheckedReply | undefined {
	if (typeof reply !== "object" || reply === null) return undefined;
	const labels = question.options.map(labelOf);
	if ("skip" in reply) {
		if (reply.skip !== true || !question.allowSkip) return undefined;
		const fallback = question.defaultOptionIndex !== undefined ? labels[question.defaultOptionIndex] : undefined;
		return fallback === undefined ? { skipped: true } : { answer: fallback, skipped: true };
	}
	if (!("answer" in reply)) return undefined;
	const value = reply.answer;
	if (typeof value !== "string" && (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string"))) return undefined;
	if (Array.isArray(value) && question.selectionMode !== "multi") return undefined;
	const answers = (typeof value === "string" ? [value] : (value as string[])).map((item) => item.trim());
	if (!answers.length || new Set(answers).size !== answers.length) return undefined;
	if (answers.some((answer) => !answer || (!question.allowCustomInput && !labels.includes(answer)))) return undefined;
	return { answer: typeof value === "string" ? answers[0]! : answers };
}
