import assert from "node:assert/strict";
import { test } from "node:test";
import { appendConversationDraft, conversationDraftTarget, externalWebUrl } from "../src/renderer/plugin-navigation.ts";

const projects = [{ id: "project", name: "Example", path: "/workspace" }];

test("插件导航只准备明确项目或绝对目录的草稿", () => {
	assert.deepEqual(conversationDraftTarget({ project: "project", text: "review" }, projects), { project: "project" });
	assert.deepEqual(conversationDraftTarget({ cwd: "/scratch/pr", text: "review" }, projects), { cwd: "/scratch/pr" });
	assert.deepEqual(conversationDraftTarget({ cwd: "C:\\project", text: "review" }, []), { cwd: "C:\\project" });
	for (const options of [
		{ project: "missing", text: "review" },
		{ project: "project", cwd: "/other", text: "review" },
		{ cwd: "relative", text: "review" },
		{ cwd: "/scratch\0bad", text: "review" },
		{ text: "review" },
		{ cwd: "/scratch", text: " " },
	])
		assert.throws(() => conversationDraftTarget(options, projects));
});

test("打开PR对话保留目标草稿，不丢用户空白或内容", () => {
	assert.equal(appendConversationDraft(undefined, "review"), "review");
	assert.equal(appendConversationDraft("  unfinished\n", "review"), "  unfinished\n\n\nreview");
});

test("外链只允许不带凭据的HTTP(S)网址", () => {
	assert.equal(externalWebUrl("https://github.com/a/b/pull/7"), "https://github.com/a/b/pull/7");
	for (const url of ["file:///tmp/a", "javascript:alert(1)", "https://user@example.com", "https://:secret@example.com", "not a url"]) {
		assert.throws(() => externalWebUrl(url));
	}
});
