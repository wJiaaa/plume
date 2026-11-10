/**
 * 命令面板：侧栏顶上那颗放大镜打开的弹窗。会话和命令在同一个框里找。
 *
 * 以前是在侧栏里展开一个输入框，再把项目列表整个换成一列扁平的结果——那块地方只有侧栏那么宽，
 * 开关一次整栏都换掉，看上去像侧栏自己重排了。挪进弹窗以后列表原地不动；既然已经是一个浮在上面
 * 的框，能找的就不止会话：新对话、面板、主题、设置项都在这里，名字和快捷键与它们原来的入口一致。
 * 有哪些命令见 `应用的现有入口`，怎么排见 `sidebar/palette`。
 *
 * 焦点一直留在输入框里，方向键移动的是 `aria-activedescendant` 指着的那一行，和地址栏的建议列表
 * 同一个做法（`browser/AddressBar`）。
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n, Input, acceleratorLabel, Overlay, Scroller, ScrollText } from "@plume/ui";
import { Check, Search } from "@plume/ui/icons";
import { rankEntries, scoreEntry, type PaletteEntry } from "./palette.ts";

export interface PaletteCommand extends PaletteEntry {
	id: string;
	icon?: ReactNode;
	meta?: string;
	shortcut?: string;
	checked?: boolean;
	run(): void;
}
export interface PaletteGroup {
	key: string;
	label: string;
	commands: PaletteCommand[];
	onQuery?: boolean;
}

/** 打了字以后每组最多列多少条。再往后的靠多打几个字，一组几百行没人会往下翻。 */
const LIMIT = 50;

export function CommandPalette({ onClose, sessions, groups }: { onClose: () => void; sessions: PaletteGroup; groups: PaletteGroup[] }) {
	const { t } = useI18n();
	const recent = useMemo(() => ({ ...sessions, key: "recent", label: t("palette.recent"), commands: sessions.commands.slice(0, 6) }), [sessions, t]);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const listId = useId();
	const list = useRef<HTMLDivElement>(null);

	/*
	 * 空着时：最近几条会话，再是常用命令。打了字：每组各自排序，组和组之间按各自最好的那一条排——
	 * 打「终端」时终端面板整个名字对上，就该排在标题里恰好提到终端的会话前面；打会话标题时反过来。
	 * 分数一样就按组原来的先后。
	 */
	const visible = useMemo((): PaletteGroup[] => {
		const needle = query.trim();
		if (!needle) return [recent, ...groups.filter((group) => !group.onQuery)].filter((group) => group.commands.length);
		return [sessions, ...groups]
			.map((group, order) => {
				const commands = rankEntries(group.commands, needle).slice(0, LIMIT);
				return { group: { ...group, commands }, order, best: commands[0] ? (scoreEntry(commands[0], needle) ?? 0) : -1 };
			})
			.filter((entry) => entry.group.commands.length)
			.sort((a, b) => b.best - a.best || a.order - b.order)
			.map((entry) => entry.group);
	}, [query, recent, sessions, groups]);
	const rows = useMemo(() => visible.flatMap((group) => group.commands), [visible]);
	const index = Math.min(active, rows.length - 1);

	useEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [index, rows]);

	return (
		<Overlay onClose={onClose} width={560} label={t("sidebar.search")}>
			{(dismiss) => {
				const choose = (command: PaletteCommand) => {
					dismiss(() => {
						onClose();
						command.run();
					});
				};
				return (
					<div className="flex min-h-0 flex-col">
						{/* 输入框就是标题栏，不再套一层框，也不在它和结果之间画线：下面的列表滚动时自己会淡出。 */}
						<div className="flex h-[52px] shrink-0 items-center gap-2.5 px-5">
							<Search size={15} strokeWidth={1.9} className="shrink-0 text-ink-faint" aria-hidden />
							{/*
							 * 不写 `autoFocus`：React 会在 Overlay 记下「关掉以后焦点还给谁」之前就把焦点交给它，
							 * 记下的就成了这个输入框自己，关掉后焦点掉到 body 上。Overlay 自己会聚焦第一个输入框。
							 */}
							<Input
								role="combobox"
								aria-expanded
								aria-controls={listId}
								aria-autocomplete="list"
								aria-activedescendant={rows.length ? `${listId}-${index}` : undefined}
								value={query}
								spellCheck={false}
								placeholder={t("sidebar.searchPlaceholder")}
								onChange={(event) => {
									setQuery(event.target.value);
									setActive(0);
								}}
								onKeyDown={(event) => {
									if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length) {
										event.preventDefault();
										setActive((index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
									} else if (event.key === "Enter" && rows[index]) {
										event.preventDefault();
										choose(rows[index]);
									}
								}}
								className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-faint"
							/>
						</div>
						{/*
						 * 高度固定，不随结果多少伸缩：弹窗是居中的，结果一变少卡片就缩，输入框跟着往下跳，
						 * 正在打字的那一行在眼皮底下挪位置。
						 */}
						<Scroller className="h-[min(420px,55dvh)]" contentClassName="px-2.5 pb-2.5">
							<div ref={list} id={listId} role="listbox" aria-label={t("sidebar.search")}>
								{rows.length === 0 && <p className="px-2.5 py-6 text-center text-detail text-ink-faint">{t("palette.noMatches")}</p>}
								{visible.map((group) => (
									<div key={group.key} role="group" aria-label={group.label}>
										<div className="flex h-[28px] items-center px-2.5 text-detail text-ink-faint" aria-hidden>
											{group.label}
										</div>
										{group.commands.map((command) => {
											const position = rows.indexOf(command);
											const selected = position === index;
											return (
												<div
													key={command.id}
													id={`${listId}-${position}`}
													role="option"
													tabIndex={-1}
													aria-selected={selected}
													aria-checked={command.checked}
													data-plume-palette-item={command.id}
													// 焦点留在输入框里：先失焦会让这一行在 click 之前就被重渲染掉。
													onMouseDown={(event) => event.preventDefault()}
													// 指针和方向键共用一个高亮，不然两行同时亮着，看不出回车会执行哪个。
													onMouseMove={() => setActive(position)}
													onClick={() => choose(command)}
													className={`plume-scroll flex h-[var(--plume-menu-row)] cursor-default items-center gap-2.5 rounded-item px-2.5 text-label text-ink ${
														selected ? "bg-card-hover" : ""
													}`}
												>
													{/*
													 * 没有图标就不留这一格：会话标题和组名对齐，空出一列图标位只会让一排标题看上去缩进了。
													 * 同一组里要么都有、要么都没有，所以不会一组里参差。
													 */}
													{command.icon && (
														<span className="flex w-[18px] shrink-0 items-center justify-center text-ink-muted" aria-hidden>
															{command.icon}
														</span>
													)}
													<ScrollText text={command.label} className="plume-fade-tail min-w-0 flex-1" />
													{command.meta && <span className="max-w-[40%] shrink-0 truncate text-caption text-ink-faint">{command.meta}</span>}
													{command.shortcut && <span className="shrink-0 text-detail text-ink-faint">{acceleratorLabel(command.shortcut)}</span>}
													{command.checked && <Check size={14} strokeWidth={2.2} className="shrink-0 text-ink" aria-hidden />}
												</div>
											);
										})}
									</div>
								))}
							</div>
						</Scroller>
					</div>
				);
			}}
		</Overlay>
	);
}
