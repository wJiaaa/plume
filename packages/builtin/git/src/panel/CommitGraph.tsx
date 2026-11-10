import type { GraphRow } from "./graph.ts";

/**
 * 各列的颜色，从产品已有的色里取。
 *
 * 没有单独的图表色，第四档用 warning 顶上（它和前三档都分得开）。
 */
const LANE_COLOURS = ["var(--plume-accent)", "var(--plume-ok)", "var(--plume-violet)", "var(--plume-warning)", "var(--plume-danger)", "var(--plume-ink-muted)"];

export const LANE_WIDTH = 13;

/** 图里每一条线一样粗、一样透明：同一条分支在提交行进出时换透明度，接缝看得出来。 */
const GRAPH_STROKE = 1.5;
const GRAPH_OPACITY = 0.85;

function laneColour(index: number): string {
	return LANE_COLOURS[index % LANE_COLOURS.length] ?? "currentColor";
}

/**
 * 提交图的一行，画在提交旁边。
 *
 * 一行一张，不画一整张高图：提交会展开出 diff，行高不定，整张画布每次展开都要重量重画。每行只画穿过自己的，
 * 点在行的正中，线从上沿画到下沿，相邻两行不用互相知道就接得上。
 */
export function CommitGraph({ row, height, width }: { row: GraphRow; height: number; width: number }) {
	const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
	const mid = height / 2;
	return (
		<svg aria-hidden width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="git-shrink-0" style={{ overflow: "visible", width, height }}>
			{/* 先画路过的线，点压在上面。 */}
			{row.through.map((line) => (
				<line
					key={`t${line.lane}`}
					x1={x(line.lane)}
					y1={0}
					x2={x(line.lane)}
					y2={height}
					stroke={laneColour(line.colour)}
					strokeWidth={GRAPH_STROKE}
					opacity={GRAPH_OPACITY}
				/>
			))}
			<line x1={x(row.lane)} y1={0} x2={x(row.lane)} y2={mid} stroke={laneColour(row.colour)} strokeWidth={GRAPH_STROKE} opacity={GRAPH_OPACITY} />
			{/* 合进来的线画成曲线：直角读起来像两条线碰巧挨上，曲线读起来是一条线到了这里。 */}
			{row.merges.map((line) => (
				<path
					key={`m${line.from}`}
					d={`M ${x(line.from)} 0 C ${x(line.from)} ${mid * 0.6}, ${x(row.lane)} ${mid * 0.4}, ${x(row.lane)} ${mid}`}
					fill="none"
					stroke={laneColour(line.colour)}
					strokeWidth={GRAPH_STROKE}
					opacity={GRAPH_OPACITY}
				/>
			))}
			{row.out.map((line) =>
				line.to === row.lane ? (
					<line
						key={`o${line.to}`}
						x1={x(row.lane)}
						y1={mid}
						x2={x(row.lane)}
						y2={height}
						stroke={laneColour(line.colour)}
						strokeWidth={GRAPH_STROKE}
						opacity={GRAPH_OPACITY}
					/>
				) : (
					<path
						key={`o${line.to}`}
						d={`M ${x(row.lane)} ${mid} C ${x(row.lane)} ${mid + (height - mid) * 0.4}, ${x(line.to)} ${mid + (height - mid) * 0.6}, ${x(line.to)} ${height}`}
						fill="none"
						stroke={laneColour(line.colour)}
						strokeWidth={GRAPH_STROKE}
						opacity={GRAPH_OPACITY}
					/>
				),
			)}
			{/* 合并提交画成空心：扫一眼就看得出它有不止一个父提交，不用图例。 */}
			<circle
				cx={x(row.lane)}
				cy={mid}
				r={3.5}
				fill={row.commit.parents.length > 1 ? "var(--plume-shell)" : laneColour(row.colour)}
				stroke={laneColour(row.colour)}
				strokeWidth={GRAPH_STROKE}
			/>
		</svg>
	);
}

/** 提交展开后，图里的线穿过它下面那块 diff 接着往下走，不断开。 */
export function CommitThroughGraph({ row, width }: { row: GraphRow; width: number }) {
	const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
	const active = new Map<number, number>();
	for (const line of row.through) active.set(line.lane, line.colour);
	for (const line of row.out) active.set(line.to, line.colour);
	const lines = [...active.entries()].map(([lane, colour]) => ({ lane, colour }));
	if (lines.length === 0) return <div style={{ width }} className="git-shrink-0" />;
	// 绝对定位在一个被撑开的盒子里，不在 svg 上写 `height="100%"`：那样高度依赖内容，浏览器退回 150px，线只画了一小截。
	return (
		<div className="git-graph-through" style={{ width }}>
			<svg aria-hidden className="git-graph-fill" style={{ overflow: "visible" }}>
				{lines.map((line) => (
					<line
						key={`cont-${line.lane}`}
						x1={x(line.lane)}
						y1={0}
						x2={x(line.lane)}
						y2="100%"
						stroke={laneColour(line.colour)}
						strokeWidth={GRAPH_STROKE}
						opacity={GRAPH_OPACITY}
					/>
				))}
			</svg>
		</div>
	);
}
