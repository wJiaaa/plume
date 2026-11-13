import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Remote } from "@plume/rpc";
import { type BrowserWindow, nativeTheme } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { plumeHome } from "./home.ts";
import { clickVisible, clickVisibleIn, containing } from "./smoke-kit.ts";

/** 从已有的闲置会话进入；只替换 GitLab 服务，账号、列表、评论和草稿都走实际插件。 */
export async function checkPullRequests(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; install(name: string): Promise<void>; installDir: string };
	outDir: string;
	workspace: string;
}): Promise<void> {
	const { window, agent, plugin, outDir, workspace } = options;
	const page = <T>(expression: string): Promise<T> => window.webContents.executeJavaScript(expression) as Promise<T>;
	const waitMain = async (test: () => boolean | Promise<boolean>, label: string, timeout = 15_000) => {
		const end = Date.now() + timeout;
		while (!(await test())) {
			if (Date.now() > end) throw new Error(`拉取请求冒烟等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	const until = (expression: string, label: string) => waitMain(() => page<boolean>(expression), label);
	/** `scope` 里按无障碍名、文字或第一层 span 的文字认出的按钮（中英文界面各给一个名字）。 */
	const click = (scope: string, labels: string[]) =>
		clickVisibleIn(
			page,
			`[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].filter(element => [element.getAttribute('aria-label'), element.textContent.trim(), element.querySelector(':scope > span')?.textContent.trim()].some(label => ${JSON.stringify(labels)}.includes(label)))`,
			`${scope} 里的按钮「${labels[0]}」`,
		);
	const fill = async (selector: string, value: string) => {
		await until(`document.querySelector(${JSON.stringify(selector)}) !== null`, `输入框出现：${selector}`);
		await page(`(() => {
			const field = document.querySelector(${JSON.stringify(selector)});
			const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, ${JSON.stringify(value)});
			field.dispatchEvent(new Event('input', { bubbles: true }));
		})()`);
	};
	const capture = async (name: string) => {
		await until(
			`document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).every(animation => animation.playState === 'finished' || animation.playState === 'idle')`,
			"页面动画落位",
		);
		await page(`document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const composerText = `[...document.querySelectorAll('[data-screen] .cm-content .cm-line')].map(line => { const copy = line.cloneNode(true); copy.querySelectorAll('.cm-placeholder').forEach(node => node.remove()); return copy.textContent; }).join('\\n')`;
	const original = await page<{ session: string | null; nav: string | null; draft: string | null; dark: boolean }>(`({
		session: document.querySelector('[data-plume-row] > button[aria-current="page"]')?.closest('[data-plume-row]').dataset.plumeRow ?? null,
		nav: document.querySelector('[data-nav][aria-current="page"]')?.dataset.nav ?? null,
		draft: document.querySelector('[data-screen] .cm-content') ? ${composerText} : null,
		dark: matchMedia('(prefers-color-scheme: dark)').matches
	})`);
	assert.ok(original.session, "拉取请求冒烟要在已有会话里调用，才能准确恢复原会话与草稿");
	assert.ok(plugin.cli, "没有 plume-plugin 启动脚本，装不了拉取请求插件");
	const beforeSessions = await agent.sessions();
	assert.ok(
		beforeSessions.every((session) => !session.running),
		"进入拉取请求冒烟前应等待所有会话闲置",
	);
	const bounds = window.getBounds();
	const minimum = window.getMinimumSize();
	const theme = nativeTheme.themeSource;
	const repo = "smoke/plume-review-fixture";
	const title = "Smoke: keep pull request review read-only";
	const otherTitle = "Smoke: update release notes";
	const comment = "Plume smoke comment: this stays on the loopback GitLab server.";
	const token = "plume-smoke-gitlab-token-not-a-real-credential";
	const accountLabel = "Plume smoke GitLab";
	const at = "2026-11-05T08:00:00.000Z";
	const calls: string[] = [];
	const unexpected: string[] = [];
	const posted: string[] = [];
	let notesReadAfterPost = false;
	let baseUrl = "";
	const notes = [{ id: 1, body: "Smoke reviewer: keep this change read-only.", created_at: at, system: false, author: { username: "smoke-reviewer" } }];
	const change = {
		old_path: "src/review.ts",
		new_path: "src/review.ts",
		new_file: false,
		deleted_file: false,
		renamed_file: false,
		diff: '@@ -1 +1 @@\n-export const reviewMode = "write";\n+export const reviewMode = "read-only";\n',
	};
	const mr = (number: number) => ({
		id: 100 + number,
		iid: number,
		project_id: 10,
		title: number === 17 ? title : otherTitle,
		description: "Smoke fixture: inspect the diff without changing the local repository.",
		state: "opened",
		draft: false,
		created_at: at,
		updated_at: at,
		web_url: `${baseUrl}/${repo}/-/merge_requests/${number}`,
		source_branch: "smoke/read-only-review",
		target_branch: "main",
		user_notes_count: notes.length,
		changes_count: "1",
		merge_status: "can_be_merged",
		detailed_merge_status: "mergeable",
		has_conflicts: false,
		labels: ["smoke"],
		author: { id: 2, username: "smoke-author", name: "Smoke Author", avatar_url: null },
		reviewers: [{ username: "smoke-user" }],
		references: { full: `${repo}!${number}` },
		head_pipeline: { id: 41, status: "failed", web_url: `${baseUrl}/${repo}/-/pipelines/41` },
	});
	const server = createServer((request, response) => {
		void (async () => {
			response.setHeader("content-type", "application/json; charset=utf-8");
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const path = decodeURIComponent(url.pathname);
			const key = `${request.method} ${path}`;
			calls.push(key);
			const reply = (body: unknown, status = 200) => {
				response.statusCode = status;
				response.end(JSON.stringify(body));
			};
			if (request.headers["private-token"] !== token) {
				unexpected.push(`未携带固定假令牌：${key}`);
				reply({ message: "Unauthorized" }, 401);
				return;
			}
			if (request.method === "GET" && path === "/api/v4/user") {
				reply({ id: 1, username: "smoke-user", name: "Smoke User", avatar_url: null });
				return;
			}
			if (request.method === "GET" && path === "/api/v4/merge_requests") {
				reply(url.searchParams.get("scope") === "reviews_for_me" ? [mr(17), mr(18)] : []);
				return;
			}
			const prefix = `/api/v4/projects/${repo}`;
			const match = new RegExp(`^${prefix}/merge_requests/(17|18)(/.*)?$`).exec(path);
			if (match) {
				const suffix = match[2] ?? "";
				if (request.method === "POST" && suffix === "/notes") {
					let raw = "";
					for await (const chunk of request) raw += String(chunk);
					const body = (JSON.parse(raw) as { body?: unknown }).body;
					if (body !== comment || match[1] !== "17") {
						unexpected.push(`意外的评论：${key}`);
						reply({ message: "Unexpected comment" }, 400);
						return;
					}
					posted.push(body);
					const note = { id: notes.length + 1, body, created_at: "2026-11-05T09:00:00.000Z", system: false, author: { username: "smoke-user" } };
					notes.push(note);
					reply(note, 201);
					return;
				}
				if (request.method === "GET") {
					if (!suffix) {
						reply(mr(Number(match[1])));
						return;
					}
					if (suffix === "/notes") {
						if (posted.length) notesReadAfterPost = true;
						reply(notes);
						return;
					}
					if (suffix === "/approvals") {
						reply({ approved: false, approvals_required: 1, approved_by: [] });
						return;
					}
					if (suffix === "/commits") {
						reply([{ id: "1234567abcdef", short_id: "1234567", title: "Smoke commit: keep review read-only", author_name: "Smoke Author", created_at: at }]);
						return;
					}
					if (suffix === "/changes") {
						reply({ ...mr(Number(match[1])), changes: [change] });
						return;
					}
					if (suffix === "/diffs") {
						reply([change]);
						return;
					}
					if (suffix === "/pipelines") {
						reply([{ id: 41, status: "failed", web_url: `${baseUrl}/${repo}/-/pipelines/41` }]);
						return;
					}
				}
			}
			if (request.method === "GET" && path === `${prefix}/pipelines/41/jobs`) {
				reply([{ id: 42, name: "smoke-review-check", status: "failed", stage: "test", web_url: `${baseUrl}/${repo}/-/jobs/42` }]);
				return;
			}
			unexpected.push(key);
			reply({ message: "Unimplemented smoke route" }, 404);
		})().catch((error: unknown) => {
			unexpected.push(String(error));
			response.statusCode = 500;
			response.end(JSON.stringify({ message: "Smoke fixture error" }));
		});
	});
	const root = ".plume-pr-page";
	const list = `${root} .plume-pr-list`;
	const detail = `${root} .plume-pr-detail`;
	const settings = '[data-screen="settings"][data-section="plugin:plume.pull-requests/forges"]';
	const nav = '[data-nav="page:plume.pull-requests/pull-requests"]';
	const returnToSession = async () => {
		window.webContents.send("plume:command", `open-session:${original.session}`);
		await until(
			`document.querySelector('[data-plume-row="${original.session}"] > button[aria-current="page"]') !== null && document.querySelector('[data-screen="chat"]') !== null`,
			"回到原会话",
		);
	};
	const openPage = async () => {
		await until(`document.querySelector(${JSON.stringify(nav)}) !== null`, "侧栏出现拉取请求入口");
		await clickVisible(page, nav);
		await until(`document.querySelector('${root}') !== null`, "拉取请求页面打开");
	};
	const selectPr = async () => {
		await clickVisible(page, `${list} .plume-pr-row`, containing(title));
		await until(`document.querySelector('${detail} h1')?.textContent === ${JSON.stringify(title)}`, "列表选中并读到详情");
	};
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		await plugin.install("pull-requests");
		await waitMain(
			async () =>
				(await agent.plugins()).some((status) => status.key === "pull-requests" && status.name === "plume.pull-requests" && status.state === "active"),
			"拉取请求插件安装并 active",
		);
		window.setSize(Math.max(bounds.width, 1200), Math.max(bounds.height, 820));
		await openPage();
		await until(`['未添加代码托管账号', 'No hosting account added'].some(text => document.querySelector('${list}')?.textContent.includes(text))`, "无账号态");
		await capture("smoke-pull-requests-empty.png");
		await click(list, ["添加账号", "Add an account"]);
		await until(`document.querySelector('${settings}') !== null`, "添加账号导航到代码托管设置");
		await click(settings, ["添加账号", "Add an account"]);
		await click('[role="dialog"]', ["GitLab"]);
		await fill('input[name="forge-base-url"]', baseUrl);
		await fill('input[name="forge-token"]', token);
		await fill('input[name="forge-label"]', accountLabel);
		await click('[role="dialog"]', ["验证并保存", "Verify and save"]);
		await until(
			`document.querySelector('[role="dialog"] [role="status"]')?.textContent.includes('smoke-user') && ['已连接', 'Connected'].some(text => document.querySelector('[role="dialog"]')?.textContent.includes(text))`,
			"假 GitLab 身份验证保存成功",
		);
		await capture("smoke-pull-requests-account.png");
		await click('[role="dialog"]', ["完成", "Done"]);
		await until(
			`document.querySelector('[role="dialog"]') === null && document.querySelector('${settings}')?.textContent.includes(${JSON.stringify(accountLabel)})`,
			"账号保存在设置列表",
		);
		await returnToSession();
		await openPage();
		await selectPr();
		await until(
			`document.querySelector('${detail}')?.textContent.includes('failed') && ['1 项失败', '1 failed'].some(text => document.querySelector('${detail}')?.textContent.includes(text))`,
			"失败流水线与失败检查展开",
		);
		await click(detail, ["活动", "Activity"]);
		await until(
			`document.querySelector('${detail}')?.textContent.includes('Smoke commit: keep review read-only') && document.querySelector('${detail}')?.textContent.includes('Smoke reviewer: keep this change read-only.')`,
			"动态包含提交与评论",
		);
		// 只切运行时主题，不写外观偏好，也不覆盖主冒烟已启用的调试器媒体仿真。
		nativeTheme.themeSource = "light";
		await until(`!matchMedia('(prefers-color-scheme: dark)').matches`, "浅色主题生效");
		await capture("smoke-pull-requests-light.png");
		const before = await page<number>(`document.querySelector('${list} .plume-pr-group .plume-reveal').getBoundingClientRect().height`);
		await clickVisibleIn(page, `[document.querySelector('${list} .plume-pr-group')?.querySelector('button')]`, "第一个分组的收起");
		const foldMotion = await page<boolean>(`(async () => {
			const reveal = document.querySelector('${list} .plume-pr-group .plume-reveal');
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const animation = reveal.getAnimations().find(item => item.transitionProperty === 'grid-template-rows');
			if (!animation) return false;
			const duration = animation.effect.getTiming().duration;
			animation.pause(); animation.currentTime = duration / 2;
			const middle = reveal.getBoundingClientRect().height;
			animation.finish();
			return duration > 0 && middle > 0 && middle < ${before};
		})()`);
		assert.ok(foldMotion, "分组收起有真实中间帧，不只是替换展示状态");
		await until(`document.querySelector('${list} .plume-reveal').getBoundingClientRect().height < 1`, "分组收起到零高度");
		await clickVisible(page, `${list} .plume-pr-group-head`);
		await until(`document.querySelector('${list} .plume-reveal').getBoundingClientRect().height > 30`, "分组重新展开");
		nativeTheme.themeSource = "dark";
		await until(`matchMedia('(prefers-color-scheme: dark)').matches`, "深色主题生效");
		await capture("smoke-pull-requests-dark.png");
		await click(detail, ["代码", "Code"]);
		await click(detail, ["全部展开", "Expand all"]);
		await until(
			`document.querySelector('${detail}')?.textContent.includes('src/review.ts') && document.querySelector('${detail}')?.textContent.includes('export const reviewMode') && document.querySelector('${detail}')?.textContent.includes('read-only')`,
			"代码页显示真实解析的 diff",
		);
		await capture("smoke-pull-requests-code.png");

		await fill(`${list} input`, "update release notes");
		await until(
			`[...document.querySelectorAll('${list} .plume-pr-row')].length === 1 && document.querySelector('${list} .plume-pr-row')?.textContent.includes(${JSON.stringify(otherTitle)})`,
			"搜索只保留另一条 PR",
		);
		await fill(`${list} input`, "no-such-smoke-pull-request");
		await until(
			`['没有匹配的 Pull Request', 'No matching pull requests'].some(text => document.querySelector('${list}')?.textContent.includes(text))`,
			"搜索无匹配态",
		);
		await fill(`${list} input`, "");
		await click(detail, ["摘要", "Summary"]);
		await fill(`${detail} textarea`, comment);
		await click(detail, ["发表评论", "Post comment"]);
		await until(
			`document.querySelector('[role="dialog"]')?.textContent.includes(${JSON.stringify(comment)}) && document.querySelector('[role="dialog"]')?.textContent.includes(${JSON.stringify(repo)})`,
			"评论确认框冻结目标与正文",
		);
		assert.equal(posted.length, 0, "确认之前没有向假 GitLab 发送评论");
		await click('[role="dialog"]', ["发表评论", "Post comment"]);
		await waitMain(() => posted.length === 1 && notesReadAfterPost, "评论 POST 后重新读取动态");
		await until(`document.querySelector('${detail} textarea')?.value === ''`, "评论成功后草稿清空");
		// 切换代码再回来会重建摘要，动态默认收起；评论正文须来自重新拉取的 notes。
		await click(detail, ["代码", "Code"]);
		await click(detail, ["摘要", "Summary"]);
		await click(detail, ["活动", "Activity"]);
		await until(`document.querySelector('${detail} .plume-pr-activity')?.textContent.includes(${JSON.stringify(comment)})`, "刷新后的动态显示本地提交的评论");
		await capture("smoke-pull-requests-comment.png");

		window.setMinimumSize(320, 480);
		window.setSize(620, Math.max(700, bounds.height));
		await until(`document.querySelector('${root}')?.dataset.narrow === 'true'`, "窄窗口显示详情");
		await capture("smoke-pull-requests-narrow-detail.png");
		await click(detail, ["全部 Pull Request", "All pull requests"]);
		await until(`document.querySelector('${root}')?.dataset.selected === 'false' && !document.querySelector('${list}')?.inert`, "窄窗口返回列表");
		await capture("smoke-pull-requests-narrow-list.png");
		await selectPr();
		await click(detail, ["让 Agent 审查", "Have the agent review it"]);
		await until(
			`document.querySelector('[data-screen="empty"]') !== null && ${composerText}.includes(${JSON.stringify(title)}) && ${composerText}.includes(${JSON.stringify(`${baseUrl}/${repo}/-/merge_requests/17`)})`,
			"Agent 审查只打开带草稿的新对话",
		);
		const draft = await page<string>(composerText);
		assert.match(draft, /只读，不要改动仓库|Read only — do not change the repository/, "草稿明确要求只读审查");
		const privateDir = join(plumeHome(), "plugin-data", "plume.pull-requests");
		const files = await readdir(privateDir, { recursive: true, withFileTypes: true });
		let scratch: string | undefined;
		for (const entry of files) {
			if (!entry.isFile() || entry.name !== "PR.md") continue;
			const path = join(entry.parentPath, entry.name);
			const content = await readFile(path, "utf8");
			if (content.includes(title) && content.includes(`${baseUrl}/${repo}/-/merge_requests/17`)) {
				scratch = dirname(path);
				break;
			}
		}
		assert.ok(scratch, "找不到匹配 origin 时，实际插件在私有目录准备 PR.md");
		assert.ok(!relative(resolve(privateDir), resolve(scratch)).startsWith(".."), "PR scratch 不越出插件私有数据目录");
		assert.notEqual(resolve(scratch), resolve(workspace), "无匹配 origin 的 PR 不复用当前工作区");
		const sessionStamp = (sessions: typeof beforeSessions) =>
			sessions.map(({ id, updatedAt, running }) => ({ id, updatedAt, running })).sort((a, b) => a.id.localeCompare(b.id));
		assert.deepEqual(sessionStamp(await agent.sessions()), sessionStamp(beforeSessions), "只填草稿，没有创建会话、发送消息或启动 Agent");
		await capture("smoke-pull-requests-agent-draft.png");
		assert.ok(draft.includes('"accountId"') && draft.includes("read_pull_request"), "草稿给出可实际调用的只读工具及账号参数");

		// workspace 是本轮冒烟新建的隔离目录；暂改它的 origin 验证本地匹配，结束后恢复原值。
		const runGit = (...args: string[]) => promisify(execFile)("git", args, { cwd: workspace, timeout: 5000 });
		await runGit("init", "--quiet");
		const oldOrigins = await runGit("config", "--local", "--get-all", "remote.origin.url").then(
			({ stdout }) => stdout.trim().split("\n").filter(Boolean),
			() => [] as string[],
		);
		try {
			await runGit("config", "--local", "--replace-all", "remote.origin.url", `${baseUrl}/${repo}.git`);
			// 上面验完窄窗口后窗口还窄着，侧栏收起（inert），侧栏里的入口人点不到：放回宽窗口再从侧栏进。
			window.setSize(Math.max(bounds.width, 1200), Math.max(bounds.height, 820));
			await returnToSession();
			await openPage();
			await selectPr();
			// 同一个目录可能登记成好几个项目：完整冒烟里会话菜单那段把工作目录另登记成了「菜单迁移目标」，插件取第一个路径对上的。
			// 所以认路径对上的任一项目，不认死名字。
			const stored = JSON.parse(await readFile(join(plumeHome(), "projects.json"), "utf8")) as Array<{ name: string; path: string }>;
			const matching = stored.filter((project) => resolve(project.path) === resolve(workspace)).map((project) => project.name);
			assert.ok(matching.length > 0, "工作目录应该登记成了项目");
			await click(detail, ["让 Agent 审查", "Have the agent review it"]);
			await until(
				`${JSON.stringify(matching)}.some((name) => document.querySelector('[data-screen="empty"] [data-welcome-line]')?.textContent.includes(name)) && ${composerText}.includes('read_pull_request') && ${composerText}.includes('smoke/read-only-review')`,
				"匹配本地项目后在该项目准备审查草稿",
			);
			assert.deepEqual(sessionStamp(await agent.sessions()), sessionStamp(beforeSessions), "本地项目分支同样不自动创建会话或发送");
			await capture("smoke-pull-requests-project-draft.png");
		} finally {
			await runGit("config", "--local", "--unset-all", "remote.origin.url");
			for (const origin of oldOrigins) await runGit("config", "--local", "--add", "remote.origin.url", origin);
		}
		for (const suffix of ["", "/notes", "/approvals", "/commits", "/changes"])
			assert.ok(calls.includes(`GET /api/v4/projects/${repo}/merge_requests/17${suffix}`), `真实插件请求了 MR ${suffix || "详情"}`);
		assert.ok(calls.includes("GET /api/v4/user") && calls.includes("GET /api/v4/merge_requests"), "身份与列表走本地 GitLab HTTP 服务");
		assert.deepEqual(posted, [comment], "只向本地假服务提交一次评论");
		assert.deepEqual(unexpected, [], "没有未覆盖的请求或意外写操作");
		console.log(
			"PLUME_PULL_REQUESTS_SMOKE",
			JSON.stringify({
				installed: true,
				empty: true,
				signedIn: true,
				detail: true,
				diff: true,
				checks: true,
				activity: true,
				search: true,
				comment: true,
				narrow: true,
				themes: ["light", "dark"],
				draftOnly: true,
				checkout: ["scratch", "project"],
				foldMotion: true,
			}),
		);
	} finally {
		try {
			nativeTheme.themeSource = theme;
			window.setMinimumSize(minimum[0]!, minimum[1]!);
			window.setBounds(bounds);
			await until(`matchMedia('(prefers-color-scheme: dark)').matches === ${original.dark}`, "恢复原主题");
			await returnToSession();
			if (original.draft !== null) await until(`${composerText} === ${JSON.stringify(original.draft)}`, "原会话草稿未受影响");
			if (original.nav) {
				await clickVisible(page, `[data-nav="${original.nav}"]`);
				await until(`document.querySelector(${JSON.stringify(`[data-nav="${original.nav}"]`)})?.getAttribute('aria-current') === 'page'`, "恢复原页面");
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve())),
			);
		}
	}
}
