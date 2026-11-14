import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { BrowserWindow } from "electron";
import { clickVisible } from "./smoke-kit.ts";

const PROMPT = "列一下目录，然后长篇说明";
const CALLS = Array.from({ length: 6 }, (_, index) => `toolu_scroll_${index + 1}`);
/** 第二轮：又一个工具组，后面只跟一句短话，于是贴着底部时工具组标题就在视口里。 */
const PROMPT_AGAIN = "再列一次";
const CALLS_AGAIN = Array.from({ length: 6 }, (_, index) => `toolu_scroll_again_${index + 1}`);
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
 */
export async function checkTranscriptScroll(options: {
	window: BrowserWindow;
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
	capture(window: BrowserWindow, path: string): Promise<void>;
}): Promise<void> {
	const { window, outDir, setModel, capture } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const until = async (code: string, label: string, timeoutMs = 20_000) => {
		const end = Date.now() + timeoutMs;
		while (!(await page<boolean>(code))) {
			if (Date.now() > end) throw new Error(`转录滚动等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	setModel((request) => {
		const messages = JSON.stringify(request.messages);
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
				return { top: scroller.scrollTop, height: scroller.scrollHeight, view: scroller.clientHeight, head: target, blank: log.blank(view), lag: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight };
			};
			const tick = (t) => {
				const log = window.__scroll;
				log.frame++;
				if (log.phase) log.phase.frames.push({ t, frame: log.frame, ...sample() });
				requestAnimationFrame(tick);
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

		const phase = (name: string) =>
			page(
				`(() => { const log = window.__scroll; log.target = ${head}; log.phase = { name: ${JSON.stringify(name)}, frames: [] }; log.phases.push(log.phase); })()`,
			);
		// 脚本自己要滚动、发话之前先停下记录：那些位置变化是脚本做的，不算在点的那一下头上。
		const stop = () => page(`window.__scroll.phase = null`);
		const press = async (on: "words" | "chevron" = "words") => {
			const point = await page<{ x: number; y: number }>(
				on === "chevron"
					? `(() => { const r = ${head}.querySelector('.tool-chevron').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`
					: `(() => { const r = ${head}.getBoundingClientRect(); return { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) }; })()`,
			);
			window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
			window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
		};

		/*
		 * 把标题滚到视口里离顶 40% 的地方，像人一样经滚轮：先发一个向上的 wheel，跟随底部才知道是人要离开，
		 * 再改位置。只改 `scrollTop` 的话它读成「被挪动了」，下一帧又被拉回底部。
		 */
		const scrollHeadIntoView = () =>
			page(`(() => {
				const h = ${head};
				let s = h.parentElement;
				while (!/auto|scroll/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
				s.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
				s.scrollTop += h.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientHeight * 0.4;
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

		const phases = await page<Phase[]>(`window.__scroll.phases.map(p => ({ name: p.name, frames: p.frames }))`);
		const report = phases.map(({ name, frames }) => {
			const steps = frames.slice(1).map((frame, index) => frame.top - frames[index]!.top);
			const heads = frames.filter((frame) => frame.head !== null).map((frame) => frame.head!);
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
			};
		});
		await writeFile(join(outDir, "transcript-scroll.json"), JSON.stringify({ report, phases }, null, 1));
		console.log("PLUME_SMOKE_SCROLL", JSON.stringify(report));
		/*
		 * 每一段被点的标题都留在原处（不到半个像素：差 1px 的那种是位置在两个设备像素间来回跳）、位置不往回跳；
		 * 贴着底部收起的那几段底下许空着，别的不许。
		 */
		const bad = report.filter(
			(one) => (!one.name.startsWith("idle-collapse-at-bottom") && one.maxBlank > 4) || one.backSteps > 0 || (one.headDrift ?? 0) > 0.5,
		);
		if (bad.length) throw new Error(`转录滚动不稳：${JSON.stringify(bad)}`);
	} catch (error) {
		// 失败时也把已经记下的帧留下，好看是哪一步、哪一帧出的事。
		const phases = await page<Phase[]>(`window.__scroll?.phases.map(p => ({ name: p.name, frames: p.frames })) ?? []`).catch(() => []);
		const point = await page(
			`(() => { const h = [...document.querySelectorAll('[data-screen=chat] .tool-group-head[aria-expanded]')].at(-1); if (!h) return null; const r = h.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, expanded: h.getAttribute('aria-expanded'), inner: innerHeight }; })()`,
		).catch(() => null);
		await writeFile(join(outDir, "transcript-scroll.json"), JSON.stringify({ failed: String(error), head: point, phases }, null, 1));
		await capture(window, join(outDir, "smoke-transcript-scroll-failed.png")).catch(() => undefined);
		throw error;
	} finally {
		window.setSize(size[0]!, size[1]!);
		setModel(undefined);
	}
}
