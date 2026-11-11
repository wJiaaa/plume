/**
 * todo 插件的界面入口：跟着会话的清单卡片（`ui.conversationCard`）。
 *
 * 一长轮下来是一整墙工具调用，最答不上来的就是「还剩多少」。清单在转录里只是一段活里的一行（本体画的「更新清单 3/5」），
 * 马上就被后面的调用埋掉；这张卡片一直在：对话那一列够宽时浮在转录右上角，不够时在输入框正上方。
 * 默认展开整张清单（太长就在卡片里滚），收起时只剩一行「现在在做什么」。清单全勾完了卡片自己收走：做过什么还在转录里。
 * 在做的那一步旁边有它的动作：在跑时暂停，失败了重试这一步，停下了继续。
 *
 * 第三方插件单独构建，产品的 Tailwind 扫不到这里的类名：布局和悬停写在 todo.css，颜色只取 var(--plume-*)。
 */

import type { Message, SessionView } from "@plume/contract";
import type { ConversationCardProps, UiPlugin } from "@plume/contract/ui";
import { ActionSpinner, Caret, IconButton, Scroller, ScrollText, Text, Tooltip, useI18n } from "@plume/ui";
import { Check, ListTodo, Pause, Play, RotateCw } from "@plume/ui/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { fill, MESSAGES } from "./messages.ts";
import todoCss from "./todo.css";
import { latestTodos, type TodoItem } from "./types.ts";

function mountStyles(): void {
	const id = "plume.todo";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = todoCss;
}

/**
 * 「继续」替人说的那几句。前两句和转录底下的「继续」一样；第三句是这一轮干净地收了尾、清单却没做完时说的。
 */
// i18n-exempt：发给模型的文本。
const CARRY_ON_PROMPTS = ["继续，从暂停的地方接着做。", "继续，从中断的地方接着做。", "继续，把清单里没做完的做完。"] as const;

/** 上一轮怎么停的：人按了停、没被要求就停了（退出应用、步数用满）、请求失败，或者做完了（null）。 */
type TurnStop = "user" | "interrupt" | "error" | null;

function howItStopped(session: SessionView): TurnStop {
	const reason = session.summary.stop?.reason;
	if (reason === "aborted") return "user";
	// 被安全策略拦下的是真的结束了：接着做只会被同样地拦一次。
	const last = session.messages.findLast((message) => message.role === "assistant");
	if (last?.role === "assistant" && last.stopReason === "error" && last.failure?.hint === "blocked") return null;
	if (reason === "error") return "error";
	if (reason === "interrupted" || reason === "max_turns" || reason === "stalled") return "interrupt";
	return null;
}

/** 最后一条回复是以出错结束的，不是一段回答。 */
function lastTurnFailed(messages: readonly Message[]): boolean {
	const last = messages.findLast((message) => message.role === "assistant");
	return last?.role === "assistant" && last.stopReason === "error";
}

/**
 * 在做的那一步现在是什么样。清单记的是 agent 打算做什么，不是有没有人还在做：动没动看的是这一轮，不是清单。
 * - `failed`：清单本身没有失败这一态，从上一轮怎么结束的来。分出来是因为给的动作不同：停下的接着做，失败的重试。
 * - `paused`：只有人按了停才算；剩下一项「正在做」之后干净地收了尾不算暂停，是 `idle`。
 */
function stepState(session: SessionView) {
	const running = session.summary.running;
	const stopped = howItStopped(session);
	const failed = !running && lastTurnFailed(session.messages);
	const paused = !running && stopped === "user";
	return { running, stopped, failed, paused, idle: !running && !paused && !failed };
}

type StepState = ReturnType<typeof stepState>;

interface Action {
	icon: typeof Pause;
	label: string;
	run(): void;
}

/** 指针在一步上停够这么久，记号才换成它的动作：扫过去的指针不该把一列记号闪成按钮。 */
const STEP_HOVER_MS = 1000;

function useDelayedOffer(enabled: boolean) {
	const [show, setShow] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const clear = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	};
	useEffect(() => () => clear(), []);
	useEffect(() => {
		if (enabled) return;
		clear();
		setShow(false);
	}, [enabled]);
	return {
		show: enabled && show,
		enter: () => {
			if (!enabled) return;
			clear();
			timer.current = setTimeout(() => setShow(true), STEP_HOVER_MS);
		},
		leave: () => {
			clear();
			setShow(false);
		},
	};
}

function TodoCard({ session, placement, stop, carryOn }: ConversationCardProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	// 默认展开：只看得见当前一步时，「还剩多少、接下来是什么」还得再点一下才知道。
	const [open, setOpen] = useState(true);
	// 按消息记住：输出时视图每一拍都换，消息没变，不用每拍把整段转录再翻一遍。
	const todos = useMemo(() => latestTodos(session.messages), [session.messages]);
	const done = todos.filter((todo) => todo.status === "completed").length;
	if (todos.length === 0 || done === todos.length) return null;

	const state = stepState(session);
	const active = todos.find((todo) => todo.status === "in_progress");
	const pending = todos.length - done - (active ? 1 : 0);
	const unfinished = todos.length - done;
	// 在做的那一步上的动作，也是它的记号要换成的那个。
	const action: Action = state.running
		? { icon: Pause, label: text.pause, run: stop }
		: state.failed
			? { icon: RotateCw, label: text.retryStep, run: () => carryOn(text.retryStepDetail) }
			: { icon: Play, label: text.resume, run: () => carryOn(carryOnPrompt(state.stopped, unfinished) ?? text.resumeDetail) };
	// 没在跑就不说进行时（`activeForm`）：轮次早结束了，屏幕却说它正在做，比不说更糟。停在哪一步用那一步自己的名字。
	const headline = !active
		? text.notStarted
		: state.paused
			? fill(text.pausedAt, { step: active.content })
			: state.running
				? (active.activeForm ?? active.content)
				: fill(text.stalledAt, { step: active.content });

	return (
		<div data-todo-list={placement} className="plume-todo-card" data-placement={placement}>
			{/*
			 * 一行里两个并排的按钮，不是一个套着另一个：收放是铺满整行的一层，在做那一步的动作压在它上面。
			 * 按钮里不能再放按钮，读屏会把整行念成一个名字，暂停就够不着了。行里其余的东西让指针穿过去落到收放那一层。
			 */}
			<div className="plume-scroll plume-todo-head">
				<button
					type="button"
					className="plume-todo-toggle"
					aria-expanded={open}
					aria-label={`${headline} ${done}/${todos.length}`}
					onClick={() => setOpen((value) => !value)}
				/>
				<ListTodo size={13} strokeWidth={1.8} style={{ flexShrink: 0, color: "var(--plume-ink-faint)" }} />
				{/* 这一行写的是现在在做什么，不是「清单」两个字：收起时这一行就是全部。 */}
				<ScrollText text={headline} className="plume-fade-tail plume-todo-grow" />
				<Text size="caption" tone="faint" numeric>
					{done}/{todos.length}
				</Text>
				{/* 不用展开就够得着：想停的那一刻就该停得下，先展开再按是多一步。 */}
				{active && (
					<span className="plume-todo-head-action">
						<IconButton size="xs" label={action.label} icon={<action.icon size={11.5} strokeWidth={2} />} onClick={action.run} />
					</span>
				)}
				<Caret open={open} size={12.5} strokeWidth={1.9} style={{ flexShrink: 0, color: "var(--plume-ink-faint)" }} />
			</div>
			<div className="plume-todo-reveal" data-open={open} aria-hidden={!open}>
				<div className="plume-todo-body">
					<Scroller className="plume-todo-scroll" contentClassName="plume-todo-rows" overscroll={placement === "inline" ? "auto" : "contain"}>
						{todos.map((todo, index) => (
							<Row key={`${index}-${todo.content}`} todo={todo} state={state} labels={text} {...(todo.status === "in_progress" ? { action } : {})} />
						))}
					</Scroller>
				</div>
			</div>
			{!open && pending > 0 && <span className="plume-todo-sr">{fill(text.pending, { n: pending })}</span>}
		</div>
	);
}

/** 这样停下以后「继续」说哪句；`null` 是说不出来，用「继续，从暂停的地方接着做」。 */
function carryOnPrompt(stopped: TurnStop, unfinished: number): (typeof CARRY_ON_PROMPTS)[number] | null {
	if (stopped === "user") return CARRY_ON_PROMPTS[0];
	if (stopped === "error" || stopped === "interrupt") return CARRY_ON_PROMPTS[1];
	return unfinished > 0 ? CARRY_ON_PROMPTS[2] : null;
}

/** 一项。在做的那一步，指针停稳了记号才换成它的动作。 */
function Row({ todo, state, labels, action }: { todo: TodoItem; state: StepState; labels: { failed: string; paused: string }; action?: Action }) {
	const offer = useDelayedOffer(action !== undefined);
	const mark = <Mark todo={todo} state={state} labels={labels} />;
	return (
		<div className="plume-scroll plume-todo-row" onMouseEnter={offer.enter} onMouseLeave={offer.leave}>
			{action ? (
				<Tooltip label={action.label}>
					<button
						type="button"
						className="plume-todo-mark plume-todo-mark-button"
						aria-label={action.label}
						data-step-offer={offer.show ? "on" : "off"}
						onClick={action.run}
					>
						{/* 平时是它的状态，指针停稳了才是动作。 */}
						{offer.show ? <action.icon size={11} strokeWidth={2} /> : mark}
					</button>
				</Tooltip>
			) : (
				mark
			)}
			<Text size="detail" tone={todo.status === "in_progress" ? "default" : todo.status === "completed" ? "faint" : "muted"} className="plume-todo-grow">
				<ScrollText text={todo.content} className="plume-fade-tail" textClassName={todo.status === "completed" ? "plume-todo-done" : ""} />
			</Text>
		</div>
	);
}

/**
 * 一项的记号，都在同一个 13px 的格子里，竖着排成一列。做完是勾；在做的那一步按这一轮的样子：在跑转圈、失败一个红点、
 * 被人停下两道竖线、这一轮收了尾而它没勾上一个强调色的点；还没开始是一圈淡的虚线。
 */
function Mark({ todo, state, labels }: { todo: TodoItem; state: StepState; labels: { failed: string; paused: string } }) {
	if (todo.status === "completed") {
		return (
			<span className="plume-todo-mark" style={{ color: "var(--plume-ok)" }}>
				<Check size={11} strokeWidth={2.4} />
			</span>
		);
	}
	if (todo.status === "in_progress" && state.failed) {
		return (
			<span className="plume-todo-mark" aria-label={labels.failed}>
				<span className="plume-todo-dot" style={{ background: "var(--plume-danger)" }} />
			</span>
		);
	}
	if (todo.status === "in_progress" && state.paused) {
		return (
			<span className="plume-todo-mark plume-todo-bars" aria-label={labels.paused}>
				<span />
				<span />
			</span>
		);
	}
	if (todo.status === "in_progress" && state.idle) {
		return (
			<span className="plume-todo-mark">
				<span className="plume-todo-dot" style={{ background: "var(--plume-accent)" }} />
			</span>
		);
	}
	if (todo.status === "in_progress") {
		return (
			<span className="plume-todo-mark" style={{ color: "var(--plume-accent)" }}>
				<ActionSpinner size={13} />
			</span>
		);
	}
	return (
		<span className="plume-todo-mark" style={{ color: "var(--plume-ink-faint)" }}>
			<svg width={13} height={13} viewBox="0 0 24 24" fill="none" aria-hidden>
				<circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray="5.236 5.236" />
			</svg>
		</span>
	);
}

export default {
	name: "plume.todo",
	apply(ui) {
		mountStyles();
		ui.conversationCard("todo", TodoCard);
	},
} satisfies UiPlugin;
