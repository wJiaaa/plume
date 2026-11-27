import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import browserPlugin from "../../../builtin/browser/src/index.ts";
import { createAgent, type Agent } from "../src/agent.ts";
import { fakeAnthropic, type FakeModel } from "../src/testing.ts";

let dir: string | undefined;
let agent: Agent | undefined;
let model: FakeModel | undefined;

afterEach(async () => {
	await agent?.shutdown();
	await model?.close();
	agent = undefined;
	model = undefined;
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

it("browser_screenshot 卡住时按停立即中止、还原对话框托管，且会话可继续发消息", async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-browser-shot-"));
	const captureEntered = Promise.withResolvers<void>();
	const dialogStates: Array<boolean | null> = [];
	let requests = 0;
	model = await fakeAnthropic((request) => {
		requests++;
		const text = JSON.stringify(request.messages ?? []);
		if (!text.includes("shot_hang")) return { toolCalls: [{ id: "shot_hang", name: "browser_screenshot", args: { tabId: "tab-1" } }] };
		return { text: "恢复正常" };
	});

	agent = await createAgent({
		dataDir: dir,
		settingsFile: join(dir, "settings.json"),
		plugins: [{ key: "browser", builtin: true, load: async () => browserPlugin }],
		pages: {
			async call(_plugin, _id, method, args) {
				if (method === "answerDialogs") {
					dialogStates.push(args[0] as boolean | null);
					return;
				}
				if (method === "capture") {
					captureEntered.resolve();
					// 模拟底层 capturePage 永久不返回。
					return await new Promise(() => {});
				}
				return;
			},
		},
		log: () => undefined,
	});
	const service = agent.service;
	await service.saveProvider({
		id: "",
		name: "测试",
		api: "anthropic-messages",
		baseUrl: model.url,
		enabled: true,
		apiKey: "private-test-key",
		models: [
			{
				modelId: "fake",
				name: "fake",
				contextWindow: 200_000,
				maxOutputTokens: 32_000,
				supportsThinking: false,
				supportsImages: true,
				supportsTools: true,
			},
		],
	});

	const session = await service.createSession({ cwd: dir });
	// 预先登记一页并标成已挂上、可读取，让 browser_screenshot 直接落到 capture 调用。
	await service.callPlugin("plume.browser", "ensure", ["tab-1", session.id], { signal: new AbortController().signal });
	agent.host.pageEvent("plume.browser", {
		type: "attached",
		page: "tab-1",
		state: { url: "https://example.com/", title: "Example", loading: false, canGoBack: false, canGoForward: false, crashed: false, zoom: 1 },
	});

	service.send(session.id, { content: [{ type: "text", text: "截个图" }] });
	await captureEntered.promise;
	// 截图期间停下：不应再死等 capturePage，须立刻收场并把对话框交回给用户。
	service.stop(session.id);
	await vi.waitFor(
		async () => {
			const view = await service.getSession(session.id);
			expect(view.summary.running).toBe(false);
			expect(view.summary.stop).toEqual({ reason: "aborted" });
		},
		{ timeout: 3_000, interval: 10 },
	);
	const stopped = await service.getSession(session.id);
	const shotResult = stopped.messages.find((message) => message.role === "toolResult" && message.toolCallId === "shot_hang");
	expect(shotResult).toMatchObject({ role: "toolResult", isError: true, details: { cancelled: true } });
	expect(dialogStates.at(-1)).toBeNull();

	// 停下后会话解锁，再发新消息能立刻跑完。
	service.send(session.id, { content: [{ type: "text", text: "继续" }] });
	await vi.waitFor(
		async () => {
			const view = await service.getSession(session.id);
			expect(view.summary.running).toBe(false);
			expect(view.summary.stop).toEqual({ reason: "done" });
		},
		{ timeout: 3_000, interval: 10 },
	);
	expect(requests).toBe(2);
});
