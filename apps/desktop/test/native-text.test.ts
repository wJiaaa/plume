/**
 * 主进程的文案（main/i18n.ts）：agent 起不来时对话框里的路径和原因。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { nativeText } from "../src/main/i18n.ts";

test("会话库打不开：两种语言都填上路径和原因，原因里的 $& 原样留着", () => {
	const variables = { path: "/tmp/plume/sessions/sessions.db", reason: "database is locked $&" };
	for (const locale of ["zh-CN", "en"] as const) {
		const body = nativeText(locale, "sessions.unavailable", variables);
		assert.ok(body.includes(variables.path), body);
		assert.ok(body.includes(variables.reason), body);
		assert.ok(!/\{(path|reason)\}/.test(body), body);
	}
	assert.equal(nativeText("en", "sessions.unavailableTitle"), "Plume can't open your conversations");
});
