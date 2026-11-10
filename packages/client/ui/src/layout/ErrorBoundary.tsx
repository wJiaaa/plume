/**
 * 抛出的错误和一扇灰窗口之间的最后一道。
 *
 * 错误一路没被接住到了根上，React 会卸掉整棵树，于是一个组件抛错就带走整个应用——剩下的只有窗口底色和三个
 * 红绿灯。没有消息、没有栈、没有能做的事；从外面看，它和卡死、构建失败、主进程崩溃分不出来。
 *
 * 它不会让本来不工作的东西工作起来。它让失败读得懂：什么抛的、在哪，以及唯一值得给的那个动作——重新加载
 * 渲染进程。在桌面应用里这是真的恢复：主进程、会话、设置都还活在 IPC 边界的另一边，只有这扇窗口要重建。
 *
 * 用 class，因为 `getDerivedStateFromError` 没有对应的 hook。这是唯一的理由。
 */

import { RotateCw } from "../icons/index.ts";
import { translate } from "../i18n/translate.ts";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { CopyMark } from "./CopyMark.tsx";
import { Disclosure } from "./Disclosure.tsx";

interface State {
	error: Error | null;
	/** React 自己记下的是哪个组件抛的，调用栈不告诉你这个。 */
	componentStack: string | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
	override state: State = { error: null, componentStack: null };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		// 也打到控制台，和前后打出来的东西一起落在开发者工具的日志里。
		console.error("[plume] uncaught render error", error, info.componentStack);
		this.setState({ componentStack: info.componentStack ?? null });
	}

	override render(): ReactNode {
		const { error, componentStack } = this.state;
		if (!error) return this.props.children;

		return (
			<div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-shell px-8">
				<div className="w-full max-w-[560px]">
					<h1 className="text-title font-semibold text-ink">{translate("errorBoundary.title")}</h1>
					<p className="mt-1.5 text-label leading-relaxed text-ink-muted">{translate("errorBoundary.detail")}</p>

					{/*
					 * 原样的消息，等宽、可选中。
					 *
					 * 看着这一屏的人接下来要把它粘到别处去——一个 issue、一段聊天、一个搜索框——转述过的话恰恰是粘不过去的。
					 */}
					<pre className="mt-4 max-h-[180px] overflow-auto rounded-lg border border-danger/35 bg-danger/6 px-3 py-2.5 font-mono text-detail leading-relaxed whitespace-pre-wrap text-danger select-text">
						{error.message || String(error)}
					</pre>

					{/*
					 * 错误自己的调用栈，和组件栈分开两块。
					 *
					 * 组件栈只说「崩在 Conversation 这棵树里」，而那是一个有几十个 useMemo 的组件——
					 * 从它完全看不出是哪一个函数读到了 undefined。真正能定位的是 `error.stack`：即使
					 * 压缩过，chunk 的行列号配 source map 也能还原到具体那一行。
					 *
					 * 只有组件栈的崩溃报告，每次都只能靠猜「大概是转录里缺了一格」，查不到根上。默认展开，
					 * 就是为了让它和组件栈一起被复制。
					 */}
					{error.stack && (
						<div className="mt-2">
							<Disclosure variant="compact" title={translate("errorBoundary.errorStack")} defaultOpen>
								<div className="group/copy relative mt-1">
									<CopyMark text={error.stack.trim()} side="left" />
									<pre className="max-h-[220px] overflow-auto rounded-lg border border-line bg-card/40 py-2.5 pr-3 pl-9 font-mono text-caption leading-relaxed whitespace-pre-wrap text-ink-muted select-text">
										{error.stack.trim()}
									</pre>
								</div>
							</Disclosure>
						</div>
					)}

					{componentStack && (
						<div className="mt-2">
							<Disclosure variant="compact" title={translate("errorBoundary.stack")}>
								{/*
								 * 这一段的下一步一定是粘到别处去，所以角上给一枚复制键。
								 *
								 * 左上角而不是右上角：这一框会横向溢出，右上角那枚会压在最长那几行的字上；
								 * 而左边是每一行的行首，缩进留出来的空白本来就在那儿。`pl-9` 是给它让的位。
								 */}
								<div className="group/copy relative mt-1">
									<CopyMark text={componentStack.trim()} side="left" />
									<pre className="max-h-[220px] overflow-auto rounded-lg border border-line bg-card/40 py-2.5 pr-3 pl-9 font-mono text-caption leading-relaxed whitespace-pre-wrap text-ink-muted select-text">
										{componentStack.trim()}
									</pre>
								</div>
							</Disclosure>
						</div>
					)}

					{/*
					 * 这一行的字顶着左边，和上面的标题、正文、报错框对齐。
					 *
					 * 按钮在话的后面而不是行首：它是这句话的出口（「要重启 dev server」——那就重启给你看），
					 * 排在话前面时，整段说明被它推离了左边缘，页面上于是有两条左边界。
					 */}
					<div className="mt-5 flex items-center gap-1.5">
						{/*
						 * 值得明说，因为开发时它出人意料地经常就是答案：主进程不热重载，按更新的 IPC 形状构建的渲染进程，
						 * 碰上还在用旧形状应答的主进程，就会正好在这里抛错。
						 */}
						<span className="text-detail text-ink-faint">{translate("errorBoundary.devHint")}</span>
						{/*
						 * 没有底色也没有描边。
						 *
						 * 这一屏上唯一该被填实的是那个报错框——它是这一屏的主语。一枚实心按钮压在说明文字
						 * 旁边，读起来像是这句话在催人按它，而它只是「顺手可以重来一次」。
						 */}
						<button
							type="button"
							data-plume-tip={translate("errorBoundary.reload")}
							aria-label={translate("errorBoundary.reload")}
							onClick={() => window.location.reload()}
							className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors duration-[var(--plume-t-quick)] hover:bg-card-hover hover:text-ink"
						>
							<RotateCw size={13} strokeWidth={2} aria-hidden />
						</button>
					</div>
					{/* 组件栈是这一屏里唯一带线索的东西，而它默认是折起来的——得说一句。 */}
					<p className="mt-1.5 text-detail text-ink-faint">{translate("errorBoundary.issueHint")}</p>
				</div>
			</div>
		);
	}
}
