/**
 * ```mermaid 画成图，而不是印成一段代码。
 *
 * 模型很爱用它解释东西——时序、状态机、依赖、一棵进程树——而读者拿到的是二十行 `graph TD`。
 * 那几行是给渲染器看的，不是给人看的：要从里面看出一张图，得在脑子里跑一遍布局算法。
 *
 * 三件事是这个组件存在的理由，都不是「调一下 mermaid.render」那么简单：
 *
 * 1. **它必须是懒的。** mermaid 很大，带着自己的解析器和布局引擎。静态 import 会把它焊进主包，
 *    每个从不画图的会话都要先加载它。这里用动态 import，第一次真的遇到 mermaid 围栏时才去取。
 *
 * 2. **它必须是防备的。** 围栏里的字来自模型，而模型的输入来自网页、文件、工具输出——那是一条
 *    很长的不可信链路。mermaid 默认允许节点标签里写 HTML，`securityLevel: "strict"` 把这条关上；
 *    出来的 SVG 仍然要经过 `dangerouslySetInnerHTML`，所以这个开关不是可选项。
 *
 * 3. **它必须会退让。** 流式输出时，围栏是一个字一个字长出来的——大部分时刻它在语法上都是错的。
 *    一个画不出来就报红的组件，会在每次模型画图时先闪一串错误。画不出来就退回代码块，安静地。
 */

import { OverlayScrollbar } from "@plume/ui";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** 围栏的语言标记里，哪些算 mermaid。 */
export function isMermaid(lang: string): boolean {
	return lang.trim().toLowerCase() === "mermaid";
}

/*
 * 图的颜色取自页面自己的 token，不用 mermaid 主题的原色。
 *
 * neo 主题自带蓝到红的渐变描边、偏红的节点底；分组和连线标签的底色按它假定的页面底色推出来，
 * 放在用户自己调的底色上就是一块块不相干的灰。mermaid 要从这些颜色再推导别的颜色，认不了 `var()`，
 * 也认不了 `color-mix()`——而 Plume 的面和字正是从种子 `color-mix` 出来的——所以在这里解析成字面量。
 */
const PALETTE = {
	background: "var(--plume-shell)",
	primaryColor: "var(--plume-card)",
	mainBkg: "var(--plume-card)",
	nodeBorder: "var(--plume-ink-faint)",
	clusterBkg: "var(--plume-input)",
	clusterBorder: "var(--plume-line)",
	lineColor: "var(--plume-ink-muted)",
	primaryTextColor: "var(--plume-ink)",
	textColor: "var(--plume-ink)",
	titleColor: "var(--plume-ink-muted)",
	edgeLabelBackground: "var(--plume-shell)",
} as const;

/**
 * 把一组 token 解析成不透明的十六进制色。
 *
 * 浏览器给 `color-mix()` 的计算值不是 mermaid 认得的写法，所以把颜色画到一个像素上再读回来；半透明的
 * （线、淡字）先铺一层页面底色再叠上去，得到它在页面上真实看起来的颜色。
 */
function resolveColours(names: Record<string, string>): Record<string, string> {
	const probe = document.createElement("span");
	probe.style.display = "none";
	document.documentElement.append(probe);
	const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	const read = (colour: string): string => {
		probe.style.color = colour;
		return getComputedStyle(probe).color;
	};
	const out: Record<string, string> = {};
	if (context) {
		const base = read("var(--plume-shell)");
		for (const [key, colour] of Object.entries(names)) {
			const value = read(colour);
			// 变量还没写上时浏览器给的是继承来的颜色，那也是页面上真实的颜色，照用。
			if (!value) continue;
			context.globalCompositeOperation = "copy";
			context.fillStyle = base;
			context.fillRect(0, 0, 1, 1);
			context.globalCompositeOperation = "source-over";
			context.fillStyle = value;
			context.fillRect(0, 0, 1, 1);
			const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
			out[key] = `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
		}
	}
	probe.remove();
	return out;
}

/*
 * 明暗和颜色变了图要重画。Plume 的深浅色跟系统走；用户在外观页调的配色、皮肤插件写进的是样式表，外观每次
 * 应用都会改根元素上的 data 属性，皮肤是往 head 里加一个 style。两头都订，少订一头就会有一张亮色的图钉在
 * 暗色的对话里，而且不会自己好，除非那条消息碰巧重画。
 */
let look: string | null = null;

function subscribeLook(onChange: () => void): () => void {
	const changed = () => {
		look = null;
		onChange();
	};
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	media.addEventListener("change", changed);
	const observer = new MutationObserver(changed);
	observer.observe(document.documentElement, { attributes: true });
	observer.observe(document.head, { childList: true });
	return () => {
		media.removeEventListener("change", changed);
		observer.disconnect();
	};
}

/** 明暗加上那几个颜色的当前值，拼成一个字符串：任何一项变了，图都要重画。算一次缓存住，变了才重算。 */
function currentLook(): string {
	look ??= JSON.stringify({
		scheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
		colours: resolveColours(PALETTE),
	});
	return look;
}

/** 渲染同一张图的两次之间，id 不能撞——mermaid 用它在文档里挂临时节点。 */
let seq = 0;

export function MermaidBlock({
	code,
	fallback,
}: {
	code: string;
	/**
	 * 画不出来、或者还没画出来时顶上的东西——由调用方给。
	 *
	 * 这个组件知道怎么画图、知道自己画没画成，但「画不成的时候该显示什么」是那段 Markdown 的事——同一个
	 * 围栏在别处也许该显示别的东西。
	 */
	fallback: ReactNode;
}) {
	const scheme = useSyncExternalStore(subscribeLook, currentLook, () => JSON.stringify({ scheme: "light", colours: {} }));
	const [svg, setSvg] = useState<string | null>(null);
	/*
	 * 「还没画出来」和「画不出来」是两种状态，不能合成一个。
	 *
	 * 合成一个的话，流式输出时每一帧不完整的语法都会先退成代码块再变回图，一路闪。
	 */
	const [failed, setFailed] = useState(false);
	const viewport = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let alive = true;
		setFailed(false);

		void (async () => {
			try {
				const mermaid = (await import("mermaid")).default;
				if (!alive) return;
				const { scheme: mode, colours } = JSON.parse(scheme) as { scheme: "dark" | "light"; colours: Record<string, string> };
				mermaid.initialize({
					startOnLoad: false,
					// 见上：围栏内容是不可信输入，标签里的 HTML 一律当文本。
					securityLevel: "strict",
					/*
					 * mermaid 12 的流程图默认外观是 neo，它会给节点和分组框套上主题的 `dropShadow`。
					 * 老的 dark/default 主题不是为 neo 配的：dark 的阴影是不透明的浅灰，
					 * 在暗底上成了每个框外的一圈白光。用和 neo 成套的主题，颜色再换成页面的（见 `PALETTE`）。
					 */
					theme: mode === "dark" ? "neo-dark" : "neo",
					themeVariables: {
						...colours,
						useGradient: false,
						// 图本来就画在消息里，节点不需要再从这一层浮起来。
						dropShadow: "none",
					},
					fontFamily: "var(--plume-font-sans, inherit)",
				});
				/*
				 * `parse` 先问一句能不能画。
				 *
				 * `render` 失败时会往文档里留下它的临时容器和一个「Syntax error」的图；先 parse
				 * 就不会走到那一步——流式输出时这条路每秒要走好几遍。
				 */
				await mermaid.parse(code);
				if (!alive) return;
				const { svg: out } = await mermaid.render(`markdown-mermaid-${(seq += 1)}`, code);
				if (alive) setSvg(out);
			} catch {
				// 画不出来就是画不出来：退回代码块，不喊。
				if (alive) setFailed(true);
			}
		})();

		return () => {
			alive = false;
		};
	}, [code, scheme]);

	/*
	 * 画不出来，和还没画出来，显示的是同一个东西——那段原文。
	 *
	 * 不占位的话，图出来的瞬间下面整段答案会往下跳一截，而读者多半正在读那一段。
	 */
	if (failed || svg === null) return <>{fallback}</>;

	/*
	 * 比栏宽的图横着滚，滑块和代码块的一样（见 `MarkdownCode`）。`safe center`：比框宽的东西直接居中，
	 * 左半边会被推出滚动起点之外，哪个滚动条都够不着。
	 */
	return (
		<div className="markdown-mermaid-frame plume-hscroll-own my-3">
			<div
				ref={viewport}
				className="markdown-mermaid flex overflow-x-auto [justify-content:safe_center]"
				role="img"
				// 经过 strict 模式的 mermaid，标签已被当作文本处理；见文件头第 2 条。
				dangerouslySetInnerHTML={{ __html: svg }}
			/>
			<OverlayScrollbar viewport={viewport} orientation="horizontal" />
		</div>
	);
}
