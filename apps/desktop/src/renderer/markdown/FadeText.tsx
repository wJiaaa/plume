/**
 * 正在输出的一段字，新放出来的字淡入，而不是一个个蹦出来。
 *
 * 只有平滑出字（`useSmoothText`）时，字是匀速了，可每个字仍然是从无到有硬切出来的——看上去就是
 * 在「吐字」。这里给每个新字一个出现的时刻，从透明淡到实色。思路来自 streamdown 的 `StreamTail`。
 *
 * **同一帧放出来的字合成一个 span 一起淡入。** 从前一个字一个 span、各错开几毫秒，排着队的几百个
 * 字各带一个动画，真窗口里量到过一帧 57ms。一帧里出来的字谁先谁后看不出来，合起来不改变样子，
 * 动画少一个数量级；慢的时候一帧一个字，和从前一样。span 按组里第一个字的序号作 key：前面的字并回
 * 纯文本时，后面的 span 不会被重建，动画也就不会从头再来。
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
import { FADE } from "./stream-pace.ts";

/** 这条回复的原文（画出来的那份）从第几个 UTF-16 单元起是最近放出来的。`Markdown` 每次画都改这一个对象，不换引用：换了引用，每个 `FadeText` 每帧都要重画。 */
export const FadeScope = createContext<{ from: number }>({ from: Number.POSITIVE_INFINITY });

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
	// 新字合成一组，组头是第一个新字。
	const head = Math.max(births.length, old);
	while (births.length < length) {
		const at = births.length;
		births.push(at < old ? now - FADE : now);
		groups.push(at < old ? at : head);
	}

	// 出现时刻是递增的，所以淡完的字总是连成开头那一段。
	let settled = 0;
	while (settled < length && now - births[settled]! >= FADE) settled++;

	// 字数一变就重新起一趟：新字是父组件在同一拍里放出来的，这一拍看到的还是旧的出生时刻，
	// 可能以为已经淡完就停了，新来的那组字会停在透明度 0 上。
	useRedrawWhileFading(settled < length, length, () => state.current?.births.at(-1) ?? 0);

	return { settled, group: (index) => groups[index]!, alpha: (head) => fadeAlpha(now - births[head]!) };
}

/**
 * 挂上时整枚一起淡入：写完才出现的行内代码、公式。和 `useFade` 一样按拍子重画，淡完就摘掉
 * `style`，之后跟着重画也不会再淡一遍。
 */
export function FadeIn({ as: Tag, className, ...rest }: { as: "code" | "span" } & HTMLAttributes<HTMLElement>) {
	const born = useRef(0);
	if (!born.current) born.current = performance.now();
	const alpha = fadeAlpha(performance.now() - born.current);
	useRedrawWhileFading(alpha < 1, 0, () => born.current);
	if (alpha >= 1) return <Tag {...rest} className={className} />;
	return <Tag {...rest} className={className ? `${className} markdown-fade` : "markdown-fade"} style={{ opacity: alpha }} />;
}

/**
 * 还有字在淡时，每拍重画一次，直到最晚出生的那个（`latestBirth`）淡完。自己续拍，不等渲染完再约。
 * `restart` 变了就重新起一趟。
 */
function useRedrawWhileFading(fading: boolean, restart: number, latestBirth: () => number): void {
	const [, redraw] = useReducer((n: number) => n + 1, 0);
	const latest = useRef(latestBirth);
	latest.current = latestBirth;
	useEffect(() => {
		if (!fading) return;
		let tick = 0;
		const loop = () => {
			redraw();
			if (performance.now() - latest.current() < FADE) tick = requestTick(loop);
		};
		tick = requestTick(loop);
		return () => cancelTick(tick);
	}, [fading, restart]);
}

/** 出生了 `age` 毫秒的字此刻的透明度。曲线和从前的 CSS 动画同一条（`cubic-bezier(0.33, 0, 0.67, 1)`，近似成 smoothstep）。 */
function fadeAlpha(age: number): number {
	const t = Math.min(1, Math.max(0, age / FADE));
	return Math.round(t * t * (3 - 2 * t) * 100) / 100;
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
