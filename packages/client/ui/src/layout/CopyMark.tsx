/**
 * 一枚贴在框角上的复制键，鼠标进来才出现。
 *
 * 给那些「内容本身就是要拿去别处用」的框：一段报错、一份组件栈、一块代码。这些东西的下一步几乎
 * 总是粘贴到别的地方去，而手动框选一段会滚动的等宽文本是这件事里最容易出错的一步——选多了、选少
 * 了、漏了最后一行，而漏掉的那一行往往正是有用的那一行。
 *
 * 平时不画：一个常驻的按钮压在内容上，每一次阅读都要绕过它一次。鼠标进了这个框才是「打算对它做
 * 点什么」的时刻，那时它再出现。
 *
 * 按下之后变成一个对钩，一秒多之后变回来（`useCopied`）。
 *
 * 用它的框自己要是 `relative` 且带 `group/copy`，并且给这一角留出位置（内容那侧补内边距），
 * 否则它会压在第一行字上。
 */

import { Check, Copy } from "../icons/index.ts";
import { useCopied } from "../hooks/useCopied.ts";
import { translate } from "../i18n/translate.ts";

export function CopyMark({ text, side = "right" }: { text: string; side?: "left" | "right" }) {
	const { copied, mark } = useCopied();

	return (
		<button
			type="button"
			data-plume-tip={translate(copied ? "common.copied" : "common.copy")}
			aria-label={translate("common.copy")}
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => mark(true));
			}}
			className={`absolute top-1.5 z-[1] grid h-6 w-6 place-items-center rounded-lg text-ink-faint opacity-0 transition-[opacity,color,background-color] duration-[var(--plume-t-quick)] group-hover/copy:opacity-100 hover:bg-card-hover hover:text-ink focus-visible:opacity-100 ${
				side === "left" ? "left-1.5" : "right-1.5"
			}`}
		>
			{copied ? <Check size={13} strokeWidth={2.2} className="text-ok" /> : <Copy size={13} strokeWidth={1.9} />}
		</button>
	);
}
