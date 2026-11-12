import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, Locale, SessionSummary } from "@plume/contract";
import { createNotifications } from "../src/main/notifications.ts";
const summary: SessionSummary = { id: "parent", title: "写说明", cwd: "/work", createdAt: 0, updatedAt: 1, running: false };
function setup() {
	let active = false,
		supported = true,
		locale: Locale = "zh-CN";
	const sent: { title: string; body: string; click?: () => void }[] = [];
	const opened: string[] = [];
	const event = createNotifications({
		active: () => active,
		supported: () => supported,
		locale: () => locale,
		create: (options) => {
			const item = { ...options, click: undefined as (() => void) | undefined };
			return {
				on: (_event, callback) => {
					item.click = callback;
				},
				show: () => {
					sent.push(item);
				},
			};
		},
		open: (id) => {
			opened.push(id);
		},
	});
	event({ type: "sessions", sessions: [summary, { ...summary, id: "child", parentId: "parent" }] });
	return {
		event,
		sent,
		opened,
		active: (value: boolean) => {
			active = value;
		},
		supported: (value: boolean) => {
			supported = value;
		},
		locale: (value: Locale) => {
			locale = value;
		},
	};
}
test("系统通知只在离开窗口时发送，完成依据真正闲下来的事件", () => {
	const state = setup();
	state.event({ type: "sessions", sessions: [{ ...summary, running: true }] });
	state.event({ type: "sessions", sessions: [{ ...summary, stop: { reason: "done" } }] });
	assert.equal(state.sent.length, 0);
	state.active(true);
	state.event({ type: "idle", sessionId: "parent" });
	state.active(false);
	state.supported(false);
	state.event({ type: "idle", sessionId: "parent" });
	assert.equal(state.sent.length, 0);
	state.supported(true);
	state.event({ type: "idle", sessionId: "parent" });
	assert.match(state.sent[0]!.body, /写说明.*已完成/);
	state.sent[0]!.click!();
	assert.deepEqual(state.opened, ["parent"]);
});
test("子会话审批去重、点击打开父会话，下一条通知即时使用新语言", () => {
	const state = setup();
	const approval: AgentEvent = {
		type: "approval",
		sessionId: "child",
		approval: { toolCallId: "a", kind: "command", tool: "bash", title: "执行命令", detail: "" },
	};
	state.event(approval);
	state.event(approval);
	assert.equal(state.sent.length, 1);
	state.sent[0]!.click!();
	assert.deepEqual(state.opened, ["parent"]);
	state.event({ type: "approval", sessionId: "child", approval: undefined });
	state.locale("en");
	// 等人给答案（`run.request`）：正文是插件给的状态，不是卡上的数据。
	state.event({
		...approval,
		approval: { type: "request", toolCallId: "q", kind: "ask_user", tool: "ask_user", title: "问", payload: { question: "x" }, waiting: "Which branch?" },
	});
	assert.match(state.sent[1]!.body, /needs your input: Which branch\?/);
	state.event({ type: "approval", sessionId: "child", approval: undefined });
	// 插件自己的表单（kind 不是本体认得的名字）照样算提问；没给状态时用卡片标题。
	state.event({ ...approval, approval: { type: "request", toolCallId: "b", kind: "mcp-form", tool: "mcp_call", title: "github", payload: {} } });
	assert.match(state.sent[2]!.body, /needs your input: github$/);
});
test("插件的独立会话不发系统通知：它画在插件自己的页面里，点通知打不开", () => {
	const state = setup();
	state.event({ type: "sessions", sessions: [{ ...summary, id: "owned", owner: "plume.ssh" }] });
	state.event({ type: "approval", sessionId: "owned", approval: { toolCallId: "a", kind: "ssh_run", tool: "ssh_run", title: "运行命令", detail: "" } });
	assert.equal(state.sent.length, 0);
});
