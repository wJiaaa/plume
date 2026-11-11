/**
 * 排在输入框上方、等着轮到自己的那几条。会话正忙时按下回车，话不插进正在跑的那一轮，落在这里：
 * 一条一行，看得见、改得了，也排得出先后。
 *
 *   现在就发     停下这一轮、拿这一条重新开始。不做成插进这一轮：插话要等模型写完手上这一步才被读到，
 *                那可以是好几分钟，按下去像什么也没发生。
 *   删除         不想说了。
 *   编辑         这一条整份退回输入框，连同附件和引用：它先从条上收掉，再落进输入框。
 *   插件的项     「更多」菜单里排在编辑后面（在侧边聊天中打开）：这一条从条上收掉，交给插件拿到别处去发。
 *   拖动         多条排着时先后能改，改的过程要看得见：让位的那几条自己滑开。键盘在手柄上按 ↑↓ 也行。
 *
 * 离场分两种。人拿走的（删除、编辑）留下来播完收起。送出去的（这一轮结束时队首出队、「现在就发」）当帧消失：
 * 出队那一刻转录里已经多了这句话，条再慢慢收起，贴底的转录会被一路往下拖。
 *
 * 几个记号一直在，只是很淡：藏到悬停才出现会更干净，代价是没人知道这一行还能做什么。
 */

import { DURATION, IconButton, MenuBody, MenuItem, motionReduced, Popover, useI18n, usePopover } from "@plume/ui";
import { CornerDownLeft, GripVertical, MoreHorizontal, PencilLine, Trash2 } from "@plume/ui/icons";
import { type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QueueChoice } from "../plugins.tsx";
import { queueMove } from "./queue-move.ts";

export interface QueuedMessage {
	id: string;
	/** 行里显示的那句话。 */
	preview: string;
}

/** 还在播退场的那一条，连同它走之前站的位置：补回原处，队伍才不会在它头上先塌一格。 */
interface Leaving<T> {
	entry: T;
	at: number;
}

const NO_ACTIONS: readonly QueueChoice[] = [];

export function QueuedMessages<T extends QueuedMessage>({
	items,
	running,
	onSendNow,
	onRemove,
	onEdit,
	onMove,
	actions = NO_ACTIONS,
	onAction,
}: {
	items: readonly T[];
	running: boolean;
	onSendNow: (id: string) => void;
	onRemove: (id: string) => void;
	/** 编辑：从队里拿走，整份退回输入框。 */
	onEdit: (id: string) => void;
	onMove: (id: string, targetId: string, placement: "before" | "after") => void;
	/** 插件加在「更多」菜单里的项；没有时不出菜单，直接放「编辑」按钮。 */
	actions?: readonly QueueChoice[];
	/** 点了插件的一项：从队里拿走，交给它。 */
	onAction?: (id: string, action: QueueChoice) => void;
}) {
	const { t } = useI18n();
	const [leaving, setLeaving] = useState<Leaving<T>[]>([]);
	const previous = useRef(items);
	/** 人从条上拿走的那几条。只有它们播收起；不在这里面的离场都是送出去了。 */
	const dismissed = useRef(new Set<string>());
	const recalled = useRef(new Set<string>());
	const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
	const finish = (id: string) => {
		recalled.current.delete(id);
		setLeaving((current) => current.filter((each) => each.entry.id !== id));
	};

	// 走掉的那几行在这一次渲染里就补回去，不等 effect：过渡挂在它们原来那个 DOM 节点上。
	const gone = previous.current
		.map((entry, at) => ({ entry, at }))
		.filter(({ entry }) => !items.some((each) => each.id === entry.id) && dismissed.current.has(entry.id));
	const departures = [...leaving, ...gone].filter(({ entry }) => !items.some((each) => each.id === entry.id));
	const rows: { entry: T; leaving: boolean }[] = items.map((entry) => ({ entry, leaving: false }));
	for (const { entry, at } of departures)
		if (!rows.some((row) => row.entry.id === entry.id)) rows.splice(Math.min(at, rows.length), 0, { entry, leaving: true });

	useLayoutEffect(() => {
		const departed = previous.current.map((entry, at) => ({ entry, at })).filter(({ entry }) => !items.some((each) => each.id === entry.id));
		previous.current = items;
		const removed = departed.filter(({ entry }) => dismissed.current.delete(entry.id));
		if (removed.length === 0) return;
		setLeaving((current) => [...current, ...removed]);
		// 正常由行自己的 transitionend 收走；这里兜没有过渡可等的时候：减弱动效、窗口在后台。
		const timer = setTimeout(
			() => {
				for (const one of removed) finish(one.entry.id);
				timers.current.delete(timer);
			},
			motionReduced() ? 0 : DURATION.base * 2,
		);
		timers.current.add(timer);
	}, [items]);
	useEffect(
		() => () => {
			for (const timer of timers.current) clearTimeout(timer);
		},
		[],
	);

	if (rows.length === 0) return null;
	// 停下来之后队伍不会自己走：按停说的就是现在别再接着做了，这时它们等的是人，得说出来。
	return (
		<Rows
			rows={rows}
			recalled={recalled.current}
			status={running ? t("composer.queueWaiting") : t("composer.queueHeld")}
			nowLabel={running ? t("composer.queueNow") : t("composer.queueSendNow")}
			onSendNow={onSendNow}
			onRemove={(id) => {
				dismissed.current.add(id);
				onRemove(id);
			}}
			onEdit={(id) => {
				dismissed.current.add(id);
				recalled.current.add(id);
				onEdit(id);
			}}
			onMove={onMove}
			onGone={finish}
			actions={onAction ? actions : []}
			onAction={(id, action) => {
				dismissed.current.add(id);
				onAction?.(id, action);
			}}
		/>
	);
}

/**
 * 拖动的状态。`delta` 是被拖的那条跟着指针走了多远，`to` 是松手会落到第几位。其余各行按这两个数让位——
 * 让位是 transform，不是重排：重排是一次布局，布局不能补间。
 */
interface Drag {
	id: string;
	from: number;
	to: number;
	delta: number;
}

function Rows<T extends QueuedMessage>({
	rows,
	recalled,
	status,
	nowLabel,
	onSendNow,
	onRemove,
	onEdit,
	onMove,
	onGone,
	actions,
	onAction,
}: {
	rows: { entry: T; leaving: boolean }[];
	recalled: ReadonlySet<string>;
	status: string;
	nowLabel: string;
	onSendNow: (id: string) => void;
	onRemove: (id: string) => void;
	onEdit: (id: string) => void;
	onMove: (id: string, targetId: string, placement: "before" | "after") => void;
	onGone: (id: string) => void;
	actions: readonly QueueChoice[];
	onAction: (id: string, action: QueueChoice) => void;
}) {
	const { t } = useI18n();
	const list = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<Drag | null>(null);
	const [settling, setSettling] = useState(false);
	/** 一行到下一行的距离，拖动开始时量一次：行高固定，拖动中再量会读到让位后的位置。 */
	const step = useRef(0);
	const origin = useRef({ y: 0, index: 0 });
	// 拖动、↑↓ 的位置都按还排着的那几条数，正在收起的不算：见 `queueMove`。
	const staying = rows.filter((row) => !row.leaving);
	const sortable = staying.length > 1;

	const startDrag = (index: number, id: string, event: PointerEvent) => {
		// 触摸留给页面自己滚；只有主键起拖。
		if (!sortable || event.button !== 0 || event.pointerType === "touch") return;
		const elements = [...(list.current?.querySelectorAll("[data-queue-row]:not([data-leaving])") ?? [])];
		const first = elements[0]?.getBoundingClientRect();
		const second = elements[1]?.getBoundingClientRect();
		step.current = first && second ? second.top - first.top : 0;
		if (!step.current) return;
		origin.current = { y: event.clientY, index };
		// 抓住指针，手滑出手柄拖动也不断；拿不到就退回普通的 pointermove，只是甩太远会松手。
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// 见上。
		}
		setDrag({ id, from: index, to: index, delta: 0 });
	};

	const moveDrag = (event: PointerEvent) => {
		if (!drag) return;
		const span = staying.length - 1;
		const at = origin.current.index;
		// 只在队伍自己的长度里走：卡片裁掉溢出，甩到外面那行会像被拖没了。夹住之后它顶在松手会落到的那一格。
		const delta = Math.min(Math.max(event.clientY - origin.current.y, -at * step.current), (span - at) * step.current);
		const to = Math.min(Math.max(at + Math.round(delta / step.current), 0), span);
		if (delta !== drag.delta || to !== drag.to) setDrag({ ...drag, delta, to });
	};

	const endDrag = () => {
		if (!drag) return;
		const move = queueMove(rows, drag.from, drag.to);
		if (move) {
			// 新顺序和 transform 归零同一帧生效，这一帧关掉过渡，不然行会从新位置再偏出去一截、滑回来。
			setSettling(true);
			onMove(move.id, move.targetId, move.placement);
			requestAnimationFrame(() => setSettling(false));
		}
		setDrag(null);
	};

	/** 让位：被拖的那条跟着手指，被越过的那几条各让一格。 */
	const offsetOf = (index: number): number => {
		if (!drag) return 0;
		if (index === drag.from) return drag.delta;
		if (drag.from < drag.to && index > drag.from && index <= drag.to) return -step.current;
		if (drag.from > drag.to && index >= drag.to && index < drag.from) return step.current;
		return 0;
	};

	const nudge = (index: number, by: -1 | 1) => {
		const move = queueMove(rows, index, index + by);
		if (move) onMove(move.id, move.targetId, move.placement);
	};

	return (
		// 一张卡片、几行内容：边框只画外面这一圈，行与行之间挨着就够了，指到哪一行哪一行亮。圆角切住行的高亮，也圈住拖动。
		<div
			ref={list}
			role="list"
			aria-label={t("composer.queueLabel")}
			data-queue=""
			data-empty={rows.every((row) => row.leaving) || undefined}
			className="plume-composer-queue overflow-hidden rounded-xl bg-card/40"
		>
			{rows.map((row) => (
				<Row
					key={row.entry.id}
					entry={row.entry}
					leaving={row.leaving}
					recalled={recalled.has(row.entry.id)}
					index={staying.indexOf(row)}
					sortable={sortable}
					dragging={drag?.id === row.entry.id}
					settling={settling}
					offset={row.leaving ? 0 : offsetOf(staying.indexOf(row))}
					status={status}
					nowLabel={nowLabel}
					onSendNow={onSendNow}
					onRemove={onRemove}
					onEdit={onEdit}
					onGone={onGone}
					actions={actions}
					onAction={onAction}
					onDragStart={startDrag}
					onDragMove={moveDrag}
					onDragEnd={endDrag}
					onNudge={nudge}
				/>
			))}
		</div>
	);
}

function Row({
	entry,
	leaving,
	recalled,
	index,
	sortable,
	dragging,
	settling,
	offset,
	status,
	nowLabel,
	onSendNow,
	onRemove,
	onEdit,
	onGone,
	actions,
	onAction,
	onDragStart,
	onDragMove,
	onDragEnd,
	onNudge,
}: {
	entry: QueuedMessage;
	leaving: boolean;
	recalled: boolean;
	index: number;
	sortable: boolean;
	dragging: boolean;
	settling: boolean;
	offset: number;
	status: string;
	nowLabel: string;
	onSendNow: (id: string) => void;
	onRemove: (id: string) => void;
	onEdit: (id: string) => void;
	onGone: (id: string) => void;
	actions: readonly QueueChoice[];
	onAction: (id: string, action: QueueChoice) => void;
	onDragStart: (index: number, id: string, event: PointerEvent) => void;
	onDragMove: (event: PointerEvent) => void;
	onDragEnd: () => void;
	onNudge: (index: number, by: -1 | 1) => void;
}) {
	const { t, resolvedLocale } = useI18n();
	const more = usePopover();
	/*
	 * 进场只在挂上的那一次播，播完摘掉：常驻的话拖动换位时 React 挪动节点，浏览器会把它当成新动画重播一遍，
	 * 松手那一下两行先缩没、再长出来。
	 */
	const [entering, setEntering] = useState(true);
	return (
		<div
			data-queue-row=""
			role="listitem"
			className="plume-queue-row"
			data-leaving={leaving || undefined}
			data-recalled={recalled || undefined}
			inert={leaving}
			data-dragging={dragging || undefined}
			data-settling={settling || undefined}
			data-entering={entering || undefined}
			onAnimationEnd={(event) => {
				if (event.target === event.currentTarget) setEntering(false);
			}}
			// 收完才真的拿走：按定时器拿，过渡下一帧才起步，末尾那一截会被一刀切掉。
			onTransitionEnd={(event) => {
				if (leaving && event.target === event.currentTarget && event.propertyName === "grid-template-rows") onGone(entry.id);
			}}
			style={offset ? { transform: `translateY(${offset}px)` } : undefined}
		>
			{/* 折叠的那一层：收到 0fr 时里面的东西被裁掉而不是溢出来。 */}
			<div>
				<div className="flex h-8 items-center gap-2.5 px-2 text-label transition-colors hover:bg-card-hover">
					<button
						type="button"
						data-queue-grip=""
						disabled={!sortable}
						aria-label={t("composer.queueReorder")}
						data-plume-tip={sortable ? t("composer.queueReorder") : undefined}
						onPointerDown={(event) => onDragStart(index, entry.id, event)}
						onPointerMove={onDragMove}
						onPointerUp={onDragEnd}
						onPointerCancel={onDragEnd}
						onKeyDown={(event) => {
							if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
							event.preventDefault();
							onNudge(index, event.key === "ArrowDown" ? 1 : -1);
						}}
						// 一个安静的记号，不是一颗按钮：它说的是「这一行能拖」。
						className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center text-ink-faint transition-colors hover:text-ink-muted disabled:cursor-default"
					>
						<GripVertical size={13} strokeWidth={1.9} aria-hidden />
					</button>
					<span className="min-w-0 flex-1 truncate text-ink-muted" data-plume-tip={`${entry.preview}\n\n${status}`}>
						{entry.preview}
					</span>
					<div className="flex shrink-0 items-center gap-1 text-ink-faint">
						<IconButton
							size="sm"
							data-queue-now=""
							label={nowLabel}
							onClick={() => onSendNow(entry.id)}
							icon={<CornerDownLeft size={13.5} strokeWidth={1.9} aria-hidden />}
						/>
						<IconButton
							size="sm"
							tone="danger"
							data-queue-remove=""
							label={t("composer.queueRemove")}
							onClick={() => onRemove(entry.id)}
							icon={<Trash2 size={13.5} strokeWidth={1.9} aria-hidden />}
						/>
						{/* 没有插件加项时只剩「编辑」一样，就直接是那一样：一个只装一行的菜单是多点一下。 */}
						{actions.length > 0 ? (
							<IconButton
								size="sm"
								data-queue-more=""
								label={t("composer.queueMore")}
								menu={more.open}
								onClick={more.toggle}
								icon={<MoreHorizontal size={14} strokeWidth={1.9} aria-hidden />}
							/>
						) : (
							<IconButton
								size="sm"
								data-queue-edit=""
								label={t("composer.queueEdit")}
								onClick={() => onEdit(entry.id)}
								icon={<PencilLine size={13.5} strokeWidth={1.9} aria-hidden />}
							/>
						)}
					</div>
				</div>
			</div>
			{more.open && (
				<Popover anchor={more.anchor} onClose={more.close} placement="top" align="end" width="default" label={t("composer.queueMore")}>
					<MenuBody>
						<MenuItem
							icon={<PencilLine size={14} aria-hidden />}
							onClick={() => {
								more.close();
								onEdit(entry.id);
							}}
						>
							{t("composer.queueEdit")}
						</MenuItem>
						{actions.map((action) => (
							<MenuItem
								key={action.key}
								icon={action.icon ? <action.icon size={14} /> : undefined}
								onClick={() => {
									more.close();
									onAction(entry.id, action);
								}}
							>
								{action.label(resolvedLocale)}
							</MenuItem>
						))}
					</MenuBody>
				</Popover>
			)}
		</div>
	);
}
