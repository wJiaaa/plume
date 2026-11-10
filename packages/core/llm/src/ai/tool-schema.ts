/**
 * 工具参数 schema 发出去之前、三种格式都要做的改写。各家专有的规整（Anthropic 的关键字白名单）留在各自的
 * encoder 里；这里只放对所有端点都语义等价的那种。
 */

import { isRecord } from "../utils/record.ts";

/**
 * 指向 `$defs` 以外的本地 `$ref`（`#/properties/a`、`#/definitions/X`），目标复制进 `$defs`、引用改指过去。
 *
 * MCP 服务器的 schema 常这样复用前面某个属性的定义。Kimi 的工具 schema 要守 MFJS 规范：「`$defs` must be
 * defined at the schema root level; `$ref` only supports referencing internal subschemas … indexed through
 * `$defs`」（github.com/MoonshotAI/walle docs/mfjs-spec.md），原样发出过不了校验——装了那个 MCP，之后每一轮
 * 都 400。搬过去之后引用解析到的是同一个形状，对认任意 JSON Pointer 的端点也毫无差别，所以不挂在厂商上、
 * 三种格式一律做。
 *
 * 搬走的目标原处不留第二份：`definitions` 里的删掉（删空了整个去掉），别处的换成指向 `$defs` 的引用。否则
 * 同一份定义每轮在工具列表里发两遍。
 *
 * 没有这种引用时返回**原来那个对象**：这在每一轮的工具列表上跑一遍，绝大多数 schema 都不会走到改写。解析
 * 不到的引用和外部引用不动、也不抛——改不了的交给端点判，至少不比原来更糟。
 */
export function hoistLocalRefs<T>(schema: T): T {
	if (!isRecord(schema)) return schema;
	const refs = new Set<string>();
	collectRefs(schema, refs, new WeakSet());
	for (const ref of refs) if (resolvePointer(schema, ref) === undefined) refs.delete(ref);
	if (refs.size === 0) return schema;

	const existing = isRecord(schema.$defs) ? schema.$defs : {};
	const taken = new Set(Object.keys(existing));
	const keyByRef = new Map<string, string>();
	for (const ref of refs) {
		// 用指针最后一段起名（`#/definitions/Stop` → `Stop`），模型读 schema 时比一串编号好认。只留指针里不用
		// 转义的字符，免得新引用自己又要编码。
		const base = (decodeSegment(ref.slice(ref.lastIndexOf("/") + 1)) ?? "").replace(/[^a-zA-Z0-9_-]/g, "_") || "ref";
		let key = base;
		for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
		taken.add(key);
		keyByRef.set(ref, key);
	}

	const memo = new WeakMap<object, unknown>();
	const root = rewriteRefs(schema, keyByRef, memo) as Record<string, unknown>;
	const defs: Record<string, unknown> = { ...(isRecord(root.$defs) ? root.$defs : {}) };
	for (const [ref, key] of keyByRef) defs[key] = rewriteRefs(resolvePointer(schema, ref), keyByRef, memo);
	for (const [ref, key] of keyByRef) {
		const path = ref.slice(2).split("/").map((segment) => decodeSegment(segment) as string);
		const name = path.pop() as string;
		const parent = resolvePointer(root, path.length > 0 ? `#/${path.map(encodeSegment).join("/")}` : "#");
		// 走不到说明父节点已经在前一轮被删或换掉，它那一份已经在 `$defs` 里。
		if (path.length === 1 && path[0] === "definitions" && isRecord(parent)) delete parent[name];
		else if (Array.isArray(parent)) parent[Number(name)] = { $ref: `#/$defs/${key}` };
		else if (isRecord(parent)) parent[name] = { $ref: `#/$defs/${key}` };
	}
	if (isRecord(root.definitions) && Object.keys(root.definitions).length === 0) delete root.definitions;
	return { ...root, $defs: defs } as T;
}

/** 要搬的引用：本地（`#/` 开头）、不在 `$defs` 下。`seen` 防的是代码里拼出来的共享或环状对象。 */
function collectRefs(value: unknown, refs: Set<string>, seen: WeakSet<object>): void {
	if (value === null || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) collectRefs(item, refs, seen);
		return;
	}
	const ref = (value as Record<string, unknown>).$ref;
	if (typeof ref === "string" && ref.startsWith("#/") && !ref.startsWith("#/$defs/")) refs.add(ref);
	for (const child of Object.values(value)) collectRefs(child, refs, seen);
}

function decodeSegment(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
	} catch {
		return undefined;
	}
}

const encodeSegment = (segment: string): string => segment.replaceAll("~", "~0").replaceAll("/", "~1");

/** 按 JSON Pointer（RFC 6901）在 schema 里找目标；走不通就是 undefined。`#` 是根。 */
function resolvePointer(root: unknown, ref: string): unknown {
	if (ref === "#") return root;
	let at = root;
	for (const raw of ref.slice(2).split("/")) {
		const segment = decodeSegment(raw);
		if (segment === undefined) return undefined;
		if (Array.isArray(at)) {
			if (!/^\d+$/.test(segment)) return undefined;
			at = at[Number(segment)];
		} else if (isRecord(at) && Object.hasOwn(at, segment)) at = at[segment];
		else return undefined;
	}
	return at;
}

/** 整棵树复制一份，要搬的引用改指 `$defs`。`memo` 让共享的子树复制后仍然共享，环也走得出来。 */
function rewriteRefs(value: unknown, keyByRef: ReadonlyMap<string, string>, memo: WeakMap<object, unknown>): unknown {
	if (value === null || typeof value !== "object") return value;
	const done = memo.get(value);
	if (done !== undefined) return done;
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		memo.set(value, out);
		for (const item of value) out.push(rewriteRefs(item, keyByRef, memo));
		return out;
	}
	const out: Record<string, unknown> = {};
	memo.set(value, out);
	for (const [key, child] of Object.entries(value)) {
		const moved = key === "$ref" && typeof child === "string" ? keyByRef.get(child) : undefined;
		out[key] = moved ? `#/$defs/${moved}` : rewriteRefs(child, keyByRef, memo);
	}
	return out;
}
