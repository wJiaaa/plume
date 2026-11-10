/**
 * MCP 服务中途要人填的表（elicitation）：把服务给的 JSON Schema 读成一列字段，人填的值交回去之前再按字段核一遍。
 * 规范只许平铺的一层：字符串（可带选项、格式、长度）、数字、整数、布尔。别的形状认不出，原样报给服务，不瞎画一张表。
 * 两个入口共用（这里不能引用 Node 的模块）。
 */

type FieldType = "string" | "number" | "integer" | "boolean";

export interface FormField {
	name: string;
	label: string;
	description?: string;
	required: boolean;
	type: FieldType;
	options?: { value: string; label: string }[];
	format?: "email" | "uri" | "date" | "date-time";
	minLength?: number;
	maxLength?: number;
	minimum?: number;
	maximum?: number;
	default?: string | number | boolean;
}

type FormValue = string | number | boolean;
export type FormValues = Record<string, FormValue>;
export type FormProblem = "required" | "type" | "option" | "format" | "minLength" | "maxLength" | "minimum" | "maximum";

/** 卡片交回来的回答：填好提交、明说不给、没做决定就关了。三种对应协议的 accept、decline、cancel，服务据此决定放弃还是过会儿再问。 */
export type FormAnswer = { action: "accept"; values: FormValues } | { action: "decline" } | { action: "cancel" };

/** 审批卡 `detail` 里的那份：卡片按它画表，交回答时带上 `form`。 */
export interface FormRequest {
	form: string;
	message: string;
	fields: FormField[];
}

/** 审批卡的 `kind`：界面入口按它认出这是一张表。 */
export const FORM_KIND = "mcp-form";

export class UnsupportedFormError extends Error {}

const FORMATS = new Set(["email", "uri", "date", "date-time"]);

export function formFields(schema: unknown): FormField[] {
	const root = record(schema);
	if (!root || root.type !== "object") throw new UnsupportedFormError("requestedSchema must be an object schema");
	const properties = record(root.properties) ?? {};
	const required = Array.isArray(root.required) ? root.required.filter((name): name is string => typeof name === "string") : [];
	return Object.entries(properties).map(([name, raw]) => field(name, raw, required.includes(name)));
}

function field(name: string, raw: unknown, required: boolean): FormField {
	const schema = record(raw);
	if (!schema) throw new UnsupportedFormError(`field "${name}" has no schema`);
	const base = {
		name,
		label: typeof schema.title === "string" && schema.title ? schema.title : name,
		...(typeof schema.description === "string" && schema.description ? { description: schema.description } : {}),
		required,
	};
	if (schema.type === "boolean") return { ...base, type: "boolean", ...(typeof schema.default === "boolean" ? { default: schema.default } : {}) };
	if (schema.type === "number" || schema.type === "integer") {
		return {
			...base,
			type: schema.type,
			...numberProp(schema, "minimum"),
			...numberProp(schema, "maximum"),
			...(typeof schema.default === "number" ? { default: schema.default } : {}),
		};
	}
	if (schema.type !== "string") throw new UnsupportedFormError(`field "${name}" has unsupported type ${JSON.stringify(schema.type)}`);
	const options = choices(name, schema);
	return {
		...base,
		type: "string",
		...(options ? { options } : {}),
		...(!options && typeof schema.format === "string" && FORMATS.has(schema.format) ? { format: schema.format as FormField["format"] } : {}),
		...(!options ? { ...numberProp(schema, "minLength"), ...numberProp(schema, "maxLength") } : {}),
		...(typeof schema.default === "string" ? { default: schema.default } : {}),
	};
}

/** 选项有两种写法：`enum`（可配 `enumNames`）和 `oneOf` 一列 `{ const, title }`。 */
function choices(name: string, schema: Record<string, unknown>): FormField["options"] | undefined {
	if (Array.isArray(schema.enum)) {
		const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
		return schema.enum.map((value, index) => {
			if (typeof value !== "string") throw new UnsupportedFormError(`field "${name}" has a non-string option`);
			const label = names[index];
			return { value, label: typeof label === "string" && label ? label : value };
		});
	}
	if (Array.isArray(schema.oneOf)) {
		return schema.oneOf.map((entry) => {
			const option = record(entry);
			if (!option || typeof option.const !== "string") throw new UnsupportedFormError(`field "${name}" has an option without a string const`);
			return { value: option.const, label: typeof option.title === "string" && option.title ? option.title : option.const };
		});
	}
	return undefined;
}

/** 表刚弹出来时的值：服务给的默认值，布尔的默认不勾。 */
export function initialValues(fields: readonly FormField[]): Partial<FormValues> {
	const values: Partial<FormValues> = {};
	for (const one of fields) {
		if (one.default !== undefined) values[one.name] = one.default;
		else if (one.type === "boolean") values[one.name] = false;
	}
	return values;
}

/** 按字段核对人填的值：卡片提交前核一遍（逐项说哪里不对），逻辑入口收到时再核一遍（渲染进程交来的不直接信）。 */
export function checkFormValues(
	fields: readonly FormField[],
	raw: unknown,
): { ok: true; values: FormValues } | { ok: false; problems: Record<string, FormProblem> } {
	const given = record(raw) ?? {};
	const values: FormValues = {};
	const problems: Record<string, FormProblem> = {};
	for (const one of fields) {
		const value = given[one.name];
		if (value === undefined || value === null || value === "") {
			if (one.required) problems[one.name] = "required";
			continue;
		}
		const problem = problemOf(one, value);
		if (problem) problems[one.name] = problem;
		else values[one.name] = value as FormValue;
	}
	return Object.keys(problems).length > 0 ? { ok: false, problems } : { ok: true, values };
}

function problemOf(one: FormField, value: unknown): FormProblem | null {
	if (one.type === "boolean") return typeof value === "boolean" ? null : "type";
	if (one.type === "number" || one.type === "integer") {
		if (typeof value !== "number" || !Number.isFinite(value) || (one.type === "integer" && !Number.isInteger(value))) return "type";
		if (one.minimum !== undefined && value < one.minimum) return "minimum";
		if (one.maximum !== undefined && value > one.maximum) return "maximum";
		return null;
	}
	if (typeof value !== "string") return "type";
	if (one.options) return one.options.some((option) => option.value === value) ? null : "option";
	const length = [...value].length;
	if (one.minLength !== undefined && length < one.minLength) return "minLength";
	if (one.maxLength !== undefined && length > one.maxLength) return "maxLength";
	if (one.format && !formatOk(one.format, value)) return "format";
	return null;
}

function formatOk(format: NonNullable<FormField["format"]>, value: string): boolean {
	if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
	if (format === "uri") return /^[a-z][a-z0-9+.-]*:\S+$/i.test(value);
	if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** 审批卡 `detail` 读回来；不是这个插件写的就是 null，卡片让给通用卡。 */
export function readFormRequest(detail: string): FormRequest | null {
	try {
		const parsed = record(JSON.parse(detail));
		if (!parsed || typeof parsed.form !== "string" || typeof parsed.message !== "string" || !Array.isArray(parsed.fields)) return null;
		return parsed as unknown as FormRequest;
	} catch {
		return null;
	}
}

function numberProp<K extends "minimum" | "maximum" | "minLength" | "maxLength">(schema: Record<string, unknown>, key: K): Partial<Record<K, number>> {
	const value = schema[key];
	return typeof value === "number" && Number.isFinite(value) ? ({ [key]: value } as Partial<Record<K, number>>) : {};
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
