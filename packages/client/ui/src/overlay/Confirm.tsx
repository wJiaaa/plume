/**
 * 在拿不回来的事情之前先问一句。
 *
 * 应用里很多东西一次点击就删掉了——插件的目录、模型、MCP 服务、文件、整个会话——而每一个都离你本来
 * 就要点的某个控件只有一次点击的距离。
 *
 * 它们共用一个样子，居中在窗口上、压着遮罩。如果锚在弹出它的控件上（理由是按钮和问题之间的联系值得
 * 保留），实际会在应用的每个角落得到不同的答案：这里是挂在菜单上的卡片，那里是指针旁的卡片，在全屏
 * 打开的面板里，问题出现在那一行碰巧在的位置而不是你正看着的地方。一个让一切停下来的问题就该长成
 * 那个样子，而模态框只有一个该在的地方。
 *
 * 两个入口，一个样子，一个位置：
 *
 *   - `useConfirmer()` 给满是删除按钮的页面——包住处理函数，`element` 渲染一次；
 *   - `useConfirmGate()` 给要在循环里等回答的地方。
 *
 * 只用于撤销不了的事。归档、停用、取消置顶都能自己放回去，在这些上面确认，等于教人对真正要紧的那些
 * 也一路点过去。
 */

import { translate } from "../i18n/translate.ts";
import { useCallback, useEffect, useRef, useState } from "react";

import { CircleHelp, TriangleAlert } from "../icons/index.ts";
import { Overlay } from "./Overlay.tsx";
import { DialogAction, DialogFrame } from "./Dialog.tsx";

/** 窄到读起来是一个问题，而不是一张表单。 */
const CONFIRM_WIDTH = 400;

export interface ConfirmOptions {
	/** 问题，说出是哪个东西。「卸载 Chrome？」——而不是「确定吗？」。 */
	title: string;
	/** 代价是什么，一行。标题已经说全了就省掉。 */
	detail?: React.ReactNode;
	/** 动词，写在做这件事的按钮上。 */
	confirmLabel: string;
	/** 取消按钮上的字，默认「取消」。 */
	cancelLabel?: string;
	/**
	 * `danger` 是默认，因为这个东西本来是给删除用的。
	 *
	 * `normal` 留给另一类问题：不是「这个删了拿不回来」，而是「以后要不要自动做这件事」。
	 * 两种都该停下一切来问，但只有前一种该是红的——把每个问题都画成危险，等于没画过危险。
	 */
	tone?: "danger" | "normal";
	onConfirm: () => void;
	/**
	 * 取消也要做点什么的时候。
	 *
	 * 绝大多数确认框的取消就是「什么都别发生」，所以这是可选的。但有一种问题不是这样：
	 * 「以后要不要自动做这件事」——那里的取消是一个回答（不要），把它当成没问过，
	 * 意思就是下次还问。
	 */
	onCancel?: () => void;
	/**
	 * 同一个动词的另一种做法，比如「删除此会话」旁边的「删除 3 个会话」。
	 *
	 * 画成次要按钮，放在主按钮左边；有它的时候「取消」挪到最左，三颗按钮不挤成一排。
	 */
	alternate?: { label: string; onConfirm: () => void };
	/** 说明和按钮之间的那一块，比如「不再询问」。大多数问题用不着。 */
	children?: React.ReactNode;
}

/**
 * 问题，和两条出路。
 *
 * 焦点特意放在取消上：这个面之所以存在，是因为一件不可逆的事只差一次点击，把键盘放在不可逆的那一半上
 * 等于把问题原样还回去。
 */
export function ConfirmBody({
	title,
	detail,
	confirmLabel,
	cancelLabel,
	tone = "danger",
	onConfirm,
	onCancel,
	alternate,
	children,
}: ConfirmOptions & { onCancel: () => void }) {
	const cancel = <DialogAction onClick={onCancel}>{cancelLabel ?? translate("common.cancel")}</DialogAction>;
	return (
		<DialogFrame
			icon={tone === "danger" ? <TriangleAlert size={20} className="shrink-0 text-danger" /> : <CircleHelp size={20} className="shrink-0 text-accent" />}
			title={title}
			detail={detail}
			status={children}
			actions={
				<>
					{/*
					 * 动词写在按钮上，不挂在 tooltip 上。
					 *
					 * 这里曾经是一个叉一个勾，理由是「是/否由标题负责」。标题确实问清了问题，但两颗
					 * 图标没有回答它：✓ 的意思由它旁边那行字决定，而删除、卸载、清空、退出登录这几
					 * 件事在同一个勾上长得一模一样。要读出按下去会发生什么，得先把鼠标停上去等一个
					 * tooltip——而这正是一个「停下一切来问」的界面最不该要求的动作。
					 *
					 * 这也是应用里其它对话框的样子，同一套 `DialogAction`。
					 */}
					{alternate && cancel}
					<div className="flex-1" />
					{alternate ? <DialogAction onClick={alternate.onConfirm}>{alternate.label}</DialogAction> : cancel}
					<DialogAction tone={tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>
						{confirmLabel}
					</DialogAction>
				</>
			}
		/>
	);
}

/**
 * 放在应用模态面上的问题：居中、压着遮罩、Escape 或点遮罩关掉。
 *
 * 这三样都由 `Overlay` 提供，而且和应用里其它对话框拿到的方式一样——这正是通过它来问、而不是在每个
 * 调用处各拼一个的意义。
 */
export function Confirm({ onCancel, ...options }: ConfirmOptions & { onCancel: () => void }) {
	return (
		// Escape 和点遮罩与「取消」按钮是一个意思，所以用同一个处理函数。
		<Overlay onClose={onCancel} width={CONFIRM_WIDTH}>
			{(dismiss) => (
				<ConfirmBody
					{...options}
					onConfirm={() => dismiss(options.onConfirm)}
					alternate={options.alternate && { label: options.alternate.label, onConfirm: () => dismiss(options.alternate!.onConfirm) }}
					onCancel={() => dismiss()}
				/>
			)}
		</Overlay>
	);
}

/**
 * 给满是删除按钮的页面用的一个确认。
 *
 * 每颗按钮交出自己的问题和自己的后果；面、两颗按钮的措辞、取消是安全的那个，这些在这里定。否则一个
 * 有六行可删除内容的页面要带着同一份状态的六个副本。
 */
export function useConfirmer() {
	const [pending, setPending] = useState<ConfirmOptions | null>(null);

	return {
		/** 从会删除东西的那颗按钮的点击处理里调用。 */
		ask: useCallback((options: ConfirmOptions) => setPending(options), []),
		/** 在组件里任意位置渲染一次。 */
		element: pending ? (
			<Confirm
				title={pending.title}
				detail={pending.detail}
				confirmLabel={pending.confirmLabel}
				cancelLabel={pending.cancelLabel}
				tone={pending.tone}
				onConfirm={() => {
					setPending(null);
					pending.onConfirm();
				}}
				alternate={
					pending.alternate && {
						label: pending.alternate.label,
						onConfirm: () => {
							setPending(null);
							pending.alternate!.onConfirm();
						},
					}
				}
				/* 取消也可能是一个回答——见 `onCancel` 上的说明。 */
				onCancel={() => {
					setPending(null);
					pending.onCancel?.();
				}}
			>
				{pending.children}
			</Confirm>
		) : null,
	};
}

/**
 * 同一个问题，可以 await。
 *
 * 给在循环里问的调用方——粘贴五个文件，其中两个重名——回答得先回来，下一步才能定。写成 promise，
 * 读起来就是普通的顺序代码，而不是每个分支一个回调。
 */
export function useConfirmGate() {
	const [pending, setPending] = useState<(ConfirmOptions & { settle: (answer: boolean) => void }) | null>(null);

	/*
	 * 没回答的问题不能活得比组件长，否则它的 `await` 永远不返回。
	 *
	 * 推迟一个微任务，全部就在这里。React 从上往下拆树，所以这个清理在更下面的 `Overlay` *之前*运行——
	 * 而 Overlay 握着已经给出的回答：确认按钮一按下就交出回调，从那时到它运行之间只隔着退场动画。在这里
	 * 同步地 settle `false` 会越过这一层，把一次「删除」的按下记成取消。什么都没删，也没有任何东西说
	 * 为什么。
	 *
	 * 树里每个清理都是同步的，所以一个微任务就足以排在最后。已经 settle 的 promise 会忽略第二个回答，
	 * 这正是想要的优先级：给出的回答胜过没给出时的默认值。
	 */
	const live = useRef(pending);
	live.current = pending;
	useEffect(
		() => () => {
			const unanswered = live.current;
			if (unanswered) queueMicrotask(() => unanswered.settle(false));
		},
		[],
	);

	const ask = useCallback(
		(options: Omit<ConfirmOptions, "onConfirm">): Promise<boolean> =>
			new Promise<boolean>((resolve) => {
				setPending({
					...options,
					onConfirm: () => {},
					settle: (answer) => {
						setPending(null);
						resolve(answer);
					},
				});
			}),
		[],
	);

	return {
		ask,
		element: pending ? (
			<Confirm
				title={pending.title}
				detail={pending.detail}
				confirmLabel={pending.confirmLabel}
				onConfirm={() => pending.settle(true)}
				onCancel={() => pending.settle(false)}
			/>
		) : null,
	};
}
