import type { GitCommit } from "../api.ts";

/** 画出来的一行：这个提交的点在哪一列，穿过这一行的每一条线。 */
export interface GraphRow {
	commit: GitCommit;
	/** 点所在的列。 */
	lane: number;
	/** 整行都占着某一列的线。 */
	through: { lane: number; colour: number }[];
	/** 从这个点出发、去下一行 `to` 列的线：它的父提交。 */
	out: { to: number; colour: number }[];
	/** 从上面几列汇进这个点的线：这里是它们合并进来的地方。 */
	merges: { from: number; colour: number }[];
	colour: number;
}

/** 列数到这里就不再加宽，再宽不值得占那么多地方。 */
const MAX_LANES = 8;

/**
 * 把提交排进各列。
 *
 * 列表已经按拓扑排好，一遍就够：维护一排「开着的」列，每列记着它在等哪个 sha。提交占住等它的那一列（从子提交下来的线），
 * 把这一列交给第一个父提交；其余父提交是合并，各占一列，画成斜着的线。颜色跟着列走，一条线从分出去到合回来是同一个颜色，
 * 顺着颜色往上看就知道这段工作是从哪儿来的。
 */
export function buildGraph(commits: GitCommit[]): GraphRow[] {
	let open: (string | null)[] = [];
	const colours = new Map<number, number>();
	let nextColour = 0;

	const colourFor = (lane: number): number => {
		const existing = colours.get(lane);
		if (existing !== undefined) return existing;
		const assigned = nextColour++;
		colours.set(lane, assigned);
		return assigned;
	};

	return commits.map((commit) => {
		let lane = open.indexOf(commit.sha);
		if (lane === -1) {
			// 上面没有谁在等它：一个分支的顶端，自己开一列。
			lane = open.findIndex((slot) => slot === null);
			if (lane === -1) lane = Math.min(open.length, MAX_LANES - 1);
			colours.delete(lane);
		}
		const colour = colourFor(lane);

		// 别的列也在等这个 sha：那是合进这个点的线。
		const merges: { from: number; colour: number }[] = [];
		open = open.map((slot, index) => {
			if (index !== lane && slot === commit.sha) {
				merges.push({ from: index, colour: colourFor(index) });
				colours.delete(index);
				return null;
			}
			return slot;
		});

		// 放父提交之前先记下穿过的线，这个提交马上要占的列不算穿过。
		const through = open
			.map((slot, index) => ({ slot, index }))
			.filter(({ slot, index }) => slot !== null && index !== lane)
			.map(({ index }) => ({ lane: index, colour: colourFor(index) }));

		const out: { to: number; colour: number }[] = [];
		const [first, ...rest] = commit.parents;

		if (first) {
			open[lane] = first;
			out.push({ to: lane, colour });
		} else {
			// 根提交：这一列到此为止。
			open[lane] = null;
			colours.delete(lane);
		}

		for (const parent of rest) {
			// 已经在屏幕上的父提交留在它的列，合并线画过去。
			const existing = open.indexOf(parent);
			if (existing !== -1) {
				out.push({ to: existing, colour: colourFor(existing) });
				continue;
			}
			let slot = open.findIndex((value) => value === null);
			if (slot === -1) {
				if (open.length >= MAX_LANES) continue;
				slot = open.length;
			}
			open[slot] = parent;
			colours.delete(slot);
			out.push({ to: slot, colour: colourFor(slot) });
		}

		// 去掉末尾的空列，分支合回去以后图跟着变窄。
		while (open.length > 0 && open[open.length - 1] === null) open.pop();

		return { commit, lane, through, out, merges, colour };
	});
}

/**
 * 每一行图那一栏多宽：往下取到此为止最宽的那一行。
 *
 * 整列一个宽度的话，三周前某一行开过八个分支，最近一路直线的提交也要让出八列的空白，标题被截掉。
 * 按往下累计的最大值算：列的位置不依赖它，线照样对得上；只往宽里变，滚动时标题不会左右晃，加载更多也不动已有的行。
 */
export function graphWidths(rows: GraphRow[], laneWidth: number): number[] {
	let widest = 1;
	return rows.map((row) => {
		const lanes = [row.lane, ...row.through.map((line) => line.lane), ...row.out.map((line) => line.to)];
		widest = Math.max(widest, ...lanes.map((lane) => lane + 1));
		return widest * laneWidth;
	});
}
