/**
 * 模型的推理，收在一条流水行里。
 *
 * 和它下面那段工具活是同一个骨架（见 `FlowRow`）。行上只写标题，不写推理本身：一段几分钟的推理在那一行上滚个不停，
 * 是整屏最吵的东西，而要看推理的人会点开。运行中是「一个说『在想』的词 · 这段想了几秒」（见 `LiveThought`）；
 * 写完是「思考了 N 秒」。点开是全文。
 */

import { Collapse, FlowRow, Scroller, translate } from "@plume/ui";
import { Brain } from "@plume/ui/icons";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../markdown/Markdown.tsx";
import { LiveThought } from "./LiveThought.tsx";
import { thinkingTail } from "./thinking-ticker.ts";
import { useTranscriptDisclosure } from "./view-state.ts";

export function ThinkingBlock({
	text,
	redacted,
	live,
	startedAt,
	durationMs,
	stateKey,
}: {
	text: string;
	redacted: boolean;
	/** 字还在到：后面还没有别的块。 */
	live?: boolean;
	/** 这段推理开始的时刻，运行中拿它走秒、选词。 */
	startedAt?: number | undefined;
	/** 这段推理想了多久。中途断掉的推理没有。 */
	durationMs?: number | undefined;
	stateKey?: string;
}) {
	const [open, setOpen] = useTranscriptDisclosure(stateKey);
	if (!text && !redacted) return null;
	return (
		<div data-plume-thinking="">
			{/* 运行中不经 `running` 上扫光：换词时滚进来的词被单独合成，外层的扫光裁不到它。光由 `LiveThought` 挂在词自己身上。 */}
			<FlowRow
				icon={<Brain size={13} strokeWidth={1.8} />}
				summary={redacted ? translate("thinking.redacted") : live ? <LiveThought startedAt={startedAt} /> : thoughtFor(durationMs)}
				open={open}
				{...(redacted ? {} : { onToggle: () => setOpen((value) => !value) })}
				label={translate("thinking.process")}
			/>
			{/* 收起后不留子树：留着的话，藏起来的正文照样随每个 token 重排。 */}
			<Collapse open={open && !redacted} bodyClassName="mt-1.5 border-l-2 border-line pl-3">
				<ThinkingBody text={text} live={live === true} />
			</Collapse>
		</div>
	);
}

/**
 * 写完之后的「思考了 N 秒」。秒向下取整，和运行行的计时同一种取法。
 *
 * 不满一秒的不报数：常见的是中转把整段推理一次吐出来，量到的几毫秒不是它想了多久，报一个「1 秒」是一个看着很真的错数。
 */
function thoughtFor(durationMs: number | undefined): string {
	if (durationMs === undefined || durationMs < 1000) return translate("thinking.forAWhile");
	const seconds = Math.floor(durationMs / 1000);
	if (seconds < 60) return translate("thinking.forSeconds", { n: seconds });
	return translate("thinking.forMinutes", { m: Math.floor(seconds / 60), s: seconds % 60 });
}

/**
 * 点开之后的全文，装在一个限高、自己滚动的框里。
 *
 * 还在写的时候只放纯文本的尾巴（见 `thinkingTail`），写完再换成 Markdown。限高对写完的也成立：一段几十屏的推理整个摊开，
 * 会把真正的回复推到很远的地方去。
 *
 * 跟着底部走，用户往上翻了就不跟；从历史里点开的从头读。往上翻的时候窗口的起点也停住（`held`）：不停的话尾巴每前进一步
 * 就从顶上切掉几千字，正在读的那段被抽走。
 */
function ThinkingBody({ text, live }: { text: string; live: boolean }) {
	const viewport = useRef<HTMLDivElement>(null);
	const pinned = useRef(live);
	const [held, setHeld] = useState<number | null>(null);
	const cut = useMemo(() => (live ? thinkingTail(text) : { tail: text, hidden: 0 }), [text, live]);
	const hidden = held !== null && held < cut.hidden ? held : cut.hidden;
	const tail = hidden === cut.hidden ? cut.tail : text.slice(hidden);

	useLayoutEffect(() => {
		const element = viewport.current;
		if (element && pinned.current) element.scrollTop = element.scrollHeight;
	}, [tail, live]);

	return (
		<Scroller
			className="max-h-[min(320px,40vh)]"
			overscroll="auto"
			scrollRef={viewport}
			onScroll={(element) => {
				pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
				if (live && pinned.current !== (held === null)) setHeld(pinned.current ? null : hidden);
			}}
		>
			{live ? (
				<div className="whitespace-pre-wrap break-words text-label text-ink-faint">
					{hidden > 0 && <div className="mb-2 italic">{translate("thinking.earlier", { n: hidden.toLocaleString() })}</div>}
					{tail}
				</div>
			) : (
				<Markdown text={text} className="text-label text-ink-faint" />
			)}
		</Scroller>
	);
}
