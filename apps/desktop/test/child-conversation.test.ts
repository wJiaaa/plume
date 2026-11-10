import assert from "node:assert/strict";
import { test } from "node:test";
import { childComposerState } from "../src/renderer/conversation/child-composer-state.ts";
import { sameRow } from "../src/renderer/conversation/turns.ts";

const ready = { active: true, running: false, loading: false, sending: false, disabled: false, steer: false, hasContent: true };

test("普通输入框在运行时只能停止，插话输入框在运行和发送中始终不是停止键", () => {
	assert.deepEqual(childComposerState({ ...ready, running: true }), { disabled: false, readOnly: false, stop: true, canSend: false });
	assert.equal(childComposerState({ ...ready, running: true, sending: true }).stop, true);
	assert.deepEqual(childComposerState({ ...ready, running: true, steer: true }), { disabled: false, readOnly: false, stop: false, canSend: true });
	assert.deepEqual(childComposerState({ ...ready, running: true, steer: true, sending: true }), {
		disabled: false,
		readOnly: false,
		stop: false,
		canSend: false,
	});
	assert.equal(childComposerState({ ...ready, sending: true }).readOnly, false);
});

test("隐藏会话、加载和显式禁用不能发送或停止，空消息不能发送", () => {
	for (const blocked of [{ active: false }, { loading: true }, { disabled: true }]) {
		assert.deepEqual(childComposerState({ ...ready, running: true, steer: true, ...blocked }), { disabled: true, readOnly: true, stop: false, canSend: false });
		assert.equal(childComposerState({ ...ready, running: true, ...blocked }).stop, false);
	}
	assert.equal(childComposerState({ ...ready, hasContent: false }).canSend, false);
	assert.equal(childComposerState(ready).canSend, true);
});

test("转录行的 memo 比较视图专用的两个新回调，包括新增和移除", () => {
	const renderUserMessage = () => null;
	const replyText = (text: string) => text;
	const row = { turnStats: undefined, renderUserMessage, replyText };
	assert.equal(sameRow(row, { ...row }), true);
	assert.equal(sameRow(row, { ...row, renderUserMessage: () => null }), false);
	assert.equal(sameRow(row, { ...row, replyText: () => "" }), false);
	assert.equal(sameRow(row, { turnStats: undefined, renderUserMessage, replyText: undefined }), false);
	assert.equal(
		sameRow<{ turnStats?: undefined; renderUserMessage?: typeof renderUserMessage; replyText?: typeof replyText }>(row, { turnStats: undefined }),
		false,
	);
});
