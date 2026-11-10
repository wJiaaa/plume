import type { ResourceScope } from "@plume/contract";
import { scratchTarget } from "../resources/handlers.ts";
import { parseResourceUrl } from "../resources/router.ts";
import type { ToolContext } from "./types.ts";

/** 解析地址用的那份环境；没有临时目录的（直接工具测试）给空串，`scratch://` 就报「没有临时目录」。 */
export function resourceScope(ctx: ToolContext): ResourceScope {
	return { cwd: ctx.cwd, sessionId: ctx.sessionId ?? "", scratchDir: ctx.scratchDir ?? "", ...(ctx.signal ? { signal: ctx.signal } : {}) };
}

/**
 * `scratch://x` 指的磁盘上的那个文件，别的都是 null。
 *
 * read 和 edit 得认同一个文件：先读再改的记录按文件记。只有 read 经地址读、edit 却把地址当相对路径（`<项目>/scratch:/x`）的话，
 * 每次改临时文件都报「先读一遍」，重读也没用。带行范围的（`scratch://x:10-40`）还是地址：那是一段，不是一个文件。
 */
export async function scratchFile(ctx: ToolContext, input: string): Promise<string | null> {
	if (!ctx.resources?.canResolve(input)) return null;
	const url = parseResourceUrl(input);
	if (url?.scheme !== "scratch" || url.range) return null;
	// 字面路径，不取 realpath：工具自己会规范化，在比较字面写法的边界检查之后。
	return scratchTarget(url, resourceScope(ctx));
}
