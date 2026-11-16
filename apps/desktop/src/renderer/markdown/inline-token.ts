/**
 * 行内 Markdown 的 token（`inline.ts` 切出来、`html.ts` 认出的 HTML 也产出它），单放一处：两边都要这份类型，互相引就成了环。
 */

/** 按本来样子画出来的 HTML：每一个都有能照办的含义。 */
export type InlineTag = "kbd" | "sub" | "sup" | "mark";

export type Inline =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string }
	| { kind: "math"; tex: string; display: boolean }
	| { kind: "break" }
	| { kind: "strong"; children: Inline[] }
	| { kind: "em"; children: Inline[] }
	| { kind: "del"; children: Inline[] }
	| { kind: "link"; href: string; children: Inline[] }
	/** `width`/`height` 只来自 HTML 的 `<img>`；`![](…)` 没地方写它们。 */
	| { kind: "image"; src: string; alt: string; width?: number; height?: number }
	| { kind: "tag"; name: InlineTag; children: Inline[] };
