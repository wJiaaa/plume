import type { FileDiff } from "@plume/platform";

/** 把差异画成统一格式的文本，给审批和工具输出用。 */
export function formatDiff(diff: FileDiff, path: string, maxLines = 200): string {
	if (diff.hunks.length === 0) return `${path}: no changes`;
	const out: string[] = [`--- ${path}`, `+++ ${path}`];
	let emitted = 0;
	for (const hunk of diff.hunks) {
		out.push(`@@ -${hunk.oldStart} +${hunk.newStart} @@`);
		for (const line of hunk.lines) {
			if (emitted >= maxLines) {
				out.push(`… diff truncated (+${diff.added} / -${diff.removed} total)`);
				return out.join("\n");
			}
			out.push(`${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.text}`);
			emitted++;
		}
	}
	return out.join("\n");
}
