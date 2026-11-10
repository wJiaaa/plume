/**
 * 设置页共用的控件。
 *
 * 按拿它做什么分开放——排版（`layout`）、打字（`inputs`）、开关和按（这里）——再一起导出，页面只 import 这一处。
 */

export { InlineSelect, Segmented, Toggle } from "@plume/ui";
export * from "./inputs.tsx";
export * from "./layout.tsx";

export function Badge({ tone, children }: { tone: "ok" | "muted" | "danger" | "accent"; children: React.ReactNode }) {
	const tones = {
		ok: "bg-ok/15 text-ok",
		muted: "bg-card text-ink-faint",
		danger: "bg-danger/15 text-danger",
		accent: "bg-accent/15 text-accent",
	};
	return <span className={`shrink-0 rounded-full px-2 py-0.5 text-detail whitespace-nowrap ${tones[tone]}`}>{children}</span>;
}
