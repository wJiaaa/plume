/**
 * `ToolRun.files.read` 背后的那一步：一个要读的东西是资源地址还是路径，地址交给拥有它的 scheme，路径过读边界（`read-access.ts`）。
 */

import type { Resource, ResourceScope, RunFiles } from "@plume/contract";
import { authorizeRead, type ReadScope } from "./read-access.ts";
import { scratchTarget } from "./resources/handlers.ts";
import { parseResourceUrl, type ResourceRouter } from "./resources/router.ts";

type ReadResult = Awaited<ReturnType<RunFiles["read"]>>;

/** 交给模型的话：scheme 抛的错就是它的说明。 */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * 先认地址，而且只认有人登记了的 scheme：没人认的 `foo://` 照路径判，在文件系统那里以「找不到」失败，那是实话；
 * 把所有 `://` 都揽过来，会拿地址的报错回答一个从没想用地址的人路径里的笔误。
 *
 * 地址不问人：落点已由 scheme 限在它自己的地方（临时目录、技能目录），问一次只是让人替它点头。
 * `scratch://x` 是临时目录里的一个文件，按文件交回，读它的工具才能把它当文件记（之后改它要先读过）；带行范围的是一段，不是一个文件。
 */
export async function readTarget(
	read: ReadScope,
	resources: { router: ResourceRouter; scope: ResourceScope },
	target: string,
	directory = false,
): Promise<ReadResult> {
	const { router, scope } = resources;
	if (typeof target === "string" && router.canResolve(target)) {
		if (directory) {
			try {
				const located = await router.locate(target, scope);
				if (located) return { ok: true, path: located };
			} catch (error) {
				return { ok: false, message: messageOf(error) };
			}
		} else {
			const url = parseResourceUrl(target);
			if (url?.scheme === "scratch" && !url.range) {
				// 越界的交给下面按地址读，由它说出原因。
				const file = await scratchTarget(url, scope).catch(() => null);
				if (file) return { ok: true, path: file };
			}
			try {
				const resource: Resource = await router.resolve(target, scope);
				return { ok: true, resource };
			} catch (error) {
				return { ok: false, message: messageOf(error) };
			}
		}
	}
	const authorized = await authorizeRead(read, target);
	return authorized.ok ? { ok: true, path: authorized.absolute } : authorized;
}
