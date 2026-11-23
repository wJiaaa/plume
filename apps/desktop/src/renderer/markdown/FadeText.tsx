/**
 * 正在输出的一段字，新放出来的字淡入，而不是一个个蹦出来。
 *
 * 只有平滑出字（`useSmoothText`）时，字是匀速了，可每个字仍然是从无到有硬切出来的——看上去就是
 * 在「吐字」。这里给每个新字一个出现的时刻，从透明淡到实色。思路来自 streamdown 的 `StreamTail`。
 *
 * **一段一段地淡，不是一个字一个字地淡。** 和 Claude 桌面版会话窗一样：同一条回复里 `PHRASE` 之内放出来的字
 * 归同一段，共用一个出现时刻，合成一个 span 线性淡入 `FADE`；这段开始后才放出来的字，以这段此刻的透明度出现。
 * 几段相邻的字叠着淡，读起来是一句一句浮现。从前一帧一组、各淡 180ms，每帧都有一小截字从无到有，看上去在吐字；
 * 再往前一个字一个 span，排着队的几百个字各带一个动画，真窗口里量到过一帧 57ms。span 按组里第一个字的序号作
 * key：前面的字并回纯文本时，后面的 span 不会被重建，动画也就不会从头再来。
 *
 * **说完了就收尾。** 写完、最后一个字也放出来的那一刻（`FadeScope.end`）起，还要淡 `RUSH` 以上的字加快，
 * 在 `RUSH` 之内淡完：不然一条回复说完了，最后一段还要再慢慢显 0.4 秒。
 *
 * **只有还在淡的字才是 `<span>`。** 淡完的字并回前面的纯文本，否则一条长回复会攒下几千个 span。
 *
 * **挂上这一刻哪些字该淡，看它们在原文里的位置。** 一段字的实例在流式输出里会新挂上来：新起的一段、
 * 刚收口的加粗、一行变成表格的那一刻。挂上时它身上的字有的早就在屏幕上（表格的表头在变成表格之前
 * 是一段普通的字），有的是刚放出来的。全淡一遍，老字会闪一下；全不淡，新段的头几个字会蹦出来。
 * 所以按位置分：`Markdown` 说原文从第几个字起是最近 `FADE` 内放出来的（`FadeScope`），这段字在
 * 块的原文里找到自己（`BlockScan`），落在那之后的淡入，之前的当作淡完。已经挂着的一段字变长时也按这条，见 `useFade`。
 */

import { createContext, type HTMLAttributes, type ReactNode, useContext, useEffect, useReducer, useRef } from "react";
import { cancelTick, requestTick } from "@plume/ui";
import { FADE, PHRASE, RUSH } from "./stream-pace.ts";

/**
 * 一条回复里各段字共用的淡入状态。`Markdown` 每次画都改这一个对象，不换引用：换了引用，每个 `FadeText` 每帧都要重画。
 *
 * - `from`：这条回复的原文（画出来的那份）从第几个 UTF-16 单元起是最近放出来的。
 * - `phrase`：当前这一段从什么时刻起。各段字在画的时候按它分段，所以整条回复的段是同一套，不是每段字各分各的。
 * - `end`：写完、最后一个字放出来的时刻，还没到就是正无穷。读的时候现取：它在放字的循环里定下，不跟着一次重画。
 */
export const FadeScope = createContext<{ from: number; phrase: number; end: () => number }>({
	from: Number.POSITIVE_INFINITY,
	phrase: Number.NEGATIVE_INFINITY,
	end: () => Number.POSITIVE_INFINITY,
});

/**
 * 正在画的这一块：它的原文、原文在整条回复里的起点，和找到哪了。
 * 每画一次这一块就换一个新的，块里的每段字按文档顺序从 `cursor` 往后找自己，找到就把它挪到自己后面。
 */
export const BlockScan = createContext<{ raw: string; start: number; cursor: number } | null>(null);

export function FadeText({ text }: { text: string }) {
	const chars = Array.from(text);
	const { settled, group, alpha } = useFade(text, chars.length);

	const fading: ReactNode[] = [];
	for (let at = settled; at < chars.length;) {
		const head = group(at);
		let end = at + 1;
		while (end < chars.length && group(end) === head) end++;
		fading.push(
			<span key={head} className="markdown-fade" style={{ opacity: alpha(head) }}>
				{chars.slice(at, end).join("")}
			</span>,
		);
		at = end;
	}
	return (
		<>
			{chars.slice(0, settled).join("")}
			{fading}
		</>
	);
}

/**
 * 一段正在长的字里，每个字什么时候出现：`settled` 之前的已经淡完，画成纯文本；之后的字按
 * `group(序号)` 分组，每组画成一个 span，组头就是 key，透明度是 `alpha(组头)`。`length` 按码点数
 * （`Array.from`），不按 UTF-16；`text` 用来在块的原文里找位置。
 *
 * 代码块也用它：配色切出来的 token 边界随着字长出来会变，但每个字的序号不变，出现时刻就不会乱。
 *
 * **淡入按拍子重画，不交给 CSS 动画。** 动注册过的自定义属性可以不提合成层，
 * 可自定义属性的动画只能在主线程上逐帧算：120Hz 屏上，哪怕正文这一拍没长，
 * 页面也每帧都脏一遍。现在透明度在渲染时按出生时刻算好写进 `style`，还有字在淡就约下一拍
 * （`ticker.ts`）再画一次，和放字、跟随滚动落在同一帧里。仍然不提层：没有动画，就没有合成器要接手的东西。
 */
export function useFade(text: string, length: number): { settled: number; group: (index: number) => number; alpha: (head: number) => number } {
	const scope = useContext(FadeScope);
	const scan = useContext(BlockScan);
	const state = useRef<{ births: number[]; groups: number[] } | null>(null);
	const now = performance.now();
	// 每次画都找一遍、把块的游标往后挪：后面新挂上的一段字要从这里往后找，不然会找到前面某个同样的字。
	const end = locate(scan, text);

	/*
	 * 落在 `scope.from` 之前的字早就放出来了，当作淡完。挂上和变长都按这一条：切回一段正在写的会话时，
	 * 离开期间写下的字是让挂着的这段字变长，而不是新挂上一段——只在挂上时看位置，那一截会整段从透明淡入。
	 * 找不到位置时，挂上那一刻已有的字算淡完，之后长出来的算新字。
	 */
	const first = !state.current;
	state.current ??= { births: [], groups: [] };
	const { births, groups } = state.current;
	if (length < births.length) {
		births.length = length;
		groups.length = length;
	}
	const old = end === null ? (first ? length : 0) : settledCount(text, end - scope.from);
	// 有新字要记、而这一段已经开了 `PHRASE` 以上，就开新的一段。
	if (length > Math.max(births.length, old) && now - scope.phrase >= PHRASE) scope.phrase = now;
	const birth = scope.phrase;
	// 新字归进这一段：上一个字也是这一段的新字，就接在它那组里，否则新起一组，组头是第一个新字。
	const last = births.length - 1;
	const head = last >= 0 && births[last] === birth && groups[last]! >= old ? groups[last]! : Math.max(births.length, old);
	while (births.length < length) {
		const at = births.length;
		births.push(at < old ? now - FADE : birth);
		groups.push(at < old ? at : head);
	}

	// 出现时刻是递增的，所以淡完的字总是连成开头那一段。
	const ending = scope.end();
	let settled = 0;
	while (settled < length && fadeAlpha(births[settled]!, now, ending) >= 1) settled++;

	// 字数一变就重新起一趟：新字是父组件在同一拍里放出来的，这一拍看到的还是旧的出生时刻，
	// 可能以为已经淡完就停了，新来的那组字会停在透明度 0 上。
	useRedrawWhileFading(settled < length, length, () => fadeEnd(state.current?.births.at(-1) ?? 0, scope.end()));

	return { settled, group: (index) => groups[index]!, alpha: (head) => fadeAlpha(births[head]!, now, ending) };
}

/**
 * 挂上时整枚一起淡入：写完才出现的行内代码、公式。和 `useFade` 一样按拍子重画，淡完就摘掉
 * `style`，之后跟着重画也不会再淡一遍。
 *
 * 挂上时要不要淡，和 `useFade` 一样看位置：`text` 是它在原文里的样子（代码的内容、公式的 TeX），在块的原文里
 * 找到它结尾在哪，落在 `scope.from` 之前就是早已放出来的，直接是实色。只看挂上的时刻的话，切进一个正在输出的
 * 会话时整条回复重新挂上，周围的字是实色，每枚行内代码却从透明淡一遍。结尾正好在 `from` 上时，收口的那个
 * 反引号是刚到的，照样淡。找不到位置（没有 `BlockScan`）时按刚出现处理。
 */
export function FadeIn({ as: Tag, text, className, ...rest }: { as: "code" | "span"; text: string } & HTMLAttributes<HTMLElement>) {
	const scope = useContext(FadeScope);
	// 每次画都找一遍：块的游标要越过这一枚，后面的字才不会找到它前面去。
	const end = locate(useContext(BlockScan), text);
	const born = useRef(0);
	if (!born.current) born.current = end !== null && end < scope.from ? performance.now() - FADE : performance.now();
	const alpha = fadeAlpha(born.current, performance.now(), scope.end());
	useRedrawWhileFading(alpha < 1, 0, () => fadeEnd(born.current, scope.end()));
	if (alpha >= 1) return <Tag {...rest} className={className} />;
	return <Tag {...rest} className={className ? `${className} markdown-fade` : "markdown-fade"} style={{ opacity: alpha }} />;
}

/**
 * 还有字在淡时，每拍重画一次，直到最晚出生的那个淡完（`doneAt`，现取：收尾时刻随时会定下来）。自己续拍，
 * 不等渲染完再约。`restart` 变了就重新起一趟。
 */
function useRedrawWhileFading(fading: boolean, restart: number, doneAt: () => number): void {
	const [, redraw] = useReducer((n: number) => n + 1, 0);
	const latest = useRef(doneAt);
	latest.current = doneAt;
	useEffect(() => {
		if (!fading) return;
		let tick = 0;
		const loop = () => {
			redraw();
			if (performance.now() < latest.current()) tick = requestTick(loop);
		};
		tick = requestTick(loop);
		return () => cancelTick(tick);
	}, [fading, restart]);
}

/**
 * `birth` 出现的字在 `now` 的透明度：线性走完 `FADE`。到收尾时刻 `ending` 还要淡 `RUSH` 以上的，从那一刻的透明度起
 * 在 `RUSH` 内线性走到 1。线性而不带缓动：几段叠着淡时，缓动会让每段开头和结尾各停一下，整句的浮现一顿一顿。
 */
function fadeAlpha(birth: number, now: number, ending: number): number {
	let t = (now - birth) / FADE;
	if (now > ending && ending + RUSH < birth + FADE) {
		const reached = Math.max(0, (ending - birth) / FADE);
		t = reached + (1 - reached) * ((now - ending) / RUSH);
	}
	return Math.round(Math.min(1, Math.max(0, t)) * 100) / 100;
}

/** `birth` 出现的字什么时候淡完，见 `fadeAlpha`。 */
function fadeEnd(birth: number, ending: number): number {
	return Math.min(birth + FADE, Math.max(ending, birth) + RUSH);
}

/** `text` 末尾有 `fresh` 个 UTF-16 单元是新的，前面那些旧字有几个码点。不从代理对中间切开。 */
function settledCount(text: string, fresh: number): number {
	let tail = text.length - Math.min(text.length, Math.max(0, fresh));
	const code = text.charCodeAt(tail);
	if (code >= 0xdc00 && code <= 0xdfff) tail--;
	return Array.from(text.slice(0, tail)).length;
}

/**
 * 这段字在整条回复的原文里到哪结束（UTF-16 偏移）。按最后一行找：多行的字（引用、列表项）每行
 * 前面在原文里还带着 `> `、缩进，整段对不上，而要紧的是尾巴——最近放出来的字都在那儿。找不到就
 * 当它紧接在前一段后面。
 */
function locate(scan: { raw: string; start: number; cursor: number } | null, text: string): number | null {
	if (!scan) return null;
	const lastLine = text.slice(text.lastIndexOf("\n") + 1) || text;
	const at = scan.raw.indexOf(lastLine, scan.cursor);
	scan.cursor = at < 0 ? scan.cursor + text.length : at + lastLine.length;
	return scan.start + scan.cursor;
}
