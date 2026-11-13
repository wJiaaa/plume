import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { PluginContext, PromptSubmit, PromptVerdict, SessionScope, SessionSummary, SessionWorktreeService } from "@plume/contract";
import type { GitApi } from "../src/api.ts";
import type { WorktreeApi } from "../src/worktree/api.ts";
import plugin from "../src/index.ts";
import { plainGit } from "./plain-view.ts";

let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "plume-worktree-plugin-")));
	repo = join(dir, "repo");
	await mkdir(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
	await writeFile(join(repo, "a.txt"), "one\n");
	git(repo, "add", "a.txt");
	git(repo, "commit", "-q", "-m", "init");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** 只给工作树那一半用到的那几样：会话摘要、钩子、删除和归档的监听、归档、serve、provide。 */
async function load() {
	const summaries: SessionSummary[] = [];
	let submit: ((input: PromptSubmit, next: (input: PromptSubmit) => Promise<PromptVerdict>) => Promise<PromptVerdict>) | undefined;
	let deleted: ((id: string) => void) | undefined;
	let archived: ((id: string, archived: boolean) => void) | undefined;
	let api: (GitApi & WorktreeApi) | undefined;
	let service: SessionWorktreeService | undefined;
	const archiveCalls: Array<[string, boolean]> = [];
	const dataDir = join(dir, "data");
	await mkdir(dataDir, { recursive: true });
	const ctx = {
		name: plugin.name,
		dataDir,
		appDataDir: dir,
		locale: () => "zh-CN",
		log: { info() {}, warn() {}, error() {} },
		hook: (name: string, layer: typeof submit) => {
			if (name === "prompt.submit") submit = layer;
		},
		serve: (served: GitApi & WorktreeApi) => void (api = served),
		provide: (name: string, provided: SessionWorktreeService) => {
			if (name === "session.worktree") service = provided;
		},
		workspace: { git: plainGit },
		sessions: {
			list: async () => summaries.map((summary) => ({ ...summary })),
			get: async (id: string) => summaries.find((summary) => summary.id === id),
			onDeleted: (listener: (id: string) => void) => void (deleted = listener),
			onArchived: (listener: (id: string, archived: boolean) => void) => void (archived = listener),
			setArchived: async (id: string, on: boolean) => void archiveCalls.push([id, on]),
		},
	} as unknown as PluginContext;
	await plugin.apply(ctx);
	const session = (id: string, extra: Partial<SessionSummary> = {}) => {
		const summary: SessionSummary = {
			id,
			title: "",
			cwd: repo,
			project: "p1",
			createdAt: 0,
			updatedAt: 0,
			running: false,
			kind: extra.parentId ? "child" : extra.owner ? "standalone" : "top",
			...extra,
		};
		summaries.push(summary);
		return summary;
	};
	const scopeOf = ({ id, kind, parentId, owner, spawnedFrom, project }: SessionSummary): SessionScope => ({
		id,
		kind,
		...(parentId ? { parentId } : {}),
		...(owner ? { owner } : {}),
		...(spawnedFrom ? { spawnedFrom } : {}),
		...(project ? { project } : {}),
	});
	const send = (summary: SessionSummary, fresh: boolean, launched = summary.spawnedFrom !== undefined) =>
		submit!(
			{
				sessionId: summary.id,
				session: scopeOf(summary),
				cwd: summary.cwd,
				text: "hi",
				attachments: [],
				synthetic: false,
				fresh,
				launched,
				signal: new AbortController().signal,
			},
			async () => ({ block: false }),
		);
	/** 监听里起的活排在会话的队里：排一个什么都不改的调用在后面，等它回来。 */
	const settle = async (id: string) => void (await api!.abortWorktreeSync(id));
	return {
		api: api!,
		service: service!,
		session,
		send,
		deleted: (id: string) => deleted!(id),
		archived: (id: string, on: boolean) => archived!(id, on),
		settle,
		archiveCalls,
	};
}

test("第一轮：开关开着就开工作树、交回 cwd；用掉后回到关；子会话和没开的不动", async () => {
	const { api, session, send } = await load();
	assert.equal(await api.isRepo(repo), true);
	assert.equal(await api.worktreePick(repo), false);
	await api.chooseWorktree(repo, true);
	assert.equal(await api.worktreePick(repo), true);

	const one = session("aaaaaaaa-1");
	const verdict = await send(one, true);
	assert.equal(verdict.block, false);
	const record = await api.worktreeRecord(one.id);
	assert.ok(record?.worktree);
	assert.deepEqual(verdict, { block: false, cwd: record.worktree.cwd });
	assert.equal(git(record.worktree.cwd, "symbolic-ref", "--short", "HEAD"), "plume/session-aaaaaaaa");
	assert.equal(await api.worktreePick(repo), false);

	// 下一个新对话没拨开关：不开。
	assert.deepEqual(await send(session("bbbbbbbb-2"), true), { block: false });
	await api.chooseWorktree(repo, true);
	assert.deepEqual(await send(session("cccccccc-3", { parentId: one.id }), true), { block: false });
	assert.deepEqual(await send(session("dddddddd-4", { project: undefined }), true), { block: false });
});

test("之后的轮：目录被收走了就检出回来；检不出来退回项目目录，记下原因", async () => {
	const { api, session, send } = await load();
	await api.chooseWorktree(repo, true);
	const one = session("aaaaaaaa-1");
	const tree = (await send(one, true)).block === false ? (await api.worktreeRecord(one.id))?.worktree : undefined;
	assert.ok(tree);
	one.cwd = tree.cwd;

	git(repo, "worktree", "remove", tree.root);
	assert.deepEqual(await send(one, false), { block: false });
	assert.ok(existsSync(tree.root));

	git(repo, "worktree", "remove", tree.root);
	// 项目不再是仓库：检不出来。
	await rm(join(repo, ".git"), { recursive: true, force: true });
	assert.deepEqual(await send(one, false), { block: false, cwd: repo });
	const record = await api.worktreeRecord(one.id);
	assert.equal(record?.worktree, undefined);
	assert.ok(record?.error);
});

test("删除、归档收回目录；取消归档检出回来；有改动的留着", async () => {
	const { api, session, send, deleted, archived, settle } = await load();
	await api.chooseWorktree(repo, true);
	const one = session("aaaaaaaa-1");
	await send(one, true);
	const tree = (await api.worktreeRecord(one.id))?.worktree;
	assert.ok(tree);

	archived(one.id, true);
	await settle(one.id);
	assert.equal(existsSync(tree.root), false);
	assert.equal((await api.worktreeState(one.id))?.present, false);
	archived(one.id, false);
	await settle(one.id);
	assert.ok(existsSync(tree.root));

	await writeFile(join(tree.root, "draft.txt"), "x\n");
	deleted(one.id);
	await settle(one.id);
	assert.ok(existsSync(tree.root));
	assert.equal(await api.worktreeRecord(one.id), null);
});

test("合并、同步：对话在跑时拒绝", async () => {
	const { api, session, send } = await load();
	await api.chooseWorktree(repo, true);
	const one = session("aaaaaaaa-1");
	await send(one, true);
	one.running = true;
	assert.deepEqual(await api.mergeWorktree(one.id), { kind: "refused", reason: "running" });
	assert.deepEqual(await api.syncWorktree(one.id), { kind: "refused", reason: "running" });
	assert.deepEqual(await api.mergeWorktree("missing"), { kind: "refused", reason: "gone" });
});

test("合并后归档：交给宿主归档，已归档的对话合并结果带上 archived；侧栏读得到有工作树的会话的分支", async () => {
	const { api, session, send, archiveCalls } = await load();
	await api.chooseWorktree(repo, true);
	const one = session("aaaaaaaa-1");
	await send(one, true);
	const tree = (await api.worktreeRecord(one.id))?.worktree;
	assert.ok(tree);
	assert.deepEqual(await api.worktreeBranches(), { [one.id]: "plume/session-aaaaaaaa" });

	const commit = async (file: string) => {
		await writeFile(join(tree.root, file), "x\n");
		git(tree.root, "add", "--", file);
		git(tree.root, "commit", "-q", "-m", file);
	};
	await commit("b.txt");
	assert.deepEqual(await api.mergeWorktree(one.id), { kind: "merged", commits: 1, base: "main" });
	await api.archiveSession(one.id);
	assert.deepEqual(archiveCalls, [[one.id, true]]);

	one.archived = true;
	await commit("c.txt");
	assert.deepEqual(await api.mergeWorktree(one.id), { kind: "merged", commits: 1, base: "main", archived: true });
});

test("工作树的设置和提交说明的语言存在同一个数据目录里，互不覆盖", async () => {
	const { api } = await load();
	const call = { signal: new AbortController().signal } as Parameters<GitApi["commitLanguage"]>[0];
	await api.setCommitLanguage("en", call);
	await api.saveWorktreeSettings({ fetchFirst: true });
	assert.equal(await api.commitLanguage(call), "en");
	assert.equal((await api.worktreeSettings()).fetchFirst, true);
});

test("从工具调用开出来的会话：那次调用经服务登记过才开工作树，撤销了就不开；都不动输入框上同一个项目的开关", async () => {
	const { api, service, session, send } = await load();
	assert.equal(await service.available(repo), true);
	assert.equal(await service.available(dir), false);
	const parent = session("pppppppp-0");
	await api.chooseWorktree(repo, true);

	service.requestFor({ sessionId: parent.id, toolCallId: "call-1" });
	const one = session("aaaaaaaa-1", { spawnedFrom: { sessionId: parent.id, toolCallId: "call-1" } });
	const verdict = await send(one, true);
	const tree = (await api.worktreeRecord(one.id))?.worktree;
	assert.ok(tree);
	assert.deepEqual(verdict, { block: false, cwd: tree.cwd });
	assert.equal(await api.worktreePick(repo), true);

	// 登记只用一次：同一次调用再开出一个（不会发生，但不该凭旧登记再开一棵）。
	assert.deepEqual(await send(session("bbbbbbbb-2", { spawnedFrom: { sessionId: parent.id, toolCallId: "call-1" } }), true), { block: false });
	const undo = service.requestFor({ sessionId: parent.id, toolCallId: "call-2" });
	undo();
	assert.deepEqual(await send(session("cccccccc-3", { spawnedFrom: { sessionId: parent.id, toolCallId: "call-2" } }), true), { block: false });
	assert.deepEqual(await send(session("dddddddd-4", { spawnedFrom: { sessionId: parent.id, toolCallId: "call-3" } }), true), { block: false });
	assert.equal(await api.worktreePick(repo), true);

	// 插件开的、没记来处的会话（定时任务）：不开，也不用掉输入框上的选择。
	assert.deepEqual(await send(session("ffffffff-6"), true, true), { block: false });
	assert.equal(await api.worktreePick(repo), true);

	// 输入框上的那次选择还在，留给人正在写的新对话。
	const typed = session("eeeeeeee-5");
	await send(typed, true);
	assert.ok((await api.worktreeRecord(typed.id))?.worktree);
	assert.equal(await api.worktreePick(repo), false);
});
