/**
 * 拆开一个地址，交给拥有那个 scheme 的一方：本体自己的几个（`handlers.ts`），和插件经 `ctx.resources.register` 登记的（见 `@plume/contract` 的 `resources.ts`）。
 *
 * 路由只有一个，各会话的不同由 `ResourceScope`（会话 id、工作目录、临时目录）带进来，scheme 自己不存「当前会话」：
 * 存了的话，主会话和子会话同时跑时 `skill://x` 会按最后写进去的那个会话解析，偶尔读到别人的东西，只在并发时出现。
 */

import { readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Resource, ResourceAddress, ResourceEntry, ResourceHandler, ResourceScope } from "@plume/contract";
import { withinOrIs } from "@plume/platform";

/**
 * scheme 是字母、数字、连字符，后面必须跟 `://`。
 *
 * 必须有 `://`：`C:\Users`、`note:todo` 不是地址，得照旧当文件路径读。宽一点的写法会把 Windows 盘符吞进去，
 * 结果是某条路径只在一个平台上悄悄不再解析。
 */
const URL_PATTERN = /^([a-z][a-z0-9-]*):\/\/(.*)$/i;
const SCHEME = /^[a-z][a-z0-9-]*$/;
/** 末尾的 `:12` 或 `:12-40`，和 read 对文件路径认的是同一种。 */
const RANGE_PATTERN = /:(\d+)(?:-(\d+))?$/;

export class ResourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ResourceError";
	}
}

export function parseResourceUrl(input: string): ResourceAddress | null {
	const match = URL_PATTERN.exec(input.trim());
	if (!match) return null;

	const scheme = match[1]!.toLowerCase();
	let path = match[2]!;
	let range: ResourceAddress["range"];

	const ranged = RANGE_PATTERN.exec(path);
	if (ranged) {
		range = { from: Number(ranged[1]), ...(ranged[2] ? { to: Number(ranged[2]) } : {}) };
		path = path.slice(0, ranged.index);
	}

	return {
		scheme,
		path,
		segments: path.split("/").filter((segment) => segment.length > 0),
		...(range ? { range } : {}),
		raw: input.trim(),
	};
}

/** 本体自己的那个可写 scheme：只有 `scratch://`，见 `handlers.ts`。 */
export interface WritableHandler extends ResourceHandler {
	write(address: ResourceAddress, content: string, scope: ResourceScope): Promise<void>;
}

/**
 * 插件经 `ctx.resources.register` 登记的 scheme 只留读的几样：`ResourceHandler` 的类型里没有 `write`，可类型挡不住绕过它的插件，
 * 而 `write` 只看对象上有没有这个方法。不复制的话，插件塞一个 `write` 就能让模型改它该遵守的说明。
 */
export function readOnly(handler: ResourceHandler): ResourceHandler {
	if (!handler || typeof handler !== "object") return handler;
	const { scheme, describe, resolve, list, locate } = handler;
	return {
		scheme,
		describe,
		resolve: typeof resolve === "function" ? resolve.bind(handler) : resolve,
		...(typeof list === "function" ? { list: list.bind(handler) } : {}),
		...(typeof locate === "function" ? { locate: locate.bind(handler) } : {}),
	};
}

export class ResourceRouter {
	private readonly handlers = new Map<string, ResourceHandler>();

	register(handler: ResourceHandler): () => void {
		if (typeof handler?.scheme !== "string" || !SCHEME.test(handler.scheme)) throw new Error(`Resource scheme "${String(handler?.scheme)}" is not valid.`);
		if (typeof handler.resolve !== "function" || typeof handler.describe !== "string")
			throw new Error(`Resource scheme "${handler.scheme}://" needs describe and resolve.`);
		if (this.handlers.has(handler.scheme)) throw new Error(`Resource scheme "${handler.scheme}://" is already registered.`);
		this.handlers.set(handler.scheme, handler);
		return () => {
			if (this.handlers.get(handler.scheme) === handler) this.handlers.delete(handler.scheme);
		};
	}

	/** 是不是我们认的地址。不认识的 `://` 也不是文件路径，但交给文件系统去报「找不到」，那是实话。 */
	canResolve(input: string): boolean {
		const parsed = parseResourceUrl(input);
		return parsed !== null && this.handlers.has(parsed.scheme);
	}

	schemes(): { scheme: string; describe: string; writable: boolean }[] {
		return [...this.handlers.values()]
			.map((h) => ({ scheme: h.scheme, describe: h.describe, writable: typeof (h as Partial<WritableHandler>).write === "function" }))
			.sort((a, b) => a.scheme.localeCompare(b.scheme));
	}

	async resolve(input: string, scope: ResourceScope): Promise<Resource> {
		const { url, handler } = this.route(input);

		/*
		 * 路径为空是要目录。在这里统一处理，不放进各个 scheme：`read skill://` 对每个 scheme 都一样，
		 * 包括以后别的插件加的、作者从没读过这个文件的那些。
		 */
		if (url.segments.length === 0) {
			// i18n-exempt：交给模型的工具结果。
			if (!handler.list) throw new ResourceError(`\`${url.scheme}://\` 不能列目录，请给一个具体的名字。`);
			const entries: ResourceEntry[] = await handler.list(scope);
			const body =
				entries.length === 0
					? `（${url.scheme}:// 下面暂时没有东西）`
					: entries.map((e) => (e.description ? `- ${e.value}: ${e.description}` : `- ${e.value}`)).join("\n");
			return { url: url.raw, content: body, contentType: "text/markdown" };
		}

		const resource = await handler.resolve(url, scope);
		return url.range ? sliceResource(resource, url.range) : resource;
	}

	async write(input: string, content: string, scope: ResourceScope): Promise<void> {
		const { url, handler } = this.route(input);
		const write = (handler as Partial<WritableHandler>).write;
		if (!write) {
			/*
			 * 默认只读，这是这套设计要紧的那一半。能 `write skill://<名字>` 的模型就能改掉它该遵守的说明，而那次修改看起来
			 * 和别的工具调用没两样。改技能走文件系统，那里有人自己的审核。
			 */
			// i18n-exempt：交给模型的工具结果。
			throw new ResourceError(`\`${url.scheme}://\` 是只读的，不能写。`);
		}
		await write.call(handler, url, content, scope);
	}

	/** 地址在磁盘上指的位置（ls 用），没有这个 scheme、scheme 不给位置时是 null。 */
	async locate(input: string, scope: ResourceScope): Promise<string | null> {
		if (!this.canResolve(input)) return null;
		const { url, handler } = this.route(input);
		if (url.range || !handler.locate) return null;
		return handler.locate(url, scope);
	}

	private route(input: string): { url: ResourceAddress; handler: ResourceHandler } {
		const url = parseResourceUrl(input);
		// i18n-exempt：交给模型的工具结果。
		if (!url) throw new ResourceError(`“${input}”不是一个地址。`);
		const handler = this.handlers.get(url.scheme);
		if (!handler) {
			const known = [...this.handlers.keys()].map((s) => `${s}://`).join("、");
			// i18n-exempt：交给模型的工具结果。
			throw new ResourceError(`不认识 \`${url.scheme}://\`。现在可用的是：${known || "（没有）"}`);
		}
		return { url, handler };
	}
}

function sliceResource(resource: Resource, range: { from: number; to?: number }): Resource {
	const lines = resource.content.split("\n");
	const from = Math.max(1, range.from);
	const to = Math.min(lines.length, range.to ?? range.from);
	return { ...resource, content: lines.slice(from - 1, to).join("\n") };
}

/**
 * 顺着软链再查一遍还在不在里面。
 *
 * `resolveInside` 挡不住根里面一条指向外面的软链：字面路径没出去，读却出去了。单独一步，因为它要一次系统调用，
 * 也只在根里放着不是人自己写的文件时才要紧。
 */
export async function stillInside(root: string, resolved: string): Promise<boolean> {
	// 根也按同一个办法取：临时目录第一次写之前还不存在，而 macOS 的 tmpdir 本身就在软链后面。
	const [realRoot, realChild] = await Promise.all([realLocation(root), realLocation(resolved)]);
	return withinOrIs(realRoot, realChild);
}

/**
 * 一条路径真正落在哪里，包括还不存在的。
 *
 * 要写的新文件 `realpath` 取不到，退回字面路径就漏了两种：父目录是指向外面的软链（`out/new.txt`），
 * 和最后一段本身是悬空软链——`writeFile` 会顺着它在外面新建文件。所以悬空软链跟着它走，真不存在的
 * 取最近一个存在的父目录的真实位置，再接上剩下的部分。
 */
async function realLocation(path: string, hops = 0): Promise<string> {
	const real = await realpath(path).catch(() => null);
	if (real !== null) return real;
	const link = hops < 40 ? await readlink(path).catch(() => null) : null;
	if (link !== null) return realLocation(resolve(dirname(path), link), hops + 1);
	const parent = dirname(path);
	if (parent === path) return path;
	return join(await realLocation(parent, hops), basename(path));
}
