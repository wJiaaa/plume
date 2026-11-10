/**
 * TeX 转 HTML，经 KaTeX。
 *
 * 用 KaTeX 而不是浏览器自己的 MathML：Chromium 能画 MathML，但分数线、根号的延伸、大型运算符明显不如
 * KaTeX 排得细，放在回复里看得出来。
 *
 * 返回的字符串是整份 Markdown 里唯一一处直接注入标记、而不是拼成元素的地方。它是 KaTeX 自己的输出——TeX
 * 源码从不作为标记进 DOM，KaTeX 把它解析成树、每个叶子都转义。`trust` 保持关闭，`\href`、
 * `\includegraphics` 这些能写出作者自选地址的命令都因此不可用。
 */

import type { KatexOptions } from "katex";

/*
 * KaTeX 在第一次画公式时才去取，不在启动时。
 *
 * 它有 1MB 上下，而含公式的回复是少数。取到之前 `renderMath` 回答 `undefined`，调用方显示写下的 TeX——和
 * 解析不了的 TeX 显示的是同一个东西；模块一到就排版（`onMathReady`）。
 */
let typeset: ((tex: string, options: KatexOptions) => string) | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function loadMath(): void {
	loading ??= import("katex").then(
		(module) => {
			typeset = module.renderToString ?? module.default.renderToString;
			for (const listener of listeners) listener();
		},
		// 取失败就把源码留在屏幕上，下一个公式再试。
		() => {
			loading = null;
		},
	);
}

/** KaTeX 到了没有——给 `useSyncExternalStore` 用，配 `onMathReady`。 */
export const mathReady = (): boolean => typeset !== null;

export function onMathReady(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/*
 * 同一个公式画两遍很常见——一条消息在它后面每进来一个字都要重画，而 KaTeX 解析不便宜。设上限，否则一个
 * 长会话会把它显示过的每个公式都攒着。
 */
const cache = new Map<string, string>();
const LIMIT = 400;

/** TeX 解析不了时返回 null，KaTeX 还在加载时返回 undefined——两种情况调用方都显示源码。 */
export function renderMath(tex: string, display: boolean): string | null | undefined {
	const key = `${display ? "d" : "i"}:${tex}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit || null;
	if (!typeset) {
		loadMath();
		return undefined;
	}

	let html: string;
	try {
		html = typeset(tex, {
			displayMode: display,
			throwOnError: true,
			trust: false,
			// Unicode 和 \newcommand 不值得一条控制台警告。
			strict: false,
		});
	} catch {
		/*
		 * 解析失败记成空串，而不是不记。只是长得像 TeX 的文字才是常见情况，流式输出时每进一个字都要重画一次；
		 * 不留这条负记录，每一次都要完整解析一遍再抛一次异常。
		 */
		html = "";
	}

	if (cache.size >= LIMIT) cache.clear();
	cache.set(key, html);
	return html || null;
}
