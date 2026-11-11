/**
 * 排队条上拖动、↑↓ 挪一条：位置只在还排着的那几条里数。正在收起的那一行（`leaving`）已经不在队里，
 * 拿它当落点会把这一条挪到一个不存在的 id 旁边。`from`、`to` 都是在还排着的那几条里的位置。
 */
export function queueMove(
	rows: readonly { entry: { id: string }; leaving: boolean }[],
	from: number,
	to: number,
): { id: string; targetId: string; placement: "before" | "after" } | null {
	const staying = rows.filter((row) => !row.leaving);
	const moving = staying[from]?.entry;
	const target = staying[to]?.entry;
	if (!moving || !target || from === to) return null;
	return { id: moving.id, targetId: target.id, placement: to > from ? "after" : "before" };
}
