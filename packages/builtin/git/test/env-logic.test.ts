import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { GitStatus } from "../src/api.ts";
import { MESSAGES, type MessageKey } from "../src/messages.ts";
import { buildEnvMenuItems, hasEnvMenuContent, requiresDefaultBranchConfirm, resolveEnvQuickAction, sanitizeNewBranchName } from "../src/panel/env-logic.ts";
import type { Translate } from "../src/panel/i18n.ts";

const t: Translate = (key: MessageKey, params?: Record<string, string | number>) => {
	const entry = MESSAGES["zh-CN"][key];
	const raw = typeof entry === "string" ? entry : entry.other;
	if (!params) return raw;
	return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
};

function status(overrides: Partial<GitStatus> = {}): GitStatus {
	return {
		branch: "main",
		upstream: "origin/main",
		ahead: 0,
		behind: 0,
		staged: [],
		unstaged: [],
		remoteState: "tracking",
		remote: "origin",
		operation: null,
		unpushed: 0,
		head: null,
		isDefaultBranch: true,
		...overrides,
	};
}

describe("sanitizeNewBranchName", () => {
	test("规范化空白与首尾非法字符", () => {
		assert.equal(sanitizeNewBranchName("  feat new branch  "), "feat-new-branch");
		assert.equal(sanitizeNewBranchName("/feat..x/"), "feat.x");
		assert.equal(sanitizeNewBranchName("   "), "");
	});
});

describe("resolveEnvQuickAction", () => {
	test("有未提交改动且可推送时推荐「提交并推送」", () => {
		const action = resolveEnvQuickAction(
			status({
				unstaged: [{ path: "a.ts", status: "modified", staged: false, unstaged: true, added: 3, removed: 1 }],
			}),
			false,
			t,
		);
		assert.equal(action.action, "commit_push");
		assert.equal(action.label, "提交并推送");
		assert.equal(action.icon, "upload");
		assert.equal(action.disabled, false);
	});

	test("有未提交改动但落后于上游或无远端时退回「提交」", () => {
		const behind = resolveEnvQuickAction(
			status({
				behind: 2,
				unstaged: [{ path: "a.ts", status: "modified", staged: false, unstaged: true, added: 1, removed: 0 }],
			}),
			false,
			t,
		);
		assert.equal(behind.action, "commit");
		assert.equal(behind.label, "提交");

		const noRemote = resolveEnvQuickAction(
			status({
				upstream: null,
				remoteState: "none",
				remote: null,
				unstaged: [{ path: "a.ts", status: "modified", staged: false, unstaged: true, added: 1, removed: 0 }],
			}),
			false,
			t,
		);
		assert.equal(noRemote.action, "commit");
		assert.equal(noRemote.disabled, false);
	});

	test("干净工作区按领先/落后/分叉/未发布选择推送、拉取、禁用", () => {
		assert.equal(resolveEnvQuickAction(status({ ahead: 2, unpushed: 2 }), false, t).action, "push");
		assert.equal(resolveEnvQuickAction(status({ behind: 3 }), false, t).action, "pull");

		const diverged = resolveEnvQuickAction(status({ ahead: 1, unpushed: 1, behind: 2 }), false, t);
		assert.equal(diverged.disabled, true);
		assert.equal(diverged.label, "同步分支");

		const publish = resolveEnvQuickAction(status({ upstream: null, remoteState: "no-upstream", remote: "origin", unpushed: null }), false, t);
		assert.equal(publish.action, "publish");
		assert.equal(publish.label, "发布分支");

		const upToDate = resolveEnvQuickAction(status(), false, t);
		assert.equal(upToDate.disabled, true);
		assert.equal(upToDate.action, null);
	});
});

describe("buildEnvMenuItems & hasEnvMenuContent", () => {
	test("干净且同步时菜单全部禁用，不启用下拉触发", () => {
		const s = status();
		const items = buildEnvMenuItems(s, false, t);
		assert.deepEqual(
			items.map((item) => [item.id, item.disabled]),
			[
				["commit", true],
				["push", true],
				["pull", false],
			],
		);
		assert.equal(hasEnvMenuContent(s, items), true);

		const localClean = status({ upstream: null, remoteState: "none", remote: null });
		const localItems = buildEnvMenuItems(localClean, false, t);
		assert.deepEqual(
			localItems.map((item) => [item.id, item.disabled]),
			[["commit", true]],
		);
		assert.equal(hasEnvMenuContent(localClean, localItems), false);
	});

	test("游离 HEAD 时即便无可点菜单项也保留下拉以展示提醒", () => {
		const detached = status({ branch: null, upstream: null, remoteState: "detached", remote: null, head: "abc1234" });
		const items = buildEnvMenuItems(detached, false, t);
		assert.equal(hasEnvMenuContent(detached, items), true);
	});
});

describe("requiresDefaultBranchConfirm", () => {
	test("仅对默认分支的推送类动作确认", () => {
		assert.equal(requiresDefaultBranchConfirm("commit_push", true), true);
		assert.equal(requiresDefaultBranchConfirm("push", true), true);
		assert.equal(requiresDefaultBranchConfirm("publish", true), true);
		assert.equal(requiresDefaultBranchConfirm("commit", true), false);
		assert.equal(requiresDefaultBranchConfirm("pull", true), false);
		assert.equal(requiresDefaultBranchConfirm("commit_push", false), false);
	});
});
