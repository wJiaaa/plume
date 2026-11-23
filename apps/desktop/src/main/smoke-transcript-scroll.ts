import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { BrowserWindow } from "electron";
import { clickVisible } from "./smoke-kit.ts";
import { checkMarkdownWidths } from "./smoke-markdown-width.ts";

const PROMPT = "列一下目录，然后长篇说明";
const CALLS = Array.from({ length: 6 }, (_, index) => `toolu_scroll_${index + 1}`);
/** 第二轮：又一个工具组，后面只跟一句短话，于是贴着底部时工具组标题就在视口里。 */
const PROMPT_AGAIN = "再列一次";
const CALLS_AGAIN = Array.from({ length: 6 }, (_, index) => `toolu_scroll_again_${index + 1}`);
/**
 * 第三轮：工具行一行一行流进一张点开着的卡片，人贴着底部看。先回两次调用，好让这一组能点开；第二批参数切成小块慢慢流，
 * 一行隔两百来毫秒冒出来一行，和真模型一次发出一串调用时差不多。
 */
const PROMPT_ROWS = "一个一个浏览目录";
const ROWS_FIRST = Array.from({ length: 2 }, (_, index) => `toolu_rows_first_${index + 1}`);
const ROWS_STREAM = Array.from({ length: 14 }, (_, index) => `toolu_rows_stream_${index + 1}`);
const PROMPT_DETAILS = "读取长 CSS 并修改，然后继续长篇说明";
const DETAIL_READ = "toolu_scroll_detail_read";
const DETAIL_EDIT = "toolu_scroll_detail_edit";
const DETAIL_FILE = "transcript-scroll.css";
const CSS = Array.from({ length: 200 }, (_, index) => `.scroll-rule-${index + 1} { color: var(--plume-ink); margin: ${index + 1}px; }`).join("\n");
const REPLY = Array.from(
	{ length: 70 },
	(_, index) => `第 ${index + 1} 段：这是一段用来撑长转录的说明文字，回复一边写一边长，跟随底部要把它平稳地带进视口。`,
).join("\n\n");

/** 一帧的读数：滚动面的位置和高度、被点的标题在视口里的高度、视口底下露出的空白。 */
interface Frame {
	t: number;
	top: number;
	height: number;
	view: number;
	head: number | null;
	blank: number;
	/** 运行行的下沿高出视口下沿多少，负的是被压到了视口外；没有运行行时是 null。 */
	running: number | null;
	/** 内容下沿比视口下沿低多少：跟着底部时就是落后了多少最新的字。 */
	lag: number;
}

interface Phase {
	name: string;
	frames: Frame[];
}

/**
 * 转录里点开、收起工具组时滚动面稳不稳（`PLUME_SMOKE_ONLY=transcript-scroll`）。
 *
 * 假模型先调六次 `ls` 合成一个工具组，再慢慢写一段长回复。回复写着的时候真点（`sendInputEvent`，`onPointerDown` 才收得到）
 * 工具组标题展开、再收起；写完以后贴着底部再点一遍，点字和点箭头各一遍（箭头是 SVG，按下时的目标不是 HTMLElement）。每一帧记下滚动位置、标题高度、视口底下的空白，量出来的数写进
 * `transcript-scroll.json`，超出的直接失败：
 *
 * - 被点的标题在展开、收起的那段时间里不能被推着走，跟着底部时点开也一样（不再跟着底部，见 `useFollowBottom` 的 `hold`）；
 * - 位置不往回跳；
 * - 视口底下不能空出来（内容到不了视口底，却又不是在顶上）——贴着底部收起除外：那时位置留在原处，收起的那截变成
 *   底下的一块空（`useFollowBottom` 的 `slackRef`），往上滚一下再滚回底部，它就得没了。
 *
 * 第三轮工具行一行一行流进点开着的卡片，人贴着底部看：上面的内容往上走要连成一条，不能来一行顶一下、停一下；
 * 卡片下面的运行行不能被顶出视口；一轮收尾时回复的字不能先画出来又收回去（页面跟着上下跳）。
 * 另在同一转录调真实 read / edit：回复继续生成时开合 200 行 CSS 和 400 行 diff，读到后部、保留语法高亮、收起不重新新增高亮节点。
 * 开合帧耗时写进同一份 JSON 的 details，并逐次输出 PLUME_SMOKE_DETAIL_TOGGLE；只记录，不设性能通过门槛。
 */
export async function checkTranscriptScroll(options: {
	window: BrowserWindow;
	workspace: string;
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
	capture(window: BrowserWindow, path: string): Promise<void>;
}): Promise<void> {
	const { window, workspace, outDir, setModel, capture } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const until = async (code: string, label: string, timeoutMs = 20_000) => {
		const end = Date.now() + timeoutMs;
		while (!(await page<boolean>(code))) {
			if (Date.now() > end) throw new Error(`转录滚动等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	let detailStreaming = false;
	setModel((request) => {
		const messages = JSON.stringify(request.messages);
		if (detailStreaming) {
			if (messages.includes(DETAIL_EDIT)) return { text: REPLY.repeat(8), stream: { chunkSize: 18, delayMs: 30 } };
			if (messages.includes(DETAIL_READ))
				return {
					toolCalls: [
						{
							id: DETAIL_EDIT,
							name: "edit",
							args: { path: join(workspace, DETAIL_FILE), old_string: CSS, new_string: CSS.replaceAll("var(--plume-ink)", "var(--plume-ink-muted)") },
						},
					],
				};
			return { toolCalls: [{ id: DETAIL_READ, name: "read", args: { path: join(workspace, DETAIL_FILE), limit: 200 } }] };
		}
		// 后几轮的请求里带着前几轮的整段历史，所以越晚的一轮越先认。
		if (messages.includes(ROWS_STREAM.at(-1)!)) return { text: "看完了。" };
		if (messages.includes(ROWS_FIRST.at(-1)!))
			return {
				toolCalls: ROWS_STREAM.map((id, index) => ({ id, name: "ls", args: { path: `apps/api/src/services/module-${index + 1}/` } })),
				stream: { chunkSize: 3, delayMs: 16 },
			};
		if (messages.includes(PROMPT_ROWS)) return { toolCalls: ROWS_FIRST.map((id) => ({ id, name: "ls", args: { path: "." } })) };
		if (messages.includes(CALLS_AGAIN.at(-1)!)) return { text: "列好了。" };
		if (messages.includes(PROMPT_AGAIN)) return { toolCalls: CALLS_AGAIN.map((id) => ({ id, name: "ls", args: { path: "." } })) };
		if (messages.includes(CALLS.at(-1)!)) return { text: REPLY, stream: { chunkSize: 18, delayMs: 30 } };
		return { toolCalls: CALLS.map((id) => ({ id, name: "ls", args: { path: "." } })) };
	});
	const size = window.getSize();
	window.setSize(900, 720);
	try {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "新建对话");
		const fade = await page<{ empty: boolean; top: boolean; middle: boolean; bottom: boolean; cleared: boolean }>(`(async () => {
			const view = document.querySelector('[data-screen=empty] .plume-scroll-view');
			const masked = () => getComputedStyle(view).maskImage !== 'none';
			const depth = (edge) => parseFloat(getComputedStyle(view).getPropertyValue('--plume-fade-' + edge));
			const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const empty = view.scrollHeight === view.clientHeight && !masked();
			const filler = document.createElement('div');
			filler.style.flex = '0 0 ' + view.clientHeight * 2 + 'px';
			view.append(filler);
			await settle();
			const top = masked() && depth('top') === 0 && depth('bottom') > 0;
			view.scrollTop = 8;
			await settle();
			const middle = masked() && depth('top') === 8 && depth('bottom') > 0;
			view.scrollTop = view.scrollHeight;
			await settle();
			const bottom = masked() && depth('top') > 0 && depth('bottom') === 0;
			filler.remove();
			await settle();
			return { empty, top, middle, bottom, cleared: view.scrollTop === 0 && !masked() };
		})()`);
		assert.deepEqual(fade, { empty: true, top: true, middle: true, bottom: true, cleared: true }, "滚动遮罩应只在有渐隐深度时启用");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(PROMPT);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送");
		await clickVisible(page, `[data-composer-send=send]`);

		const head = `[...document.querySelectorAll('[data-screen=chat] .tool-group-head[aria-expanded]')].at(-1)`;
		await until(`Boolean(${head})`, "工具组出现");
		await until(`document.querySelector('[data-screen=chat] [data-plume-session]')?.textContent.includes('第 3 段')`, "回复开始写");

		/*
		 * 每帧记一次。滚动面是 `[data-plume-session]` 往上第一个能竖着滚的祖先；空白是视口下沿到最后一行字下面（减去底部内衬）
		 * 的距离——跟着底部或停在中间时它不大于 0，大于 0 就是一块白。
		 */
		await page(`(() => {
			const session = document.querySelector('[data-screen=chat] [data-plume-session]');
			let scroller = session.parentElement;
			while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
			// 底部内衬（\`--plume-bottom-inset\`）以内的空是本来就留的；比它多、又不是整段短到填不满一屏，才是白的。
			const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--plume-bottom-inset')) || 0;
			const blank = (view) => scroller.scrollTop > 0 ? view.bottom - session.getBoundingClientRect().bottom - inset : 0;
			window.__scroll = { phase: null, phases: [], blank, frame: 0 };
			const sample = () => {
				const log = window.__scroll;
				const view = scroller.getBoundingClientRect();
				const target = log.target?.isConnected ? log.target.getBoundingClientRect().top - view.top : null;
				// 运行行的下沿高出视口下沿多少：负的就是被压到视口外了。
				const running = [...session.querySelectorAll('[data-plume-running]')].at(-1);
				const runningBottom = running ? view.bottom - running.getBoundingClientRect().bottom : null;
				return { top: scroller.scrollTop, height: scroller.scrollHeight, view: scroller.clientHeight, head: target, blank: log.blank(view), lag: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight, running: runningBottom };
			};
			const tick = (t) => {
				const log = window.__scroll;
				log.frame++;
				if (log.phase) log.phase.frames.push({ t, frame: log.frame, ...sample() });
				/*
				 * 下一帧的取样排在页面自己的 rAF 后面（贴底追赶的弹簧、行露出）：画完这一帧再约。直接在这里约的话它排在最前，
				 * 读到的是弹簧这一帧还没写的位置，而有尺寸变化的帧又被下面的观察器换成写过之后的——两种混着记，追赶就被量成
				 * 一帧不动、一帧走两步。
				 */
				setTimeout(() => requestAnimationFrame(tick), 0);
			};
			requestAnimationFrame(tick);
			/*
			 * rAF 里读到的是过渡刚往前走一步、\`ResizeObserver\` 还没来得及改位置的样子，画出来的是改过之后的：转录的
			 * 观察器在这一个之前建，同一帧里先跑。所以这一帧要是有尺寸变化，用这里读到的覆盖 rAF 那一份。
			 */
			const observer = new ResizeObserver(() => {
				const log = window.__scroll;
				const last = log.phase?.frames.at(-1);
				if (last && last.frame === log.frame) Object.assign(last, sample());
			});
			observer.observe(scroller);
			for (const child of scroller.children) observer.observe(child);
		})()`);

		const phase = (name: string, target = head) =>
			page(
				`(() => { const log = window.__scroll; log.target = ${target}; log.phase = { name: ${JSON.stringify(name)}, frames: [] }; log.phases.push(log.phase); })()`,
			);
		// 脚本自己要滚动、发话之前先停下记录：那些位置变化是脚本做的，不算在点的那一下头上。
		const stop = () => page(`window.__scroll.phase = null`);
		const press = async (on: "words" | "chevron" = "words", target = head) => {
			const point = await page<{ x: number; y: number }>(
				on === "chevron"
					? `(() => { const r = ${target}.querySelector('.tool-chevron').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`
					: `(() => { const r = ${target}.getBoundingClientRect(); return { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) }; })()`,
			);
			window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
			window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
		};

		/*
		 * 把标题滚到视口里离顶 40% 的地方，像人一样经滚轮：先发一个向上的 wheel，跟随底部才知道是人要离开，
		 * 再改位置。只改 `scrollTop` 的话它读成「被挪动了」，下一帧又被拉回底部。
		 */
		const scrollHeadIntoView = (target = head, fraction = 0.4) =>
			page(`(() => {
				const h = ${target};
				let s = h.parentElement;
				while (!/auto|scroll/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
				s.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
				s.scrollTop += h.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientHeight * ${fraction};
			})()`);

		// 写着的时候、跟着底部：点开。底部一直钉着，往回跳、空出底都不行。
		await phase("live-expand-following");
		await press();
		await until(`${head}.getAttribute('aria-expanded') === 'true'`, "写着时展开工具组");
		await sleep(1200);
		await stop();
		// 写着的时候、人滚上去读：收起再展开。被点的标题不能被推着走。
		await scrollHeadIntoView();
		await sleep(300);
		await phase("live-collapse-reading");
		await press();
		await until(`${head}.getAttribute('aria-expanded') === 'false'`, "写着时收起工具组");
		await sleep(900);
		await phase("live-expand-reading");
		await press();
		await until(`${head}.getAttribute('aria-expanded') === 'true'`, "写着时再展开工具组");
		await sleep(900);
		await stop();
		await capture(window, join(outDir, "smoke-transcript-scroll-live.png"));

		// 写完以后：回到底部，把标题滚到视口下半截再点开、收起。
		await until(`document.querySelector('[data-composer-send=send]') !== null && !document.querySelector('[data-composer-send=stop]')`, "回复写完", 40_000);
		await sleep(1200);
		await scrollHeadIntoView();
		await sleep(400);
		await phase("idle-collapse-reading");
		await press();
		await sleep(900);
		await phase("idle-expand-reading");
		await press();
		await sleep(900);
		await stop();
		// 再来一轮，最后一个工具组就在底部：贴着底部点开、收起。收起是「底下空出一大块」最容易出的地方。
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(PROMPT_AGAIN);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发第二句");
		await clickVisible(page, `[data-composer-send=send]`);
		await until(`document.querySelector('[data-screen=chat] [data-plume-session]')?.textContent.includes('列好了。')`, "第二轮写完");
		await until(`!document.querySelector('[data-composer-send=stop]')`, "第二轮停下");
		await sleep(1200);
		await phase("idle-expand-at-bottom");
		await press();
		await sleep(900);
		await stop();
		// 点开以后标题留在原处、展开的那截在下面：像人一样滚到底再收起。
		await page(
			`(() => { let e = ${head}.parentElement; while (!/auto|scroll/.test(getComputedStyle(e).overflowY)) e = e.parentElement; e.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true })); e.scrollTop = e.scrollHeight; })()`,
		);
		await sleep(400);
		await phase("idle-collapse-at-bottom");
		await press();
		await sleep(900);
		await stop();
		await capture(window, join(outDir, "smoke-transcript-scroll-idle.png"));

		/*
		 * 贴着底部收起留下的那块空：像人一样往上滚一屏、再滚回底部，它就该没了，底部回到最后一行字下面。只滚开一点的话，
		 * 还在视口里的那截照样留着。
		 */
		await page(
			`(() => { let e = ${head}.parentElement; while (!/auto|scroll/.test(getComputedStyle(e).overflowY)) e = e.parentElement; window.__scroller = e; })()`,
		);
		const blankNow = () => page<number>(`window.__scroll.blank(window.__scroller.getBoundingClientRect())`);
		const slackLeft = await blankNow();
		await page(
			`(() => { const e = window.__scroller; e.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); e.scrollTop -= e.clientHeight; })()`,
		);
		await sleep(300);
		await page(
			`(() => { const e = window.__scroller; e.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true })); e.scrollTop = e.scrollHeight; })()`,
		);
		await sleep(400);
		const slackAfter = await blankNow();
		console.log("PLUME_SMOKE_SCROLL_SLACK", JSON.stringify({ slackLeft: Math.round(slackLeft), slackAfter: Math.round(slackAfter) }));
		if (slackAfter > 4) {
			await capture(window, join(outDir, "smoke-transcript-scroll-slack.png"));
			throw new Error(`贴底收起后上下滚一下，底下还空着 ${Math.round(slackAfter)}px`);
		}

		// 同样贴着底部，点在箭头上：和点字一样，标题留在原处。
		await phase("idle-expand-at-bottom-chevron");
		await press("chevron");
		await sleep(900);
		await stop();
		await page(
			`(() => { const e = window.__scroller; e.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true })); e.scrollTop = e.scrollHeight; })()`,
		);
		await sleep(400);
		await phase("idle-collapse-at-bottom-chevron");
		await press("chevron");
		await sleep(900);
		await stop();

		/*
		 * 贴着底部看工具行一行一行流进点开着的卡片：内容往上走的速度要连成一条，不能每来一行先猛顶一下、再停住
		 * （人说的「一抖一抖」），运行行也不能被压到视口外。点开工具组会停止跟随（`hold`），所以点开后像人一样滚回底部。
		 */
		const heads = await page<number>(`document.querySelectorAll('[data-screen=chat] .tool-group-head[aria-expanded]').length`);
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(PROMPT_ROWS);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发第三句");
		await clickVisible(page, `[data-composer-send=send]`);
		await until(`document.querySelectorAll('[data-screen=chat] .tool-group-head[aria-expanded]').length > ${heads}`, "第三轮的工具组能点开");
		await press();
		await until(`${head}.getAttribute('aria-expanded') === 'true'`, "点开第三轮的工具组");
		await page(
			`(() => { const e = window.__scroller; e.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true })); e.scrollTop = e.scrollHeight; })()`,
		);
		await phase("live-rows-following", "null");
		await until(`document.querySelector('[data-screen=chat] [data-plume-session]')?.textContent.includes('看完了。')`, "第三轮写完", 30_000);
		// 写完以后再记一会儿：运行行换成回复和底下那一行的那几帧也算在里面。
		await sleep(600);
		await stop();
		await capture(window, join(outDir, "smoke-transcript-scroll-rows.png"));

		/*
		 * 画完了的轮在屏幕外跳过布局（`TurnFrame`），最后一轮不跳；上面几段点开收起、跟着底部都是在这样的转录上量的。
		 * 跳过之前写下的占位高度就是它画出来的真高度：拿掉跳过再量，高度一分不差。
		 */
		const turns = `[...document.querySelectorAll('[data-screen=chat] [data-plume-transcript-rows] > [data-plume-turn]')]`;
		const marks = await page<{ skip: boolean; same: boolean }[]>(`${turns}.map((turn) => {
			const placeholder = parseFloat(turn.style.containIntrinsicBlockSize.replace('auto', '')) || 0;
			return { skip: turn.hasAttribute('data-plume-turn-skip'), same: !turn.hasAttribute('data-plume-turn-skip') || Math.abs(placeholder - turn.getBoundingClientRect().height) < 1 };
		})`);
		console.log("PLUME_SMOKE_TURN_SKIP", JSON.stringify(marks));
		assert.ok(marks.length >= 3, `每一轮一个外框：${JSON.stringify(marks)}`);
		assert.ok(
			marks.slice(0, -1).every((mark) => mark.skip && mark.same) && !marks.at(-1)!.skip,
			`画完的轮跳过、占位是真高度，最后一轮不跳：${JSON.stringify(marks)}`,
		);

		/*
		 * 点过「显示更早」的长对话：读者回到底部，多挂出来、在视口上方一屏以外的那几轮收回去（`trimBehind`），眼前的不动。
		 * 先说几句短话，让转录长过一个窗口（20 块）。
		 */
		const showEarlier = `document.querySelector('[data-screen=chat] [data-plume-show-earlier]')`;
		for (let index = 1; index <= 30 && !(await page<boolean>(`Boolean(${showEarlier})`)); index++) {
			await page(`document.querySelector('.cm-content').focus()`);
			await window.webContents.insertText(`短问 ${index}`);
			await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, `可以发短问 ${index}`);
			await clickVisible(page, `[data-composer-send=send]`);
			await until(
				`[...document.querySelectorAll('[data-screen=chat] [data-plume-session] [data-question-index]')].some((row) => row.textContent.includes(${JSON.stringify(`短问 ${index}`)})) && document.querySelector('[data-composer-send=send]') !== null && !document.querySelector('[data-composer-send=stop]')`,
				`短问 ${index} 答完`,
			);
		}
		await until(`Boolean(${showEarlier})`, "转录长过一个窗口");
		const count = () => page<number>(`${turns}.length`);
		const windowed = await count();
		// 停在底部点「显示更早」：挂出来的那几轮不当场又被收回去（读者没离开过底部）。
		await clickVisible(page, `[data-screen=chat] [data-plume-show-earlier]`);
		await until(`${turns}.length > ${windowed}`, "显示更早挂出前面几轮");
		const widened = await count();
		await sleep(500);
		assert.equal(await count(), widened, "停在底部点「显示更早」，挂出来的不被当场收回");
		// 像人一样往上翻到顶、再滚回底部（先一个滚轮，跟随底部才认这是人在滚）。回去的那一路逐帧记最后一轮的位置：收回前后不跳。
		const scrollTo = (end: "top" | "bottom") =>
			page(
				`(() => { const e = window.__scroller; e.dispatchEvent(new WheelEvent('wheel', { deltaY: ${end === "top" ? -120 : 120}, bubbles: true })); e.scrollTop = ${end === "top" ? 0 : "e.scrollHeight"}; })()`,
			);
		await scrollTo("top");
		await sleep(300);
		// 先开始逐帧记再滚回去：收回就发生在到底的那一下的滚动事件里。
		await page(`(() => { window.__trim = (async () => {
			const out = [];
			for (let i = 0; i < 40; i++) {
				await new Promise(requestAnimationFrame);
				const e = window.__scroller;
				out.push({ turns: ${turns}.length, top: Math.round(${turns}.at(-1).getBoundingClientRect().top * 10) / 10, lag: e.scrollHeight - e.scrollTop - e.clientHeight });
			}
			return out;
		})(); })()`);
		await scrollTo("bottom");
		await until(`${turns}.length < ${widened}`, "离开过底部再回来，收回多挂出来的轮");
		const trimmed = await page<{ turns: number; top: number; lag: number }[]>("window.__trim");
		console.log("PLUME_SMOKE_TURN_TRIM", JSON.stringify({ windowed, widened, kept: await count(), frames: trimmed }));
		// 到底以后的每一帧：还在底部、最后一轮不挪，收回前后（`turns` 变了的那一帧）都一样。
		const landed = trimmed.slice(trimmed.findIndex((frame) => frame.lag <= 2));
		assert.ok(
			landed.every((frame) => frame.lag <= 2 && Math.abs(frame.top - landed[0]!.top) < 1),
			`收回时眼前不动、还在底部：${JSON.stringify(trimmed)}`,
		);

		/* 同一条转录里，经真实 read / edit 留下长代码和长 diff；回复继续写时逐次读、收起、重开。 */
		await writeFile(join(workspace, DETAIL_FILE), CSS);
		detailStreaming = true;
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(PROMPT_DETAILS);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发长详情问题");
		await clickVisible(page, `[data-composer-send=send]`);
		const reply = `[...document.querySelectorAll('[data-screen=chat] [data-plume-quote=assistant]')].at(-1)?.textContent ?? ''`;
		await until(`Boolean(document.querySelector('[data-approval-card]')) || (${reply}).includes('第 3 段')`, "长详情编辑审批或回复开始");
		if (await page<boolean>(`Boolean(document.querySelector('[data-approval-card]'))`)) await clickVisible(page, "[data-approval-card] button", "允许一次");
		await until(`(${reply}).includes('第 3 段') && Boolean(document.querySelector('[data-composer-send=stop]'))`, "长详情后的回复正在生成");
		await scrollHeadIntoView();
		await press();
		await until(`${head}.getAttribute('aria-expanded') === 'true'`, "展开长详情工具组");
		// 等组的外框真正展开：aria 已切换时下方的按钮可能仍被过渡中的裁剪层挡住。
		await until(
			`!${head}.nextElementSibling.getAnimations().some(a => a.playState === 'running') && (${reply}).includes('第 8 段')`,
			"长工具组已经露出，后面有足够正文可滚动",
		);
		await page(`window.__detailResults = []`);
		for (const [id, kind, lines] of [
			[DETAIL_READ, "read", 200],
			[DETAIL_EDIT, "diff", 400],
		] as const) {
			const selector = `[data-screen=chat] [data-tool-call=${id}]`;
			const row = `document.querySelector('${selector}')`;
			const button = `${row}.querySelector(':scope > button[aria-expanded]')`;
			await until(`${row}?.getAttribute('data-status') === 'done'`, `${kind} 已完成`);
			let highlighted = "";
			for (const [index, open] of [true, false, true, false].entries()) {
				await stop();
				await scrollHeadIntoView(button, 0.15);
				await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
				const name = `live-detail-${kind}-${open ? "expand" : "collapse"}-${index < 2 ? "cold" : "warm"}`;
				await phase(name, button);
				await page(`(() => {
					const row = ${row};
					const probe = window.__detailProbe = { addedHighlights: 0, before: (${reply}).length, start: performance.now() };
					probe.observer = new MutationObserver(records => {
						for (const record of records) for (const node of record.addedNodes) {
							if (!(node instanceof Element)) continue;
							probe.addedHighlights += Number(node.matches('.tool-diff-code span[class]')) + node.querySelectorAll('.tool-diff-code span[class]').length;
						}
					});
					probe.observer.observe(row, { childList: true, subtree: true });
				})()`);
				// 点击前也记一帧：不能漏掉从按下到首帧之间发生的标题位移。
				await page(`new Promise(requestAnimationFrame)`);
				await press("words", button);
				await until(`${button}.getAttribute('aria-expanded') === '${open}'`, `${name} 切换`);
				await page(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
				await until(`${row}.querySelector(':scope > .plume-reveal').getAnimations().every(animation => animation.playState !== 'running')`, `${name} 过渡完成`);
				if (open) {
					await until(
						`${row}.querySelectorAll('.tool-diff-code').length === ${lines} && ${row}.querySelector('.tool-diff-code')?.querySelectorAll('span[class]').length > 0`,
						`${name} 完整代码和首行语法高亮`,
					);
				} else {
					await until(`${row}.querySelectorAll('.tool-diff-code').length === 0`, `${name} 详情卸载`);
				}
				await until(`Boolean(document.querySelector('[data-composer-send=stop]')) && (${reply}).length > window.__detailProbe.before`, `${name} 回复继续增长`);
				const metric = await page<{ name: string; addedHighlights: number }>(`(() => {
					const probe = window.__detailProbe;
					probe.observer.disconnect();
					const frames = window.__scroll.phase.frames;
					const intervals = frames.slice(1).map((frame, index) => frame.t - frames[index].t).sort((a, b) => a - b);
					const round = value => Math.round(value * 10) / 10;
					const metric = { name: ${JSON.stringify(name)}, elapsedMs: round(performance.now() - probe.start), frames: frames.length,
						meanFrameMs: round(intervals.reduce((sum, value) => sum + value, 0) / (intervals.length || 1)),
						p95FrameMs: round(intervals[Math.max(0, Math.ceil(intervals.length * 0.95) - 1)] ?? 0), maxFrameMs: round(Math.max(0, ...intervals)),
						streamGrowth: (${reply}).length - probe.before, addedHighlights: probe.addedHighlights };
					window.__detailResults.push(metric);
					return metric;
				})()`);
				await stop();
				console.log("PLUME_SMOKE_DETAIL_TOGGLE", JSON.stringify(metric));
				if (!open) {
					assert.equal(metric.addedHighlights, 0, `${name} 收起不重新新增高亮节点`);
					continue;
				}
				const tokens = await page<string>(
					`JSON.stringify([...${row}.querySelector('.tool-diff-code').querySelectorAll('span[class]')].map(node => [node.className, node.textContent]))`,
				);
				if (highlighted) assert.equal(tokens, highlighted, `${kind} 重开仍有相同的语法高亮`);
				highlighted = tokens;
				if (kind === "diff") {
					assert.equal(await page<number>(`${row}.querySelectorAll('.tool-diff-add').length`), 200, "长 diff 有 200 行新增");
					assert.equal(await page<number>(`${row}.querySelectorAll('.tool-diff-remove').length`), 200, "长 diff 有 200 行删除");
				}
				const reading = await page<{ scrollable: boolean; tailVisible: boolean }>(`(async () => {
					const row = ${row}, tail = [...row.querySelectorAll('.tool-diff-code')].at(-1);
					let viewport = tail.parentElement;
					while (viewport && (!/auto|scroll/.test(getComputedStyle(viewport).overflowY) || viewport.scrollHeight <= viewport.clientHeight)) viewport = viewport.parentElement;
					const scrollable = Boolean(viewport && row.contains(viewport) && viewport.scrollHeight > viewport.clientHeight);
					if (!scrollable) return { scrollable: false, tailVisible: false };
					viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
					viewport.scrollTop = viewport.scrollHeight;
					await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
					const bounds = viewport.getBoundingClientRect(), end = tail.getBoundingClientRect();
					return { scrollable, tailVisible: tail.textContent.includes('.scroll-rule-200') && end.top >= bounds.top && end.bottom <= bounds.bottom + 1
						&& end.top >= 0 && end.bottom <= innerHeight };
				})()`);
				assert.ok(reading.scrollable && reading.tailVisible, `${kind} 能滚到第 200 行：${JSON.stringify(reading)}`);
				const tail = `[...${row}.querySelectorAll('.tool-diff-code')].at(-1)`;
				// 长段可以按视口铺高亮；等后部进入视口再量，不能要求屏幕外的节点始终挂着。
				await until(`${tail}.querySelectorAll('span[class]').length > 0`, `${kind} 后部代码仍有语法高亮`);
				await page(
					`void (window.__detailTail = { before: (${reply}).length, tokens: [...${tail}.querySelectorAll('span[class]')].map(node => ({ node, css: node.className, text: node.textContent })) })`,
				);
				await until(
					`Boolean(document.querySelector('[data-composer-send=stop]')) && (${reply}).length > window.__detailTail.before`,
					`${kind} 阅读后部时回复继续增长`,
				);
				assert.ok(
					await page<boolean>(
						`window.__detailTail.tokens.every(({ node, css, text }) => node.isConnected && node.className === css && node.textContent === text)`,
					),
					`${kind} 阅读后部时保留高亮节点`,
				);
				if (index === 0) await capture(window, join(outDir, `smoke-transcript-scroll-${kind}-tail.png`));
			}
		}
		// 数据量足以覆盖交互；不必等长回复自然写完，像人一样按停。
		detailStreaming = false;
		await clickVisible(page, "[data-composer-send=stop]");
		await until(`!document.querySelector('[data-composer-send=stop]')`, "长详情回归结束");

		const phases = await page<Phase[]>(`window.__scroll.phases.map(p => ({ name: p.name, frames: p.frames }))`);
		const report = phases.map(({ name, frames }) => {
			const steps = frames.slice(1).map((frame, index) => frame.top - frames[index]!.top);
			const heads = frames.filter((frame) => frame.head !== null).map((frame) => frame.head!);
			// 每帧往上走了多少，按一帧 1000/60ms 归一：录到的帧间隔不齐，直接比位移会把掉帧当成加速。
			const speeds = frames.slice(1).map((frame, index) => ((frame.top - frames[index]!.top) * (1000 / 60)) / Math.max(1, frame.t - frames[index]!.t));
			const jolts = speeds.slice(1).map((speed, index) => Math.abs(speed - speeds[index]!));
			const runnings = frames.filter((frame) => frame.running !== null).map((frame) => frame.running!);
			return {
				name,
				frames: frames.length,
				maxBlank: Math.round(Math.max(0, ...frames.map((frame) => frame.blank))),
				blankFrames: frames.filter((frame) => frame.blank > 4).length,
				headDrift: heads.length ? Math.round((Math.max(...heads) - Math.min(...heads)) * 10) / 10 : null,
				backSteps: steps.filter((step) => step < -2).length,
				maxBack: Math.round(Math.max(0, ...steps.map((step) => -step))),
				maxStep: Math.round(Math.max(0, ...steps.map(Math.abs))),
				maxLag: Math.round(Math.max(0, ...frames.map((frame) => frame.lag))),
				// 停住（不到半像素一帧）的下一帧就走了 3px 以上：一下猛顶。
				kicks: speeds.slice(1).filter((speed, index) => speeds[index]! < 0.5 && speed > 3).length,
				maxJolt: Math.round(Math.max(0, ...jolts) * 10) / 10,
				minRunning: runnings.length ? Math.round(Math.min(...runnings)) : null,
			};
		});
		const details = await page(`window.__detailResults`);
		await writeFile(join(outDir, "transcript-scroll.json"), JSON.stringify({ report, details, phases }, null, 1));
		console.log("PLUME_SMOKE_SCROLL", JSON.stringify(report));
		/*
		 * 每一段被点的标题都留在原处（不到半个像素：差 1px 的那种是位置在两个设备像素间来回跳）、位置不往回跳；
		 * 贴着底部收起的那几段底下许空着，别的不许。
		 *
		 * 工具行流进来那一段另外量往上走得顺不顺：停住后猛顶的帧（改之前每来一行一次，16 次）、相邻两帧速度差（改之前 60px，
		 * 改之后 5px 上下）、运行行有没有被压到视口外（改之前每来一行被顶下去 32px 再追回来）。门槛比量到的留了余量，机器忙时
		 * 偶尔掉一帧不至于误报。
		 */
		const bad = report.filter(
			(one) =>
				(!one.name.startsWith("idle-collapse-at-bottom") && one.maxBlank > 4) ||
				one.backSteps > 0 ||
				(one.headDrift ?? 0) > 0.5 ||
				(one.name === "live-rows-following" && (one.kicks > 2 || one.maxJolt > 12 || (one.minRunning ?? -1) < 0)),
		);
		if (bad.length) throw new Error(`转录滚动不稳：${JSON.stringify(bad)}`);
		await checkMarkdownWidths({ window, outDir, setModel });
	} catch (error) {
		// 失败时也把已经记下的帧留下，好看是哪一步、哪一帧出的事。
		const phases = await page<Phase[]>(`window.__scroll?.phases.map(p => ({ name: p.name, frames: p.frames })) ?? []`).catch(() => []);
		const point = await page(
			`(() => { const h = [...document.querySelectorAll('[data-screen=chat] .tool-group-head[aria-expanded]')].at(-1); if (!h) return null; const r = h.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, expanded: h.getAttribute('aria-expanded'), inner: innerHeight }; })()`,
		).catch(() => null);
		const details = await page(`window.__detailResults ?? []`).catch(() => []);
		await page(`window.__detailProbe?.observer.disconnect()`).catch(() => undefined);
		await writeFile(join(outDir, "transcript-scroll.json"), JSON.stringify({ failed: String(error), head: point, details, phases }, null, 1));
		await capture(window, join(outDir, "smoke-transcript-scroll-failed.png")).catch(() => undefined);
		throw error;
	} finally {
		window.setSize(size[0]!, size[1]!);
		setModel(undefined);
	}
}
