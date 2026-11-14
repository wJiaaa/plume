/**
 * 插话发出去之后转录长什么样（`PLUME_SMOKE_ONLY=steer`）。
 *
 * 假模型先调一次 `ls`，再写一段长回复（慢慢地一笔一笔写）。回复写着的时候在输入框里打字、按下回车：那一句落在排队条上，标着插话；
 * 这一轮下一次请求之前读到，条上的那一行收走、气泡出现在这一轮中间。
 *
 * 每帧记下：排队条上还有没有这一行、气泡在不在、转录滚动面被往前推了几次。三处都是人一眼能看出毛病的地方：
 *
 * - 条上的那一行先收走、气泡后到，中间有一帧两样都没有（那句话哪里都不在）；
 * - 插话被当成新的一轮，这一轮断成两截，气泡整块重挂、进场动画再演一遍（从零长出来），计时也从插话重新起；
 * - 插话让「最后一句人话」变了，转录跟着回了一次底部，读完那一刻整页跳一帧。
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { ModelOverride } from "./smoke-browser.ts";
import { nativeEnter } from "./smoke-message-edits.ts";

const PROMPT = "先读一下目录，再写一段长文";
const STEER = "只列 src 下面";
const REPLY = "读完了。".repeat(60);
const AFTER = "按你说的，只看 src。";

/** 一帧的样子：条上那一行还在不在，气泡在不在，这一帧之前转录被往回挪过几像素。 */
interface Frame {
	frame: number;
	queue: boolean;
	bubble: boolean;
	/** 这一帧里画出来的气泡一共出现过几个不同的元素：多于一个就是重挂过。 */
	bubbles: number;
	/** 转录滚动面的位置，和上一帧比往回挪了多少。 */
	back: number;
	/** 这一轮的过程块有几块：插话被当成新的一轮时，这一轮会多出一块空的。 */
	turns: number;
}

export async function checkSteer(options: {
	window: BrowserWindow;
	outDir: string;
	setModel(override: ModelOverride | undefined): void;
	capture(window: BrowserWindow, path: string): Promise<void>;
}): Promise<void> {
	const { window, outDir, setModel, capture } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const until = async (code: string, label: string, timeoutMs = 20_000) => {
		const end = Date.now() + timeoutMs;
		while (!(await page<boolean>(code))) {
			if (Date.now() > end) throw new Error(`插话等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	setModel((request) => {
		const messages = JSON.stringify(request.messages);
		// 读到了插话：这一轮接着说，不再挂新的活。
		if (messages.includes(STEER)) return { text: AFTER, stream: { chunkSize: 6, delayMs: 40 } };
		// 第一次请求：先读一下目录。
		if (!messages.includes("toolu_steer_ls")) return { toolCalls: [{ id: "toolu_steer_ls", name: "ls", args: { path: "." } }] };
		// 工具结果回来了：慢慢地写一段长回复，留出打字插话的时间。
		return { text: REPLY, stream: { chunkSize: 3, delayMs: 45 } };
	});
	window.setSize(900, 720);
	try {
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "新建对话");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(PROMPT);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送");

		/*
		 * 每帧记一次，从点发送之前就开始：滚动面是 `[data-plume-session]` 往上第一个能竖着滚的祖先；气泡按最后一条人说的话认
		 * （`data-plume-quote=user` 里带着插话那句的）。`seen` 记下画出来过的气泡元素，重挂一次就会多一个。
		 */
		await page(`(() => {
			// 点发送那一刻转录还是空的，会话那一栏要等这一轮开出来才有：每帧现找。
			const scrollerNow = () => {
				let node = document.querySelector('[data-screen=chat] [data-plume-session]')?.parentElement;
				while (node && !/auto|scroll/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
				return node ?? null;
			};
			const log = (window.__steer = { frames: [], seen: new Set(), frame: 0, last: 0 });
			const tick = () => {
				log.frame++;
				const scroller = scrollerNow();
				const bubble = [...document.querySelectorAll('[data-screen=chat] [data-plume-quote=user]')].find((node) => node.textContent.includes(${JSON.stringify(STEER)}));
				if (bubble) log.seen.add(bubble);
				const top = scroller ? scroller.scrollTop : log.last;
				const back = Math.max(0, log.last - top);
				log.last = top;
				log.frames.push({
					frame: log.frame,
					queue: [...document.querySelectorAll('[data-screen=chat] [data-queue-row][data-steered]')].some((node) => node.textContent.includes(${JSON.stringify(STEER)})),
					bubble: Boolean(bubble),
					bubbles: log.seen.size,
					back,
					turns: document.querySelectorAll('[data-screen=chat] [data-plume-turn-process]').length,
				});
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		})()`);
		await page(`document.querySelector('[data-composer-send=send]').click()`);

		// 回复开始写了：在输入框里打字、按回车，话插进正在跑的这一轮。
		await until(`document.querySelector('[data-screen=chat] [data-plume-session]')?.textContent.includes('读完了。')`, "回复开始写");
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(STEER);
		nativeEnter(window);
		await until(
			`document.querySelector('[data-screen=chat] [data-queue-row][data-steered]')?.textContent.includes(${JSON.stringify(STEER)})`,
			"插话落在排队条上",
		);
		const seenBubble = await page<boolean>(`window.__steer.seen !== undefined`);
		if (!seenBubble) throw new Error("每帧的记录没装上");
		// 这一轮读到插话、把回答写完。
		await until(`document.querySelector('[data-screen=chat] [data-plume-session]')?.textContent.includes(${JSON.stringify(AFTER)})`, "插话被读到，接着答完");
		await until(`document.querySelector('[data-composer-send=stop]') === null`, "这一轮停下");
		await sleep(400);
		await capture(window, join(outDir, "smoke-steer.png"));

		const frames = await page<Frame[]>(`window.__steer.frames`);
		// 从那句话落进排队条到气泡画出来这一段：条走了、气泡还没到的那些帧就是空档。
		const queued = frames.findIndex((frame) => frame.queue);
		const arrived = frames.findIndex((frame) => frame.bubble);
		const handoff = queued >= 0 && arrived >= 0 ? frames.slice(queued, arrived + 1) : [];
		const gap = handoff.filter((frame) => !frame.queue && !frame.bubble);
		const after = frames.slice(Math.max(0, arrived));
		const remounts = Math.max(0, ...frames.map((frame) => frame.bubbles));
		const backs = after.filter((frame) => frame.back > 2);
		const report = {
			frames: frames.length,
			queued,
			arrived,
			// 条上那一行和气泡交接的那一帧：两样都没有就是空档（「那句话哪里都不在」）。
			gap: gap.length,
			// 气泡画出来过几个元素：重挂过就会多。
			bubbles: remounts,
			// 读到插话以后转录往回挪过的帧：读完那一刻整页跳一帧。
			back: backs.length,
			backMax: Math.round(Math.max(0, ...after.map((frame) => frame.back))),
			// 这一轮的过程块最多同时有几块：插话被当成新的一轮时会多出一块空的过程。
			turns: Math.max(0, ...frames.map((frame) => frame.turns)),
		};
		await writeFile(join(outDir, "steer.json"), JSON.stringify({ report, frames }, null, 1));
		console.log("PLUME_SMOKE_STEER", JSON.stringify(report));
		if (queued < 0) throw new Error(`插话没落进排队条：${JSON.stringify(report)}`);
		if (arrived < 0) throw new Error(`插话没画进转录：${JSON.stringify(report)}`);
		if (gap.length > 0) throw new Error(`插话送来时有一帧哪里都不在：${JSON.stringify(report)}`);
		if (remounts > 1) throw new Error(`插话的气泡重挂了 ${remounts - 1} 次：${JSON.stringify(report)}`);
		if (backs.length > 0) throw new Error(`读到插话时转录往回挪了：${JSON.stringify(report)}`);
		if (report.turns > 1) throw new Error(`插话把这一轮切成两块过程：${JSON.stringify(report)}`);
	} finally {
		setModel(undefined);
	}
}
