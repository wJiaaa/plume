/**
 * 按工具声明的 `parameters`（JSON Schema）整理、检查模型给的参数，工具拿到的参数类型都对得上，不用每件工具各写一遍 `typeof`。
 *
 * 只看给了的顶层属性的简单写法：属性的 `type`（一个或几个）、`enum`。`anyOf`、`oneOf`、`$ref` 这些组合写法、嵌套对象里面
 * 不查，交给工具自己（MCP 服务的工具由服务自己校验）；没声明的属性不管。`required` 不查，缺了必填的不拦：
 * 有的工具缺了有退路（bash 没给 `description` 就用命令的第一行），拦下就是让模型白重来一次；缺不缺得起由工具自己说。
 *
 * 整理（`coerceArgs`，在回复写进会话之前，和别名一起）只做模型常犯、意思又不含糊的几种：数字、布尔写成了字符串（`"10"`、`"true"`）
 * 或反过来，数组、对象写成了 JSON 字符串，类型里没有 `null` 的参数给了 `null`（当没给）。整理之后还对不上的（`argumentProblems`）判这次调用失败、不执行，
 * 告诉模型哪一项错了，让它改了再调。
 */

type Schema = Record<string, unknown>;

const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

/** 属性声明的类型；没写、写了认不出的、用组合写法的是 undefined（不查）。 */
function typesOf(schema: unknown): string[] | undefined {
	if (!isRecord(schema)) return undefined;
	const type = schema.type;
	const list = typeof type === "string" ? [type] : Array.isArray(type) ? type : undefined;
	if (!list || list.length === 0 || !list.every((item) => typeof item === "string" && TYPES.has(item))) return undefined;
	return list as string[];
}

function fits(value: unknown, type: string): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return isRecord(value);
		default:
			return value === null;
	}
}

/** 一个值按声明的类型能不能不含糊地换过去；换不了是 undefined。 */
function coerce(value: unknown, types: string[]): unknown {
	if ((typeof value === "number" || typeof value === "boolean") && types.includes("string")) return String(value);
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	for (const type of types) {
		if ((type === "number" || type === "integer") && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) {
			const number = Number(text);
			if (fits(number, type)) return number;
		}
		if (type === "boolean" && (text === "true" || text === "false")) return text === "true";
		if ((type === "array" && text.startsWith("[")) || (type === "object" && text.startsWith("{"))) {
			try {
				const parsed: unknown = JSON.parse(text);
				if (fits(parsed, type)) return parsed;
			} catch {
				// 不是 JSON，原样交给检查报错。
			}
		}
	}
	return undefined;
}

function propertiesOf(parameters: unknown): Record<string, unknown> | undefined {
	return isRecord(parameters) && isRecord(parameters.properties) ? parameters.properties : undefined;
}

/** 整理参数，没改动时原样返回同一个对象。 */
export function coerceArgs(args: Record<string, unknown>, parameters: Schema | undefined): Record<string, unknown> {
	const properties = propertiesOf(parameters);
	if (!properties || !isRecord(args)) return args;
	let result: Record<string, unknown> | undefined;
	for (const [name, schema] of Object.entries(properties)) {
		if (!Object.hasOwn(args, name)) continue;
		const value = args[name];
		const types = typesOf(schema);
		if (!types || types.some((type) => fits(value, type))) continue;
		if (value === null) {
			result ??= { ...args };
			delete result[name];
			continue;
		}
		const next = coerce(value, types);
		if (next === undefined) continue;
		result ??= { ...args };
		result[name] = next;
	}
	return result ?? args;
}

/** 整理之后还对不上的，一项一句（英文，给模型看）；对得上是空数组。 */
export function argumentProblems(args: Record<string, unknown>, parameters: Schema | undefined): string[] {
	const properties = propertiesOf(parameters);
	if (!properties) return [];
	if (!isRecord(args)) return ["arguments must be a JSON object"];
	const problems: string[] = [];
	for (const [name, schema] of Object.entries(properties)) {
		const value = args[name];
		if (value === undefined) continue;
		const types = typesOf(schema);
		if (types && !types.some((type) => fits(value, type))) {
			problems.push(`"${name}" must be ${types.join(" or ")}, got ${describe(value)}`);
			continue;
		}
		const options = isRecord(schema) && Array.isArray(schema.enum) ? schema.enum : undefined;
		if (options && !options.some((option) => option === value))
			problems.push(`"${name}" must be one of ${options.map((option) => JSON.stringify(option)).join(", ")}`);
	}
	return problems;
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
