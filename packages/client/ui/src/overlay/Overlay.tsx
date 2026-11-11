import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { dismissHoverLayers } from "./hover-layers.ts";
import { portal } from "./portal.ts";
import { holdScrim } from "./scrims.ts";

/**
 * 遮罩的黑有多浓，和 `overlay.css` 里 `.plume-scrim-in` 画的一致——两者必须对上，因为遮罩在的时候，
 * 窗口自己的按钮就是按这个压暗的（见 `scrims.ts`）。
 */
export const SCRIM_ALPHA = 0.22;

export const OverlayDepth = createContext(0);
/** 播完退场，再运行 `after`——没有别的要做时运行 `onClose`。 */
export type Dismiss = (after?: () => void) => void;

/**
 * 元素这一帧画在哪，作为它退场的起点样式。
 *
 * 退场没有 `from`：从元素自己的样式开始，而这里让那个样式就是屏幕上的这一帧。写死 `from` 的话，
 * 在入场途中被关掉的对话框会先跳回完全不透明、停稳了再淡出——窄屏上从底部升起的面板也会先弹到
 * 升起的顶点再滑回去。
 */
function drawnNow(element: HTMLElement | null): React.CSSProperties {
	if (!element) return {};
	const now = getComputedStyle(element);
	return { opacity: now.opacity, transform: now.transform === "none" ? undefined : now.transform };
}

/** Escape、点遮罩、取消和完成共用一套生命周期，嵌套的对话框也一样。 */
export function Overlay({
	children,
	onClose,
	width = 460,
	label,
	returnFocus,
}: {
	children: React.ReactNode | ((dismiss: Dismiss) => React.ReactNode);
	onClose: () => void;
	width?: number;
	label?: string;
	returnFocus?: HTMLElement;
}) {
	const depth = useContext(OverlayDepth) + 1;
	const id = useId();
	const card = useRef<HTMLDivElement>(null);
	const scrim = useRef<HTMLDivElement>(null);
	const callback = useRef(onClose);
	callback.current = onClose;
	const dismissed = useRef(false);
	const completion = useRef<(() => void) | null>(null);
	const [leaving, setLeaving] = useState(false);
	const [exitFrom, setExitFrom] = useState<{ scrim: React.CSSProperties; card: React.CSSProperties }>({ scrim: {}, card: {} });
	const dismiss = useCallback<Dismiss>((after) => {
		if (dismissed.current) return;
		dismissed.current = true;
		completion.current = after ?? (() => callback.current());
		setExitFrom({ scrim: drawnNow(scrim.current), card: drawnNow(card.current) });
		setLeaving(true);
	}, []);
	/*
	 * 已经给出的回答不会因为卸载而撤回。
	 *
	 * 完成回调在 `animationend` 时运行，而那一帧只有在它还在屏幕上时才会来——所以任何在退场途中把
	 * 对话框拿走的东西，都会悄悄取消刚刚确认的事。这不是假设：从菜单里弹出的确认框由菜单渲染，按下落在
	 * 菜单外面 120ms 后菜单关掉自己，而这里的退场要 130ms。十毫秒决定了「确认切换」有没有换掉模型，
	 * 答案是没有。
	 *
	 * 菜单那边本身也值得修——见 `Popover` 里的 `data-plume-overlay`——但一个依赖于没人卸载许诺者的
	 * 许诺，不管是谁来卸载，形状都是错的。
	 */
	useEffect(
		() => () => {
			const complete = completion.current;
			completion.current = null;
			complete?.();
		},
		[],
	);
	/*
	 * 清掉指针叫出来的东西，一次——见 `hover-layers`。
	 *
	 * 特意只清此刻屏幕上的。遮罩盖住整个窗口，底下引不出新的东西，持续的声明什么也买不到；代价却是这个
	 * 对话框自己的提示，而对话框里满是提示。要清的是已经在的提示或悬停卡片：两者都画在遮罩上面，只有
	 * 按下才会拿走它们。从键盘打开对话框不是按下，于是一张悬停卡片会盖在询问要不要删除它所描述的那个
	 * 会话的确认框上。
	 */
	useLayoutEffect(() => dismissHoverLayers(), []);
	/*
	 * 标题栏里系统自己的按钮跟着遮罩变暗，并在遮罩开始离开时就变亮，而不是等它走完——和页面开始变亮
	 * 是同一刻。
	 */
	useEffect(() => (leaving ? undefined : holdScrim("#000000", SCRIM_ALPHA)), [leaving]);
	useLayoutEffect(() => {
		const previous = returnFocus ?? document.activeElement;
		const element = card.current;
		if (!element) return;
		const heading = element.querySelector("h1,h2,h3,[data-dialog-title]");
		if (heading && !label) {
			heading.id ||= `${id}-title`;
			element.setAttribute("aria-labelledby", heading.id);
		}
		if (!element.contains(document.activeElement)) {
			const target = element.querySelector<HTMLElement>('[autofocus],button,input,textarea,select,[tabindex="0"]');
			const bounds = element.getBoundingClientRect();
			const rect = target?.getBoundingClientRect();
			// 短对话框停在标题，不直接滚到屏幕外的某个按钮上。
			(target && rect && rect.top >= bounds.top && rect.bottom <= bounds.bottom ? target : element).focus({ preventScroll: true });
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || [...document.querySelectorAll("[data-plume-modal]")].at(-1) !== element) return;
			if (event.key === "Escape") {
				event.preventDefault();
				dismiss();
			}
			if (event.key !== "Tab") return;
			const targets = [
				...element.querySelectorAll<HTMLElement>(
					'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
				),
			].filter((el) => el.checkVisibility({ visibilityProperty: true }));
			if (!targets.length) {
				event.preventDefault();
				element.focus();
				return;
			}
			const first = targets[0],
				last = targets.at(-1);
			if (document.activeElement === element) {
				event.preventDefault();
				(event.shiftKey ? last : first)?.focus();
			} else if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
		};
	}, [dismiss, id, label, returnFocus]);
	return portal(
		<OverlayDepth.Provider value={depth}>
			{/*
			 * 写在遮罩上，不只是卡片上：这个模态框在第几层，给底下判断一次按下是否落在自己外面的东西用。
			 * 弹出这个对话框的菜单，不能把点在它上面——或点在它铺满一切的遮罩上——当成点在别处。见
			 * `Popover` 里点外面的判断。
			 *
			 * 整个遮罩都是 `no-drag`：窗口顶上那一条是拖动区，拖动区会在页面看到之前先拿走按下，不管上面
			 * 画着什么。在 Windows 11 上，点那里的遮罩关不掉对话框——系统当它是点了标题栏——双击还会把
			 * 问题后面的窗口最大化。模态框开着的时候，后面本来也没有可以拿来拖动窗口的东西。
			 */}
			<div
				ref={scrim}
				data-plume-overlay={depth}
				className={`[app-region:no-drag] fixed inset-0 flex justify-center p-4 sm:p-8 items-center ${leaving ? "plume-scrim-out" : "plume-scrim-in"}`}
				style={{ zIndex: 60 + depth * 20, ...exitFrom.scrim }}
				onMouseDown={(event) => {
					if (event.target === event.currentTarget) dismiss();
				}}
			>
				<div
					ref={card}
					data-plume-modal
					role="dialog"
					aria-modal="true"
					aria-label={label}
					tabIndex={-1}
					style={{ width, maxWidth: "100%", ...exitFrom.card }}
					className={`plume-dialog-surface flex max-h-[85dvh] min-h-0 flex-col overflow-hidden rounded-2xl border border-line-float bg-float outline-none ${leaving ? "plume-dialog-out" : "plume-dialog-in"}`}
					onAnimationEnd={(event) => {
						if (event.target !== event.currentTarget || !leaving) return;
						const complete = completion.current;
						completion.current = null;
						complete?.();
					}}
				>
					{typeof children === "function" ? children(dismiss) : children}
				</div>
			</div>
		</OverlayDepth.Provider>,
	);
}
