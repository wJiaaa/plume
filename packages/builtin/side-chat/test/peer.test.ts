import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import type { LetterInput, LetterReceipt, SessionSummary, ToolRun } from "@plume/contract";
import { isSentToSession } from "../src/controls.ts";
import { createSendToSession, gitCommonDir, normalizeSessionId, sameProjectOrRepo } from "../src/peer.ts";

function summary(patch: Partial<SessionSummary> & { id: string }): SessionSummary {
	return {
		title: "",
		cwd: "/w",
		kind: "top",
		running: false,
		createdAt: 0,
		updatedAt: 0,
		...patch,
	} as SessionSummary;
}

function makeHarness(
	sessions: SessionSummary[],
	options: {
		commonDirOf?: (cwd: string) => Promise<string | null>;
		receipt?: Partial<LetterReceipt>;
		withLetter?: boolean;
	} = {},
) {
	const byId = new Map(sessions.map((item) => [item.id, item]));
	const sent: Array<{ to: string; letter: LetterInput }> = [];
	const tool = createSendToSession({
		parentOf: (sideId) => (sideId === "side" ? "main" : undefined),
		getSession: async (id) => byId.get(id),
		locale: () => "zh-CN",
		commonDirOf: options.commonDirOf ?? (async () => null),
	});
	const letter = (to: string, input: LetterInput): LetterReceipt => {
		sent.push({ to, letter: input });
		return {
			id: "letter-1",
			queued: false,
			held: false,
			read: Promise.resolve({ status: "read" }),
			...options.receipt,
		};
	};
	const call = (args: Record<string, unknown>, sessionId = "side") =>
		tool.execute(args, {
			sessionId,
			...(options.withLetter === false ? {} : { letter }),
		} as unknown as ToolRun);
	return { tool, sent, call };
}

test("normalizeSessionId 剥掉 session:// 前缀并保留纯 id", () => {
	assert.equal(normalizeSessionId("abc-123"), "abc-123");
	assert.equal(normalizeSessionId(" session://abc-123 "), "abc-123");
	assert.equal(normalizeSessionId("session://abc%2D123/4"), "abc-123");
});

test("send_to_session：同项目顶层会话直接发送，支持 session:// 前缀，回执按空闲/繁忙/暂停如实汇报", async () => {
	const sessions = [
		summary({ id: "main", title: "主会话", project: "p1", cwd: "/p1" }),
		summary({ id: "peer", title: "模拟测试极兔全部接口", project: "p1", cwd: "/p1" }),
	];
	const idle = makeHarness(sessions);
	const res = await idle.call({ session_id: "session://peer", message: "  补上两个遗漏接口  " });
	assert.equal(res.isError, undefined);
	assert.match(res.output as string, /已发送给「模拟测试极兔全部接口」.*已开始处理/);
	assert.ok(isSentToSession(res.details));
	assert.deepEqual(res.details, { kind: "sent_to_session", sessionId: "peer", title: "模拟测试极兔全部接口" });
	assert.equal(idle.sent.length, 1);
	assert.equal(idle.sent[0]?.to, "peer");
	assert.equal(idle.sent[0]?.letter.from, "主会话（侧边聊天）");
	assert.equal(idle.sent[0]?.letter.text, "补上两个遗漏接口");
	assert.match(idle.sent[0]?.letter.guide ?? "", /单向/);

	const busy = makeHarness(sessions, { receipt: { queued: true, held: false } });
	assert.match((await busy.call({ session_id: "peer", message: "插一句" })).output as string, /正在执行.*这一步后读到/);

	const held = makeHarness(sessions, { receipt: { queued: false, held: true } });
	assert.match((await held.call({ session_id: "peer", message: "等开口" })).output as string, /暂停|上限/);
});

test("send_to_session：发给这段侧边聊天开出、每轮交回这里的会话时，说明换成答在收尾回复里，回执说结果会交回来", async () => {
	const sessions = [
		summary({ id: "main", title: "主会话", project: "p1", cwd: "/p1" }),
		summary({ id: "mine", title: "改标识", project: "p1", cwd: "/p1", spawnedFrom: { sessionId: "main", toolCallId: "c1", callIn: "side", reportBack: true } }),
		summary({ id: "quiet", title: "不送回", project: "p1", cwd: "/p1", spawnedFrom: { sessionId: "main", toolCallId: "c2", callIn: "side" } }),
	];
	const harness = makeHarness(sessions);
	assert.match((await harness.call({ session_id: "mine", message: "改成大写十六进制" })).output as string, /交回这里/);
	assert.match(harness.sent[0]?.letter.guide ?? "", /收尾回复/);
	assert.doesNotMatch((await harness.call({ session_id: "quiet", message: "改一下" })).output as string, /交回这里/);
	assert.match(harness.sent[1]?.letter.guide ?? "", /单向/);
});

test("send_to_session：不同项目但同 Git 仓库（含工作树与子目录）允许发送，不同仓库与普通目录拒绝", async (t: TestContext) => {
	const root = mkdtempSync(join(tmpdir(), "plume-side-peer-"));
	t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const sub = join(repo, "packages", "app");
	const worktree = join(root, "wt");
	const otherRepo = join(root, "other-repo");
	const plain = join(root, "plain");
	mkdirSync(sub, { recursive: true });
	mkdirSync(otherRepo, { recursive: true });
	mkdirSync(plain, { recursive: true });

	const git = (cwd: string, args: string[]) =>
		execFileSync("git", args, {
			cwd,
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
			stdio: "ignore",
		});
	git(repo, ["init"]);
	writeFileSync(join(repo, "a.txt"), "hi");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "init"]);
	git(repo, ["worktree", "add", "-b", "feat", worktree]);

	git(otherRepo, ["init"]);
	writeFileSync(join(otherRepo, "b.txt"), "hi");
	git(otherRepo, ["add", "."]);
	git(otherRepo, ["commit", "-m", "init"]);

	const mainSession = summary({ id: "main", cwd: repo });
	const wtSession = summary({ id: "wt", title: "工作树会话", cwd: worktree });
	const subSession = summary({ id: "sub", title: "子目录会话", cwd: sub });
	const otherSession = summary({ id: "other", title: "别的仓库", cwd: otherRepo });
	const plainA = summary({ id: "plain-a", cwd: plain });
	const plainB = summary({ id: "plain-b", title: "普通目录", cwd: plain });

	assert.equal(await sameProjectOrRepo(mainSession, wtSession, gitCommonDir), true);
	assert.equal(await sameProjectOrRepo(mainSession, subSession, gitCommonDir), true);
	assert.equal(await sameProjectOrRepo(mainSession, otherSession, gitCommonDir), false);
	// 不在项目里、也不在 Git 仓库里的普通目录之间不互通。
	assert.equal(await sameProjectOrRepo(plainA, plainB, gitCommonDir), false);

	const h = makeHarness([mainSession, wtSession, otherSession], { commonDirOf: gitCommonDir });
	assert.equal((await h.call({ session_id: "wt", message: "同仓库工作树" })).isError, undefined);
	const refused = await h.call({ session_id: "other", message: "跨仓库" });
	assert.equal(refused.isError, true);
	assert.match(refused.output as string, /不在当前主会话所属的项目或同一个 Git 仓库内/);
	assert.equal(h.sent.length, 1);
});

test("send_to_session：拦截非侧边聊天、发给主会话、子会话、已归档、不存在、空消息和超长消息", async () => {
	const sessions = [
		summary({ id: "main", title: "主会话", project: "p1" }),
		summary({ id: "peer", title: "同伴", project: "p1" }),
		summary({ id: "archived", title: "旧会话", project: "p1", archived: true }),
		summary({ id: "child", title: "子会话", project: "p1", kind: "child", parentId: "peer" }),
	];
	const h = makeHarness(sessions);

	assert.equal((await h.call({ session_id: "peer", message: "hi" }, "main")).isError, true);
	assert.equal((await makeHarness(sessions, { withLetter: false }).call({ session_id: "peer", message: "hi" })).isError, true);

	const toMain = await h.call({ session_id: "main", message: "交给主会话" });
	assert.equal(toMain.isError, true);
	assert.match(toMain.output as string, /dispatch_task/);

	assert.equal((await h.call({ session_id: "archived", message: "hi" })).isError, true);
	assert.equal((await h.call({ session_id: "child", message: "hi" })).isError, true);
	assert.equal((await h.call({ session_id: "missing", message: "hi" })).isError, true);
	assert.equal((await h.call({ session_id: "", message: "hi" })).isError, true);
	assert.equal((await h.call({ session_id: "peer", message: "   " })).isError, true);
	assert.equal((await h.call({ session_id: "peer", message: "x".repeat(20_001) })).isError, true);
	assert.equal(h.sent.length, 0);
});
