/**
 * 应用的提示条：一处挂载，一套规则。
 *
 * portal 到 `<body>`、钉在窗口上、盖在所有层上面，居中贴着顶。报错的可能是对话、面板、插件，正文卡片只是三栏里的一栏，
 * 画在它里面的话，面板报的错会被裁在面板边上、被面板盖住。顶上那一条在侧栏开合、面板并排或盖住、窄窗口这几种布局里
 * 都空着，输入框、文件树、编辑器都在它下面；居中是因为谁报的都是同一种东西，不该出现在两个地方。按整个窗口居中，
 * 不随侧栏开合挪位置。
 *
 * 哪些卡片存在全在 `stack.ts`；这里只管画、计时和指针。
 */

import { portal, useI18n } from "@plume/ui";
import { ArrowRight, CircleAlert, FolderOpen, Info, MessageCirclePlus, TriangleAlert, X } from "@plume/ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { revealLabel } from "../files/open-targets.ts";
import { groupNotices, schedule, TOAST_Z, visibleToasts, type Deadline, type ToastGroup } from "./stack.ts";
import { currentNotices, dismissNotice, subscribeNotices } from "./store.ts";

/** 和 styles.css 里 `.plume-toast-out` 的时长一致：动画放完再把卡片拿掉。 */
const LEAVE_MS = 170;

/** 多久看一次表。粗一点无妨：没人看得出一张提示条早走了 200ms。 */
const TICK_MS = 200;

/** 卡片上的操作按钮：22px 见方，强调色。 */
const ACTION = "-my-0.5 grid size-5.5 shrink-0 place-items-center rounded-md text-accent transition-colors hover:bg-accent-dim";

const TONE = {
	info: { Icon: Info, edge: "border-line", mark: "text-ink-faint" },
	warn: { Icon: TriangleAlert, edge: "border-accent/40", mark: "text-accent" },
	error: { Icon: CircleAlert, edge: "border-danger/45", mark: "text-danger" },
} as const;

export function Toaster({
	onInvestigate,
	onOpenSession,
}: {
	/** 把一条错误写成一段草稿，交给一个新对话去查；不发出去，发不发由人定。 */
	onInvestigate?: (message: string) => void;
	/** 跳到卡片说的那个会话；打开了才收起卡片。没给的窗口（会话窗、面板窗）不画这个按钮。 */
	onOpenSession?: (sessionId: string) => Promise<boolean>;
}) {
	const { t } = useI18n();
	const notices = useSyncExternalStore(subscribeNotices, currentNotices);
	const groups = useMemo(() => groupNotices(notices, (key) => t(key)), [notices, t]);
	const shown = useMemo(() => visibleToasts(groups), [groups]);

	/*
	 * 每张卡片的到期时间，加一只读它的表，而不是每张一个定时器。每张一个 `setTimeout` 的话，列表每变一次都得拆了重建，
	 * 而哪里报一声列表就变一次，卡片就这样活到该活的两倍。到期时间是卡片的一个事实，要排程的只有这一下表。
	 */
	const due = useRef(new Map<string, Deadline>());
	/** 指针停在这一摞上时置上：计时停住，长的那条读得完。 */
	const [held, setHeld] = useState(false);
	const heldSince = useRef(0);

	/** 把指针停留的时间还回去：悬停是暂停，不只是推迟。 */
	const release = useCallback(() => {
		const paused = Date.now() - heldSince.current;
		if (heldSince.current > 0 && paused > 0) {
			for (const [key, deadline] of due.current) due.current.set(key, { ...deadline, at: deadline.at + paused });
		}
		heldSince.current = 0;
		setHeld(false);
	}, []);

	const hold = useCallback(() => {
		if (heldSince.current === 0) heldSince.current = Date.now();
		setHeld(true);
	}, []);

	/*
	 * 退场动画放完之前留在屏幕上。提示一关就从列表里拿掉，拿掉的卡片 React 已经卸了，动画无处可放；先标记、后移除，
	 * 动画才有东西可放。
	 */
	const [leaving, setLeaving] = useState<string[]>([]);

	const dismiss = useCallback(
		(group: ToastGroup) => {
			/*
			 * 指针底下那张要卸掉了，卸掉的卡片收不到 `mouseleave`：这一摞会一直停着，之后每一条都在等一次没人做的悬停。
			 * 滑上来停到指针底下的那张会自己再停住它。
			 */
			release();
			setLeaving((current) => (current.includes(group.key) ? current : [...current, group.key]));
			const ids = [...group.ids];
			setTimeout(() => {
				for (const id of ids) dismissNotice(id);
				setLeaving((current) => current.filter((key) => key !== group.key));
			}, LEAVE_MS);
		},
		[release],
	);

	useEffect(() => {
		due.current = schedule(due.current, groups, Date.now());
	}, [groups]);

	useEffect(() => {
		if (groups.length === 0) return;
		const tick = window.setInterval(() => {
			if (held) return;
			const now = Date.now();
			for (const group of groups) {
				const deadline = due.current.get(group.key);
				if (deadline !== undefined && deadline.at <= now) dismiss(group);
			}
		}, TICK_MS);
		return () => window.clearInterval(tick);
	}, [groups, held, dismiss]);

	if (shown.length === 0) return null;

	return portal(
		/* 这一列不接指针，只有卡片本身接；`no-drag` 防着它长进标题栏那一条时点不到。 */
		<div
			data-plume-toaster=""
			style={{ zIndex: TOAST_Z }}
			className="[app-region:no-drag] pointer-events-none fixed inset-x-0 top-[52px] flex flex-col items-center gap-2 px-4"
		>
			{shown.map((group) => {
				const tone = TONE[group.level];
				const openSession = group.sessionId && onOpenSession ? onOpenSession : undefined;
				/*
				 * 只在错误上，每张最多一个。警告多半是已经明白的事（磁盘满了、分支往前走了），每条旁边都挂一个「问问看」
				 * 就成了没人按的按钮；错误才是人下一步想要一个解释的时候。
				 */
				const investigate = group.level === "error" && !group.sessionId ? onInvestigate : undefined;
				const hasAction = Boolean(openSession || group.reveal || investigate);
				return (
					<div
						key={group.key}
						/* 出错的用 `alert`，其余用 `status`：差别在于读屏要不要打断正在念的东西。 */
						role={group.level === "error" ? "alert" : "status"}
						onMouseEnter={hold}
						onMouseLeave={release}
						onFocusCapture={hold}
						onBlurCapture={release}
						/*
						 * 不透明的浮层底，浅色深色都由主题自己的 token 算出来，不是叠在背后东西上的一层色。行高定在 18px：
						 * 图标和按钮都按这一行对齐，换行时也对第一行。带操作时右边收窄，图标按钮自带的留白补上那一截。
						 */
						className={`group relative pointer-events-auto flex max-w-[min(560px,calc(100vw-3rem))] items-start gap-2.5 rounded-xl border bg-float py-2 pl-3 text-detail leading-4.5 text-ink shadow-toast ${
							hasAction ? "pr-1.75" : "pr-3"
						} ${leaving.includes(group.key) ? "plume-toast-out" : "plume-toast-in"} ${tone.edge}`}
					>
						{/* 颜色在记号上，不在字上：一段红字压在粉底上是说「出错了」最难读的写法。 */}
						<tone.Icon size={14} strokeWidth={2} className={`mt-0.5 shrink-0 ${tone.mark}`} />
						<span className="min-w-0 flex-1 break-words">
							{group.message}
							{/* 怎么办，比发生了什么退后一步：失败是主语，办法是参考。只有认得出的才有，见 `explain`。 */}
							{group.hint && <span className="block pt-0.5 text-caption leading-4 text-ink-faint">{group.hint}</span>}
						</span>
						{/* 同一句话说一次带个数，而不是同一张卡片叠三张。 */}
						{group.ids.length > 1 && (
							<span className="mt-px shrink-0 rounded-full bg-card-hover px-1.5 text-caption leading-4 text-ink-muted tabular-nums">×{group.ids.length}</span>
						)}
						{/*
						 * 操作只画图标、统一用强调色：× 平时不在，右边这一个就是这张卡片能做的事，一眼认得出来。
						 * `-my-0.5` 让 22px 的按钮不撑高 18px 的那一行。
						 */}
						{openSession && (
							<button
								type="button"
								onClick={() => {
									if (group.sessionId)
										void openSession(group.sessionId).then((opened) => {
											if (opened) dismiss(group);
										});
								}}
								className={ACTION}
								data-plume-tip={t("toaster.goToSession")}
								aria-label={t("toaster.goToSession")}
							>
								<ArrowRight size={14} strokeWidth={2} aria-hidden />
							</button>
						)}
						{/* 刚写到磁盘上的文件：在访达 / 资源管理器里指给人看。 */}
						{group.reveal && (
							<button
								type="button"
								onClick={() => {
									if (group.reveal) void window.plume.files.reveal(group.reveal);
									dismiss(group);
								}}
								className={ACTION}
								data-plume-tip={revealLabel()}
								aria-label={revealLabel()}
							>
								<FolderOpen size={14} strokeWidth={2} aria-hidden />
							</button>
						)}
						{investigate && (
							<button
								type="button"
								onClick={() => {
									investigate(group.message);
									dismiss(group);
								}}
								className={ACTION}
								data-plume-tip={t("toaster.newSessionToDebug")}
								aria-label={t("toaster.newSessionToDebug")}
							>
								<MessageCirclePlus size={14} strokeWidth={2} aria-hidden />
							</button>
						)}
						{/*
						 * 关闭平时不占位置：提示条会自己走，常驻的 × 只是右边又一个小记号。指针停上来或键盘进到卡片里时
						 * 浮在左上角，键盘和读屏一直够得着。
						 */}
						<button
							type="button"
							onClick={() => dismiss(group)}
							className="absolute -top-[7px] -left-[7px] grid size-4.5 scale-85 place-items-center rounded-full border border-line bg-float text-ink-muted opacity-0 shadow-knob transition-[opacity,scale,color] ease-out group-focus-within:scale-100 group-focus-within:opacity-100 group-hover:scale-100 group-hover:opacity-100 hover:text-ink"
							data-plume-tip={t("common.close")}
							aria-label={t("common.close")}
						>
							<X size={10} strokeWidth={2} aria-hidden />
						</button>
					</div>
				);
			})}
		</div>,
	);
}
