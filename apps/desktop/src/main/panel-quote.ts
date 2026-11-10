import type { PanelWindowReveal } from "../shared/panel-window.ts";

/** 跨窗口只接收来源会话的引文，取明确字段，不把额外参数带进主窗口。 */
export function panelQuoteFrom(value: unknown, scope: string): Extract<PanelWindowReveal, { quote: unknown }>["quote"] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const data = value as Record<string, unknown>;
	const identifier = (text: unknown): text is string =>
		typeof text === "string" && text.trim().length > 0 && text.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(text);
	if (
		!identifier(data.panel) ||
		!identifier(data.sessionId) ||
		data.sessionId !== scope ||
		!data.quote ||
		typeof data.quote !== "object" ||
		Array.isArray(data.quote)
	)
		return;
	const quote = data.quote as Record<string, unknown>;
	if (
		!identifier(quote.id) ||
		typeof quote.text !== "string" ||
		!quote.text.trim() ||
		quote.text.length > 1_000_000 ||
		(quote.from !== "user" && quote.from !== "assistant")
	)
		return;
	return { panel: data.panel, sessionId: data.sessionId, quote: { id: quote.id, text: quote.text, from: quote.from } };
}
