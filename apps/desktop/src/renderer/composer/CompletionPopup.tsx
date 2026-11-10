import { Scroller } from "@plume/ui";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * 输入框和它上面那张补全菜单的关系，给读屏用：输入框是 combobox，菜单开着时指向它和选中的那一行（行的 id 是 `${id}-${序号}`）。
 */
export interface ComboboxState {
	id: string;
	active: number;
	open: boolean;
}

/** 菜单最高这么高；上面的地方不够时让给窗口顶行。 */
const MAX_HEIGHT = 340;
const GAP = 12;

/**
 * 输入框上方的 `/` 菜单：和输入框一样宽，贴着它的上沿往上长。没打字时每组第一行上面写组名；
 * 没有匹配就不画（没有「没有结果」那一行），收起的那一下还画着上一份，不是空白的一张。
 *
 * 焦点一直在输入框里：按下不抢焦点，键盘选中只滚这一张、不滚背后的对话；指针没动不算悬停，滚动时行从指针底下
 * 经过不会把高亮抢走。
 */
export function CompletionPopup<T>({
	id,
	items,
	term,
	active,
	keyboardSelection,
	onPick,
	onHover,
	label,
	keyOf,
	groupOf,
	heading,
	row,
}: {
	id: string;
	items: T[];
	term: string;
	active: number;
	keyboardSelection: boolean;
	onPick: (command: T) => void;
	onHover: (index: number) => void;
	label: string;
	keyOf: (item: T) => string;
	groupOf: (item: T) => string;
	heading: (item: T) => string;
	row: (item: T, index: number, selected: boolean) => { label: string; data: Record<string, string>; content: ReactNode };
}) {
	const panel = useRef<HTMLDivElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const pointer = useRef<{ x: number; y: number } | null>(null);
	const previous = useRef<{ items: T[]; term: string; active: number }>({ items: [], term, active });
	const [height, setHeight] = useState(MAX_HEIGHT);
	const open = items.length > 0;
	const shown = open ? items : previous.current.items;
	const shownTerm = open ? term : previous.current.term;
	const shownActive = open ? active : previous.current.active;
	useLayoutEffect(() => {
		if (open) previous.current = { items, term, active };
	}, [items, term, active, open]);
	useLayoutEffect(() => {
		const anchor = panel.current?.parentElement;
		if (!anchor) return;
		// 往上最多长到窗口顶行的下沿：欢迎页上输入框在窗口中间，头几行不能钻到顶行底下去。
		const screen = anchor.closest<HTMLElement>("[data-screen]");
		const ceiling = () => {
			if (!screen) return 0;
			const row = Number.parseFloat(getComputedStyle(screen).getPropertyValue("--plume-top-row-height")) || 0;
			return screen.getBoundingClientRect().top + row;
		};
		const measure = () => setHeight(Math.max(0, Math.min(MAX_HEIGHT, anchor.getBoundingClientRect().top - ceiling() - GAP)));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(anchor);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [open]);
	useLayoutEffect(() => {
		if (!open || !keyboardSelection) return;
		const viewport = list.current;
		const selected = viewport?.querySelector<HTMLElement>(`[data-index="${active}"]`);
		if (!viewport || !selected) return;
		const box = selected.getBoundingClientRect();
		const view = viewport.getBoundingClientRect();
		if (box.top < view.top + 36) viewport.scrollTop -= view.top + 36 - box.top;
		else if (box.bottom > view.bottom - 48) viewport.scrollTop += box.bottom - view.bottom + 48;
	}, [active, items, open, keyboardSelection]);
	return (
		<div
			ref={panel}
			id={id}
			role={open ? "listbox" : undefined}
			aria-label={label}
			aria-hidden={!open}
			inert={!open}
			data-open={open}
			className="plume-command-menu absolute bottom-full left-0 right-0 z-40 mb-2 overflow-hidden rounded-2xl border border-line-soft bg-float shadow-glass"
		>
			<div style={{ maxHeight: height }} className="flex flex-col">
				<Scroller scrollRef={list} className="min-h-0" contentClassName="p-1.5">
					{shown.map((item, index) => {
						const selected = index === shownActive;
						const { label: spoken, data, content } = row(item, index, selected);
						const first = !shownTerm && (index === 0 || groupOf(item) !== groupOf(shown[index - 1]!));
						return (
							<div key={keyOf(item)}>
								{first && <div className="px-3 pb-1 pt-2 text-detail text-ink-faint">{heading(item)}</div>}
								<button
									id={`${id}-${index}`}
									type="button"
									role={open ? "option" : undefined}
									tabIndex={-1}
									aria-label={spoken}
									aria-selected={selected}
									data-index={index}
									{...data}
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => onPick(item)}
									onMouseMove={(event) => {
										if (pointer.current?.x === event.clientX && pointer.current.y === event.clientY) return;
										pointer.current = { x: event.clientX, y: event.clientY };
										onHover(index);
									}}
									className={`plume-scroll plume-command-option flex h-9 w-full items-center gap-2 rounded-xl px-3 text-left text-label transition-colors ${selected ? "bg-card-hover" : ""}`}
								>
									{content}
								</button>
							</div>
						);
					})}
				</Scroller>
			</div>
		</div>
	);
}
