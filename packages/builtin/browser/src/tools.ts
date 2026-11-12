/**
 * 给模型的浏览器工具：操作的就是人在面板里看到的那些页，按会话分开。
 *
 * 只有 `browser_open` 把面板切到那一页、展开面板区——人看得到 agent 去了哪里；之后的点按、输入不抢面板，
 * 人可能正在看别的东西。
 */

import { basename } from "node:path";
import type { Locale, ToolDefinition, ToolOutput, ToolRun, WebInputEvent, WebPages } from "@plume/contract";
import { validViewport, validZoom, webUrl } from "./address.ts";
import { describeNotices, type Dialogs } from "./dialogs.ts";
import { localPath, type LocalPages } from "./local.ts";
import { MESSAGES } from "./messages.ts";
import { evaluate, locate, READ_DEFAULT_CHARS, READ_MAX_CHARS, snapshotPage, waitForContent, waitPage, type ReadOptions, type Target } from "./page-scripts.ts";
import type { Workspace } from "./workspace.ts";

// i18n-exempt：工具的说明、参数和结果都是给模型的；审批卡上的标题给人看，按界面语言取。

const ACTIONS = ["click", "type", "links", "eval", "read", "scroll", "press", "hover", "back", "forward", "reload", "wait"] as const;
type Action = (typeof ACTIONS)[number];
const KEYS = ["Enter", "Tab", "Escape", "Backspace", "Delete", "Up", "Down", "Left", "Right", "Space", "Home", "End"];
const DIALOG = {
	type: "string",
	enum: ["accept", "dismiss"],
	description: "How to answer a confirm or leave-page prompt the page raises during this call. Default dismiss; alerts are always acknowledged.",
};

const MAX_CHARS = { type: "number", description: `Characters of page text to return, default ${READ_DEFAULT_CHARS}, at most ${READ_MAX_CHARS}.` };

/** 字数、偏移：不是非负整数的直接报掉，不悄悄换成别的值。 */
function checkNumbers(args: Record<string, unknown>, names: string[]): void {
	for (const name of names)
		if (args[name] !== undefined && (typeof args[name] !== "number" || !Number.isInteger(args[name]) || (args[name] as number) < 0))
			throw new Error(`${name} must be a whole number of characters`);
}

function result(value: unknown): ToolOutput {
	return { output: `<browser-data untrusted="true">\n${JSON.stringify(value, null, 2)}\n</browser-data>` };
}
function fail(error: unknown): ToolOutput {
	return { output: error instanceof Error ? error.message : String(error), isError: true };
}

/** `question` 查工具表里问人的那件工具叫什么（`category: "question"`）：要人登录、过验证、操作别的窗口时结果里点名它。 */
export function browserTools(
	web: WebPages,
	workspace: Workspace,
	dialogs: Dialogs,
	local: LocalPages,
	locale: () => Locale,
	question: () => string | undefined,
): ToolDefinition[] {
	const read = async (id: string, options: ReadOptions = {}) => {
		const page = await snapshotPage(web, id, workspace.refs(id), { ...options, question: question() });
		workspace.setRefs(id, page.next);
		const { next: _next, ...rest } = page;
		return rest;
	};

	/** 给了 tabId 用它（要是这个会话的），否则用这个会话当前的一页；交回时文档已经能读。 */
	const current = async (tabId: unknown, sessionId: string) => {
		const page = typeof tabId === "string" ? workspace.page(tabId) : workspace.current(sessionId);
		if (!page) throw new Error(typeof tabId === "string" ? "No such browser tab; list them with browser_tabs" : "Open a page with browser_open first");
		await workspace.loaded(page.id, sessionId);
		return page.id;
	};

	/** 把 agent 的落点换成页面的坐标：CSS 像素乘上缩放和视口仿真缩小的比例。 */
	const position = (id: string, point: { x: number; y: number }) => {
		const factor = (workspace.page(id)?.zoom ?? 1) * workspace.scale(id);
		return { x: Math.round(point.x * factor), y: Math.round(point.y * factor) };
	};

	async function act(id: string, args: Record<string, unknown>, action: Action, sessionId: string): Promise<unknown> {
		const maxChars = args.maxChars as number | undefined;
		if (action === "read") {
			// 人开着的、点完链接没读的页可能还空着：有字就不等。
			await waitForContent(web, id, false);
			return read(id, { selector: args.selector as string | undefined, offset: args.offset as number | undefined, maxChars });
		}
		// 换了一页，读回来的就是 agent 下一步要看的东西，省掉紧跟着的那次 read。
		if (action === "back" || action === "forward" || action === "reload") {
			await workspace.history(id, action, sessionId);
			await waitForContent(web, id, true);
			return read(id, { maxChars });
		}
		const done = await perform(id, args, action, sessionId);
		if (args.read !== true) return done;
		// 动作连同它的结果一次交回：点完、输完、等到以后不必再单独花一轮读。换了文档的先等新页显出内容。
		await waitForContent(web, id, (done as { navigated?: boolean }).navigated === true);
		const page = await read(id, { maxChars });
		return done && typeof done === "object" && !Array.isArray(done) ? { ...done, page } : { result: done, page };
	}

	async function perform(
		id: string,
		args: Record<string, unknown>,
		action: Exclude<Action, "read" | "back" | "forward" | "reload">,
		sessionId: string,
	): Promise<unknown> {
		if (action === "wait")
			return waitPage(
				web,
				id,
				{
					text: args.text as string | undefined,
					selector: args.selector as string | undefined,
					expression: args.expression as string | undefined,
					timeout: args.timeout as number | undefined,
				},
				() => workspace.page(id)?.url ?? "",
			);
		if (action === "links") return evaluate(web, id, "Array.from(document.querySelectorAll('a[href]')).slice(0,200).map(a=>({text:a.innerText,href:a.href}))");
		if (action === "eval") {
			if (typeof args.expression !== "string" || !args.expression) throw new Error("eval needs expression");
			return evaluate(web, id, args.expression, false);
		}
		if (action === "scroll") {
			const x = (args.x as number | undefined) ?? 0;
			const y = (args.y as number | undefined) ?? 0;
			workspace.point(id, { ...(await locate(web, id, {}, false)), action: "scroll" });
			return evaluate(web, id, `window.scrollBy({left:${x},top:${y},behavior:'instant'})`);
		}
		if (action === "press") {
			const key = args.text;
			if (typeof key !== "string" || !KEYS.includes(key)) throw new Error(`press needs text set to one of ${KEYS.join("/")}`);
			await web.focus(id);
			const pointer = workspace.page(id)?.pointer;
			workspace.point(id, { ...(pointer ?? (await locate(web, id, {}, false))), action: "press" });
			await web.input(id, { type: "keyDown", keyCode: key });
			await web.input(id, { type: "keyUp", keyCode: key });
			return { pressed: key };
		}
		if (!args.ref && !args.selector) throw new Error("This action needs a ref from read, or a selector checked against the current page");
		await web.focus(id);
		const target: Target = typeof args.ref === "string" ? { ref: args.ref } : { selector: args.selector as string };
		const point = await locate(web, id, target, action !== "hover");
		workspace.point(id, { ...point, action });
		const at = position(id, point);
		await web.input(id, { type: "mouseMove", ...at });
		if (action === "hover") return point;
		/*
		 * 点的是链接、提交按钮时，下面那一帧要在一张正被卸掉的文档里等，脚本永远回不来：每点一次链接都白等满时限、报
		 * 「页面没有响应」，而页面其实已经过去了。所以点之前就听着主框架换文档，换了就去等新页。
		 */
		const leave = workspace.navigates(id);
		const press = (type: "mouseDown" | "mouseUp"): WebInputEvent => ({ type, ...at, button: "left", clickCount: 1 });
		try {
			await web.input(id, press("mouseDown"));
			await web.input(id, press("mouseUp"));
			/*
			 * 原生输入在页面里排队，等一帧才看得到它落下后的焦点和 DOM。一帧，或没有帧时 0.1 秒：会话不在眼前的那一页挂在
			 * 看不见的面板里，不画帧，只等帧会每点一次都等满时限。
			 */
			const frame = evaluate(web, id, "new Promise((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 100); })").then(
				() => false as const,
			);
			const navigated = await Promise.race([frame, leave.left]);
			if (navigated) {
				void frame.catch(() => {});
				await workspace.loaded(id, sessionId);
				return { action, url: workspace.page(id)?.url, point, navigated: true };
			}
		} finally {
			leave.stop();
		}
		if (action === "type") {
			if (typeof args.text !== "string") throw new Error("type needs text");
			await evaluate(
				web,
				id,
				"(() => {const el=document.activeElement;if(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement){el.select();}else if(el?.isContentEditable){const s=getSelection();const r=document.createRange();r.selectNodeContents(el);s.removeAllRanges();s.addRange(r);}else{throw new Error('The target is not an editable field');}})()",
			);
			await web.insertText(id, args.text);
		}
		return { action, url: workspace.page(id)?.url, point };
	}

	const tools: ToolDefinition[] = [
		{
			name: "browser_open",
			mutating: true,
			asks: true,
			description:
				"Open an http(s) URL, or a local .html file (absolute, ~/ or relative to the working directory), in the built-in browser beside the conversation; waits until the page shows content (at most about 5s) and returns tabId, the rendered text and interactive elements, as read does, so no separate wait or read is needed. " +
				"A local file is served on its own: files beside it (styles, scripts, images) do not load, and reopening it after an edit reloads it. " +
				"Reuses this session's selected tab unless newTab; a page already open here is reloaded in its own tab.",
			parameters: {
				type: "object",
				properties: { url: { type: "string" }, newTab: { type: "boolean" }, maxChars: MAX_CHARS, dialog: DIALOG },
				required: ["url"],
				additionalProperties: false,
			},
			async execute(args, run) {
				if (typeof args.url !== "string") throw new Error("url must be an address");
				checkNumbers(args, ["maxChars"]);
				// 本机文件按路径问：人答的是让不让它读这个文件，不是让不让它上 127.0.0.1。
				const file = localPath(args.url, run.cwd);
				const url = file ? null : new URL(webUrl(args.url));
				// 打不开的文件（不存在、太大）先报掉，不拿一个注定落空的问题去问人。
				const href = file ? await local.address(file) : url!.href;
				const approval = await run.ask(
					file
						? { kind: "browser_open", title: MESSAGES[locale()].approvalTitle(basename(file)), detail: file, subject: file }
						: { kind: "browser_open", title: MESSAGES[locale()].approvalTitle(url!.host || url!.href), detail: url!.href, subject: url!.origin },
				);
				if (approval === "reject") throw new Error("The user declined opening this page");
				const id = await workspace.open(href, run.sessionId, { newTab: args.newTab === true, reveal: true });
				await workspace.loaded(id, run.sessionId);
				// 打不开的站点交回来的是 Chromium 的空白错误页：读它什么也看不出，直接说没打开、为什么。
				const failure = workspace.page(id)?.failure;
				if (failure?.kind === "load") throw new Error(`The page did not open: ${failure.detail} (${file ?? href}); the tab is still there to retry later`);
				if (failure?.kind === "blocked")
					throw new Error(
						`The page did not open: ${file ?? href} sent the tab to ${failure.detail}, which is not a web page, so the built-in browser did not follow; it most likely wants to launch a desktop app`,
					);
				// 文档能读时靠脚本渲染的页多半还空着：等它显出内容再读，不让 agent 拿着一张空页再花一轮。
				await waitForContent(web, id, true);
				return result({ tabId: id, page: await read(id, { maxChars: args.maxChars as number | undefined }) });
			},
		},
		{
			name: "browser_act",
			mutating: true,
			asks: true,
			description:
				"Operate this session's tab. read returns the rendered text and one line per interactive element with its ref; it waits for a page that shows nothing yet. " +
				`The text comes ${READ_DEFAULT_CHARS} characters at a time (maxChars, at most ${READ_MAX_CHARS}); when truncated, read again with offset set to the returned nextOffset. read with a selector reads only that region, text and elements. ` +
				"click/type/hover take a ref from read (such as e12), or else a CSS selector seen in the current page, and wait up to 3s for the element to be visible, enabled and not covered; type replaces the field's value; scroll takes x/y pixel deltas; press, a named key; eval, a JavaScript expression; " +
				"wait, until text appears, selector is visible or expression is truthy (timeout ms, default 10000, at most 30000), across navigations; back/forward/reload wait for the page and return it as read does. " +
				"Pass read: true on any other action to get the page back with its result (after a click that leaves the page, the new page once it shows content), instead of spending a separate call on read. " +
				"Steps already decided (fill several fields, then submit) can go as several browser_act calls in one reply; they run in order, and once one fails the rest are not run. Verify with read or wait, not fixed sleeps.",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: [...ACTIONS] },
					tabId: { type: "string" },
					ref: { type: "string" },
					selector: { type: "string" },
					text: { type: "string" },
					expression: { type: "string" },
					x: { type: "number" },
					y: { type: "number" },
					timeout: { type: "number" },
					read: { type: "boolean", description: "Also return the page as read does after this action." },
					offset: { type: "number", description: "read: start the text at this character, the nextOffset of the previous read." },
					maxChars: MAX_CHARS,
					dialog: DIALOG,
				},
				required: ["action"],
				additionalProperties: false,
			},
			async execute(args, run) {
				const action = ACTIONS.find((name) => name === args.action);
				if (!action) throw new Error("Unknown browser action");
				if (args.ref !== undefined && (typeof args.ref !== "string" || !/^e\d+$/.test(args.ref)))
					throw new Error("A ref is e followed by a number from read, such as e12");
				for (const name of ["selector", "text", "expression"])
					if (args[name] !== undefined && typeof args[name] !== "string") throw new Error(`${name} must be a string`);
				for (const name of ["x", "y", "timeout"])
					if (args[name] !== undefined && (typeof args[name] !== "number" || !Number.isFinite(args[name]))) throw new Error(`${name} must be a number`);
				checkNumbers(args, ["offset", "maxChars"]);
				if (args.read !== undefined && typeof args.read !== "boolean") throw new Error("read must be true or false");
				const id = await current(args.tabId, run.sessionId);
				workspace.select(id);
				return result(await act(id, args, action, run.sessionId));
			},
		},
		{
			name: "browser_tabs",
			mutating: true,
			asks: true,
			description: "List this session's browser tabs, or select/close one by tabId.",
			parameters: {
				type: "object",
				properties: { action: { type: "string", enum: ["list", "select", "close"] }, tabId: { type: "string" } },
				required: ["action"],
				additionalProperties: false,
			},
			async execute(args, run) {
				if (args.action === "select") workspace.select(await current(args.tabId, run.sessionId));
				else if (args.action === "close") workspace.close(await current(args.tabId, run.sessionId));
				else if (args.action !== "list") throw new Error("Unknown tab action");
				return result(
					workspace
						.pages()
						.filter((page) => page.sessionId === run.sessionId)
						.map(({ id, url, title, loading, zoom, viewport }) => ({ id, url, title, loading, zoom, viewport })),
				);
			},
		},
		{
			// 只看不动：不问人，能和相邻的只读调用一起跑；browser_act 这些会改页面的不会和它同时跑。
			name: "browser_screenshot",
			description: "Capture what this session's tab shows at its current scroll position and viewport, as a PNG one pixel per CSS pixel at zoom 1.",
			parameters: { type: "object", properties: { tabId: { type: "string" } }, additionalProperties: false },
			async execute(args, run) {
				const id = await current(args.tabId, run.sessionId);
				const shot = await web.capture(id, { points: true });
				const page = workspace.page(id);
				return {
					output: `Screenshot of ${page?.title || page?.url || id} (${page?.url ?? ""}).`,
					images: [{ data: shot.slice(shot.indexOf(",") + 1), mimeType: "image/png" }],
				};
			},
		},
		{
			name: "browser_viewport",
			mutating: true,
			asks: true,
			description:
				"Set zoom (0.25–3) and/or width and height in CSS pixels (240–3840 × 240–2160); reset restores the panel's viewport. Returns innerWidth, innerHeight and devicePixelRatio.",
			parameters: {
				type: "object",
				properties: { tabId: { type: "string" }, zoom: { type: "number" }, width: { type: "number" }, height: { type: "number" }, reset: { type: "boolean" } },
				additionalProperties: false,
			},
			async execute(args, run) {
				const id = await current(args.tabId, run.sessionId);
				if (args.zoom !== undefined) {
					if (!validZoom(args.zoom)) throw new Error("zoom must be between 0.25 and 3");
					await workspace.zoom(id, args.zoom);
				}
				if (args.reset === true) await workspace.viewport(id, null);
				else if (args.width !== undefined || args.height !== undefined) {
					const viewport = { width: args.width, height: args.height };
					if (!validViewport(viewport)) throw new Error("width and height must be given together, as whole numbers within 240–3840 × 240–2160");
					await workspace.viewport(id, viewport);
				}
				return result(await evaluate(web, id, "({width:innerWidth,height:innerHeight,devicePixelRatio})"));
			},
		},
	];

	/*
	 * 一步回复里失败过的浏览器调用，按会话。同一步里排在它后面的 browser_act 是照着它成功写的（填完这一栏再点提交），它没成，
	 * 接着点下去落在的是另一个样子的页面上：不执行，让 agent 先看页面。读页面的不拦，它正是下一步要做的。
	 */
	const failedSteps = new Map<string, { step: string; tool: string }>();

	// 页面在调用期间弹出的对话框由宿主替它答，答了什么、开了什么新窗口写进结果，见 dialogs.ts。
	return tools.map((tool): ToolDefinition => ({
		...tool,
		async execute(args: Record<string, unknown>, run: ToolRun) {
			const step = run.calls.map((call) => call.id).join(" ");
			const failed = failedSteps.get(run.sessionId);
			if (failed?.step !== step) failedSteps.delete(run.sessionId);
			else if (tool.name === "browser_act" && args.action !== "read" && args.action !== "links")
				return {
					output: `Not run: an earlier ${failed.tool} call in this reply failed, and this one assumed it had succeeded. Read the page before going on.`,
					isError: true,
				};
			workspace.engage(run.sessionId);
			const { value, met } = await dialogs.answering(run.sessionId, args.dialog === "accept", () => tool.execute(args, run).catch(fail));
			if (value.isError) failedSteps.set(run.sessionId, { step, tool: tool.name });
			return met.length === 0 ? value : { ...value, output: `${value.output}\n${describeNotices(met, question())}` };
		},
	}));
}
