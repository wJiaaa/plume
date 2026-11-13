/**
 * 本体替模型跑命令时守的线（`src/commands.ts`）：三档权限对应三档沙箱；提权只认人答、批了才换档；外层要求只读（`ToolExecution.readOnly`）时
 * 命令一律只读、提权不到人面前，写、改文件的工具不往里交。
 *
 * 沙箱本身换成假的（记下每次起命令要的是哪一档），这里只看本体选了哪一档；沙箱真的拦不拦得住在 `packages/core/sandbox/test/` 和
 * `agent.test.ts` 里 macOS 上的那几条测。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ApprovalContent, ApprovalDecision, ModelContext, PermissionMode, Plugin, SandboxMode, ToolKind, ToolRun } from "@plume/contract";
import { resetSystemShell } from "@plume/platform";
import { commandAccess, settleShell } from "../src/commands.ts";
import { type Agent, createAgent } from "../src/index.ts";
import type { CallCommands } from "../src/tool-run.ts";
import { type FakeModel, type FakeReply, fakeAnthropic } from "../src/testing.ts";
import { BUILTINS } from "./builtins.ts";

/** 每次起命令要的是哪一档、按哪一档选的 shell。 */
const launched: { command: string; mode: SandboxMode; shellMode: SandboxMode }[] = [];

vi.mock("@plume/sandbox", async (actual) => ({
	...(await actual<typeof import("@plume/sandbox")>()),
	runCommand: (command: string, options: { mode: SandboxMode; shellMode: SandboxMode }) => {
		launched.push({ command, mode: options.mode, shellMode: options.shellMode });
		const exits: Array<(code: number | null) => void> = [];
		setImmediate(() => exits.forEach((listener) => listener(0)));
		return { pid: 1, onOutput() {}, onExit: (listener: (code: number | null) => void) => void exits.push(listener), onError() {}, kill() {} };
	},
}));

beforeEach(() => {
	launched.length = 0;
});

/** 一次调用的 `shell`、`exec`、`escalate`；`asked` 记下问到人面前的卡，人答 `answers` 里的（没了就拒）。 */
function call(mode: PermissionMode, { readOnly = false, answers = [] as ApprovalDecision[] } = {}) {
	const asked: ApprovalContent[] = [];
	const access = commandAccess({
		cwd: "/w",
		readOnly,
		permission: async () => mode,
		ask: async (content) => {
			asked.push(content);
			return answers.shift() ?? "reject";
		},
		alive() {},
	} satisfies CallCommands);
	return { ...access, asked };
}

const request = { justification: "要写构建产物", title: "提权运行：构建", detail: "make" };

describe("三档权限对应三档沙箱", () => {
	it.each([
		["ask", "read-only"],
		["auto", "workspace-write"],
		["full", "danger-full-access"],
	] as const)("%s → %s，shell 按同一档选；外层要求只读时一律只读", async (mode, sandbox) => {
		const plain = call(mode);
		expect((await plain.shell()).sandbox).toBe(sandbox);
		expect((await plain.exec("ls")).mode).toBe(sandbox);
		const readOnly = call(mode, { readOnly: true });
		expect((await readOnly.shell()).sandbox).toBe("read-only");
		expect((await readOnly.exec("ls")).mode).toBe("read-only");
		expect(launched).toEqual([
			{ command: "ls", mode: sandbox, shellMode: sandbox },
			{ command: "ls", mode: "read-only", shellMode: "read-only" },
		]);
	});

	it("完全访问不认沙箱的拒绝；受约束的档才认，认出来时交回给模型的说明", async () => {
		expect((await call("full").exec("ls")).denied("Operation not permitted")).toBeUndefined();
		const denial = (await call("ask").exec("ls")).denied("touch: x: Operation not permitted");
		if (process.platform !== "darwin") return expect(denial).toBeUndefined();
		// 说出实际跑的那一档，说清是策略拒绝：模型才不会换个写法再写三遍。
		expect(denial).toContain("当前模式：只读");
		expect(denial).toMatch(/策略拒绝/);
		expect(denial).toMatch(/换个写法重试没有用/);
	});

	it("ModelContext.shell 跟着权限模式和 readOnly 走，每层交接时重算", () => {
		const context = { permissionMode: "auto", readOnly: false, shell: { kind: "posix", label: "zsh", sandbox: "workspace-write" } } as ModelContext;
		expect(settleShell(context).shell.sandbox).toBe("workspace-write");
		expect(settleShell({ ...context, readOnly: true }).shell.sandbox).toBe("read-only");
		expect(settleShell({ ...context, permissionMode: "full" }).shell.sandbox).toBe("danger-full-access");
	});
});

describe("Windows 上点名的 shell", () => {
	const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const realShell = process.env.PLUME_SHELL;
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "plume-shell-"));
	});
	afterEach(async () => {
		Object.defineProperty(process, "platform", realPlatform);
		if (realShell === undefined) delete process.env.PLUME_SHELL;
		else process.env.PLUME_SHELL = realShell;
		resetSystemShell();
		await rm(dir, { recursive: true, force: true });
	});

	it("完全访问点名 Git Bash；外层要求只读（计划模式）时点名 PowerShell，和实际跑命令的一致", async () => {
		Object.defineProperty(process, "platform", { ...realPlatform, value: "win32" });
		const bash = join(dir, "bash.exe");
		await writeFile(bash, "");
		process.env.PLUME_SHELL = bash;
		resetSystemShell();
		const context = { permissionMode: "full", shell: { kind: "posix", label: "", sandbox: "read-only" } } as ModelContext;
		expect(settleShell(context).shell).toMatchObject({ kind: "posix", label: "Git Bash", sandbox: "danger-full-access" });
		expect(settleShell({ ...context, readOnly: true }).shell).toMatchObject({
			kind: "powershell",
			label: expect.stringMatching(/PowerShell/),
			sandbox: "read-only",
		});
	});
});

describe("提权", () => {
	it("批了才换档：人拒绝时这次调用的命令照旧跑在原来那一档，答应了之后的命令跑在批的那一档", async () => {
		const rejected = call("ask", { answers: ["reject"] });
		expect(await rejected.escalate({ mode: "workspace-write", ...request })).toEqual({
			granted: false,
			message:
				"用户拒绝了把这条命令提权到「可写项目目录」。Do not retry it unchanged or get the same effect another way — another tool, a shell command, a script. Change your approach; if the task cannot go on without it, say so.",
		});
		expect((await rejected.exec("make")).mode).toBe("read-only");

		const approved = call("ask", { answers: ["once"] });
		expect(await approved.escalate({ mode: "danger-full-access", ...request })).toEqual({ granted: true });
		expect(approved.asked).toEqual([{ kind: "command", title: "提权运行：构建", detail: "make", reason: "要写构建产物", escalation: "danger-full-access" }]);
		// 命令是照会话宣布的那一档的 shell 写的，换档不换 shell。
		await approved.exec("make");
		expect(launched.at(-1)).toEqual({ command: "make", mode: "danger-full-access", shellMode: "read-only" });
	});

	it("不合规矩的申请不到人面前，说法和原来 bash 的一字不差", async () => {
		const full = call("full", { answers: ["once"] });
		expect(await full.escalate({ mode: "danger-full-access", ...request })).toEqual({
			granted: false,
			message: "「danger-full-access」不比当前的「完全访问」更宽，提权请求无效。",
		});
		const auto = call("auto", { answers: ["once"] });
		expect(await auto.escalate({ mode: "workspace-write", ...request })).toEqual({
			granted: false,
			message: "「workspace-write」不比当前的「可写项目目录」更宽，提权请求无效。",
		});
		// 伪装成提权的收窄。
		expect(await auto.escalate({ mode: "read-only" as "workspace-write", ...request })).toMatchObject({ granted: false });
		expect(await auto.escalate({ mode: "workspace-write", ...request, justification: undefined as unknown as string })).toEqual({
			granted: false,
			message: "提权请求必须带上 justification：弹窗要有一句话告诉用户为什么。",
		});
		expect(await auto.escalate({ mode: "danger-full-access", ...request, justification: "   " })).toEqual({
			granted: false,
			message: "justification 不能是空的。",
		});
		expect([...full.asked, ...auto.asked]).toEqual([]);
	});

	it("批过的一档就是这次调用的当前档：再要同一档无效", async () => {
		const access = call("ask", { answers: ["once"] });
		expect(await access.escalate({ mode: "workspace-write", ...request })).toEqual({ granted: true });
		expect(await access.escalate({ mode: "workspace-write", ...request })).toMatchObject({
			granted: false,
			message: expect.stringMatching(/不比当前的「可写项目目录」更宽/),
		});
	});

	it("只读下提权直接拒，不问人", async () => {
		const access = call("full", { readOnly: true, answers: ["once"] });
		expect(await access.escalate({ mode: "workspace-write", ...request })).toEqual({
			granted: false,
			message:
				"Not run: this conversation may not change files right now, so commands run in a read-only sandbox and may not leave it. Run it without `escalate`.",
		});
		expect(access.asked).toEqual([]);
		expect((await access.exec("make")).mode).toBe("read-only");
	});
});

describe("经 agent 跑一遍", () => {
	let dir: string;
	let workspace: string;
	let model: FakeModel | undefined;
	let agent: Agent | undefined;
	const watching = new AbortController();

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "plume-commands-"));
		workspace = join(dir, "workspace");
		await mkdir(workspace);
	});
	afterEach(async () => {
		await agent?.shutdown();
		await model?.close();
		agent = model = undefined;
		await rm(dir, { recursive: true, force: true });
	});

	async function start(replies: FakeReply[], plugins: Plugin[] = []) {
		model = await fakeAnthropic(replies);
		agent = await createAgent({
			dataDir: join(dir, "data"),
			settingsFile: join(dir, "model.json"),
			plugins: [...BUILTINS, ...plugins.map((plugin) => ({ key: plugin.name, load: async () => plugin }))],
			log: () => undefined,
		});
		const service = agent.service;
		await service.saveProvider({
			id: "",
			name: "假模型",
			api: "anthropic-messages",
			baseUrl: model.url,
			enabled: true,
			models: [
				{ modelId: "fake", name: "fake", contextWindow: 200_000, maxOutputTokens: 32_000, supportsThinking: false, supportsImages: false, supportsTools: true },
			],
			apiKey: "test-key",
		});
		const session = await service.createSession({ cwd: workspace });
		const events: AgentEvent[] = [];
		const waiters = new Set<() => void>();
		void (async () => {
			for await (const event of service.watch({ signal: watching.signal })) {
				events.push(event);
				for (const waiter of waiters) waiter();
			}
		})();
		const until = <E extends AgentEvent>(match: (event: AgentEvent) => event is E): Promise<E> =>
			new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("等待事件超时")), 5_000);
				const check = () => {
					const found = events.find(match);
					if (!found) return;
					clearTimeout(timer);
					waiters.delete(check);
					resolve(found);
				};
				waiters.add(check);
				check();
			});
		const from = events.length;
		const idle = () =>
			until((event): event is AgentEvent => events.indexOf(event) >= from && event.type === "sessions" && event.sessions.every((summary) => !summary.running));
		const results = async () => (await service.getSession(session.id)).messages.filter((message) => message.role === "toolResult");
		return { service, session, events, until, idle, results };
	}

	type Approval = Extract<AgentEvent, { type: "approval" }>;
	const card =
		(id: string) =>
		(event: AgentEvent): event is Approval =>
			event.type === "approval" && event.approval?.toolCallId === id;
	const text = (message: { content: unknown }) => (message.content as { text?: string }[]).map((part) => part.text ?? "").join("");

	/** 申请提权、再跑一条命令，交回批没批和命令跑在哪一档。 */
	const escalator: Plugin = {
		name: "test.escalator",
		apply(ctx) {
			ctx.tools.register({
				name: "escalator",
				description: "提权再跑",
				parameters: { type: "object", properties: {} },
				kind: "command",
				async execute(_args, run: ToolRun) {
					const outcome = await run.escalate({ mode: "workspace-write", justification: "要写", title: "提权", detail: "make" });
					return { output: JSON.stringify({ outcome, mode: (await run.exec("make")).mode }) };
				},
			});
		},
	};

	it("提权只认人答：完全访问、tool.approve 层的放行、「以后不再问」都不替人答，批了才换档", async () => {
		const passer: Plugin = { name: "test.passer", apply: (ctx) => ctx.hook("tool.approve", async () => "always") };
		const first = { id: "call_first", name: "escalator", args: {} };
		const second = { id: "call_second", name: "escalator", args: {} };
		const { service, session, until, idle, results } = await start([{ toolCalls: [first] }, { toolCalls: [second] }, { text: "好了" }], [escalator, passer]);
		await service.setPermissionMode("ask");

		const done = idle();
		service.send(session.id, { content: [{ type: "text", text: "跑" }] });
		expect((await until(card("call_first"))).approval).toMatchObject({
			kind: "command",
			title: "提权",
			detail: "make",
			reason: "要写",
			escalation: "workspace-write",
		});
		service.respond(session.id, "call_first", "reject");
		await until(card("call_second"));
		service.respond(session.id, "call_second", "always");
		await done;

		const [rejected, approved] = (await results()).map((message) => JSON.parse(text(message)) as { outcome: { granted: boolean }; mode: SandboxMode });
		expect(rejected).toMatchObject({ outcome: { granted: false }, mode: "read-only" });
		expect(approved).toEqual({ outcome: { granted: true }, mode: "workspace-write" });
		// 人答的「以后不再问」也不记：提权批一次算一次。
		const stored = JSON.parse(await readFile(join(dir, "model.json"), "utf8")) as { alwaysAllow?: string[] };
		expect(stored.alwaysAllow ?? []).toEqual([]);
	});

	/** 外层要求只读；里层记下交到它手里的调用。 */
	function readOnlyLayers(seen: string[]): Plugin {
		return {
			name: "test.read-only",
			apply(ctx) {
				ctx.hook("tool.execute", (input, next) => next({ ...input, readOnly: { refusal: `不改文件，所以 "${input.call.name}" 没跑` } }), { order: -10 });
				ctx.hook("tool.execute", (input, next) => (seen.push(input.call.name), next(input)), { order: 10 });
				for (const [name, kind] of [
					["creator", "create"],
					["modifier", "modify"],
					["reader", "read"],
					["plain", undefined],
				] as [string, ToolKind | undefined][]) {
					ctx.tools.register({
						name,
						description: name,
						parameters: { type: "object", properties: {} },
						...(kind ? { kind } : {}),
						execute: async () => ({ output: `${name} ran` }),
					});
				}
			},
		};
	}

	it("只读下写、改文件的工具不往里交（里层钩子看不到），给模型的是外层给的话；别的照常交下去", async () => {
		const seen: string[] = [];
		const calls = ["creator", "modifier", "reader", "plain"].map((name) => ({ id: `call_${name}`, name, args: {} }));
		const { service, session, idle, results } = await start([{ toolCalls: calls }, { text: "好了" }], [readOnlyLayers(seen)]);
		await service.setPermissionMode("full");
		const done = idle();
		service.send(session.id, { content: [{ type: "text", text: "做" }] });
		await done;

		const outputs = (await results()).map((message) => ({ text: text(message), isError: message.role === "toolResult" && message.isError }));
		expect(outputs).toEqual([
			{ text: '不改文件，所以 "creator" 没跑', isError: true },
			{ text: '不改文件，所以 "modifier" 没跑', isError: true },
			{ text: "reader ran", isError: false },
			{ text: "plain ran", isError: false },
		]);
		expect(seen).toEqual(["reader", "plain"]);
	});

	it("只读下 bash 带提权被拒、不问人，命令没跑；不带提权的跑在只读沙箱里", async () => {
		const escalated = { id: "call_escalated", name: "bash", args: { command: "make", escalate: "workspace-write", justification: "要写" } };
		const plain = { id: "call_plain", name: "bash", args: { command: "make -n" } };
		const { service, session, events, idle, results } = await start(
			[{ toolCalls: [escalated] }, { toolCalls: [plain] }, { text: "好了" }],
			[readOnlyLayers([])],
		);
		await service.setPermissionMode("full");
		const done = idle();
		service.send(session.id, { content: [{ type: "text", text: "做" }] });
		await done;

		const [refused, ran] = await results();
		expect(refused).toMatchObject({ toolCallId: "call_escalated", isError: true });
		expect(text(refused!)).toBe(
			"Not run: this conversation may not change files right now, so commands run in a read-only sandbox and may not leave it. Run it without `escalate`.",
		);
		expect(ran).toMatchObject({ toolCallId: "call_plain", isError: false });
		expect(events.some((event) => event.type === "approval" && event.approval !== undefined)).toBe(false);
		expect(launched.map(({ command, mode }) => ({ command, mode }))).toEqual([{ command: "make -n", mode: "read-only" }]);
	});
});
