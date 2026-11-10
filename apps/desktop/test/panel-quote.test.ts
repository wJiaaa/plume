import assert from "node:assert/strict";
import { test } from "node:test";
import { panelQuoteFrom } from "../src/main/panel-quote.ts";

test("跨窗引用保留来源和换行，不把额外发送参数带回主窗口", () => {
	const source = { panel: "plume.side-chat/chat", sessionId: "main", quote: { id: "quote", text: "第一段\n第二段", from: "assistant" } };
	assert.deepEqual(panelQuoteFrom({ ...source, send: true, quote: { ...source.quote, send: true } }, "main"), source);
	assert.equal(panelQuoteFrom({ ...source, sessionId: "another" }, "main"), undefined);
	for (const changed of [
		{ panel: "" },
		{ panel: "bad\nname" },
		{ sessionId: "" },
		{ quote: null },
		{ quote: [] },
		{ quote: { ...source.quote, id: "" } },
		{ quote: { ...source.quote, text: " " } },
		{ quote: { ...source.quote, text: "x".repeat(1_000_001) } },
		{ quote: { ...source.quote, from: "tool" } },
	])
		assert.equal(panelQuoteFrom({ ...source, ...changed }, "main"), undefined);
	for (const value of [null, undefined, "quote", []]) assert.equal(panelQuoteFrom(value, "main"), undefined);
});
