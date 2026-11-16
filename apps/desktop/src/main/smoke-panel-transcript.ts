import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { BrowserWindow } from "electron";
import { clickReal, clickVisible, waitFor } from "./smoke-kit.ts";

const TOGGLE = "[data-panel-toggle] button";
const PARAGRAPH = "正文宽度应该随着对话卡片连续变化，而不是在面板动画结束以后突然重新换行。这段文字用来观察真实 Markdown 的排版和阅读位置。";
const prose = (count: number) => Array.from({ length: count }, (_, i) => `第 ${i + 1} 段：${PARAGRAPH}`).join("\n\n");
const HUGE = `${prose(180)}\n\n\x60\x60\x60typescript\n${Array.from({ length: 240 }, (_, i) => `const panelLine${i} = { label: "${PARAGRAPH}", index: ${i} };`).join("\n")}\n\x60\x60\x60\n\n${prose(180)}`;

interface Frame {
	t: number;
	main: number;
	viewport: number;
	body: number;
	paragraph: number;
	expected: number;
	top: number;
	lag: number;
	height: number;
	view: number;
	anchor: number | null;
	connected: boolean;
	blank: number;
	codeOverflow: number;
}

interface Sample {
	name: string;
	position: string;
	direction: string;
	repeat: number;
	frames: Frame[];
}

/** 固定内容、窗口和开关路径，原版和修复版都跑同一份脚本；帧时间只作同机对照。 */
export async function checkPanelTranscript(options: {
	window: BrowserWindow;
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const until = (code: string, label: string) => waitFor(() => page<boolean>(code), `面板正文：${label}`, 30_000);
	const settle = () =>
		page(`(async () => {
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
		await new Promise(resolve => setTimeout(resolve, 350));
	})()`);
	const samples: Sample[] = [];
	const failures: string[] = [];
	const size = window.getSize();
	let response = "";
	setModel(() => ({ text: response }));
	const send = async (prompt: string, text: string) => {
		const marker = `冒烟完成：${prompt}`;
		response = `${text}\n\n${marker}`;
		await page(`document.querySelector('[data-screen] .cm-content').focus()`);
		await window.webContents.insertText(prompt);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送");
		await clickVisible(page, "[data-composer-send=send]");
		await until(
			`document.querySelector('[data-screen=chat] [data-plume-quote=assistant]') !== null && !document.querySelector('[data-composer-send=stop]') && [...document.querySelectorAll('[data-screen=chat] [data-plume-quote=assistant]')].at(-1)?.textContent.includes(${JSON.stringify(marker)})`,
			"固定回复完成",
		);
	};
	try {
		window.setSize(1200, 800);
		window.webContents.setZoomFactor(1);
		await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
		await until("innerWidth === 1200", "固定窗口尺寸");
		for (const name of ["short", "long", "huge-code"] as const) {
			window.webContents.send("plume:command", "new-session");
			await until("document.querySelector('[data-screen=empty]') !== null", "新建场景");
			await send(`面板正文冒烟 ${name} 第 1 轮`, name === "huge-code" ? HUGE : prose(name === "short" ? 1 : 5));
			if (name === "long") {
				for (let turn = 2; turn <= 24; turn++) await send(`面板正文冒烟 long 第 ${turn} 轮`, prose(5));
			}
			await settle();
			if (name === "huge-code") await until("document.querySelector('[data-screen=chat] [data-plume-quote=assistant] pre') !== null", "超长回复保留真实代码块");
			if (await page<boolean>("!document.querySelector('[data-panel-area]').inert")) {
				await clickReal(window, TOGGLE);
				await settle();
			}
			// 开始页是现有真实面板路径，不装市场插件、不伪造 DOM 或会话数据。
			await clickReal(window, TOGGLE);
			await until("document.querySelector('[data-panel-area]:not([inert])') !== null", "面板打开");
			await settle();
			await clickReal(window, TOGGLE);
			await settle();
			await page(`(() => {
				const session = document.querySelector('[data-screen=chat] [data-plume-session]');
				let scroller = session.parentElement;
				while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
				if (!scroller) throw new Error('没有找到转录滚动面');
				const gutter = document.querySelector('[data-panel-layout] > main').getBoundingClientRect().width - scroller.getBoundingClientRect().width;
				window.__panelTranscript = { session, scroller, gutter, active: false, frames: [] };
			})()`);
			for (const position of name === "short" ? ["bottom"] : ["bottom", "reading"]) {
				await page(`(() => {
					const p = window.__panelTranscript, s = p.scroller;
					s.dispatchEvent(new WheelEvent('wheel', { deltaY: ${position === "reading" ? -120 : 120}, bubbles: true }));
					s.scrollTop = ${position === "reading" ? "Math.max(0, s.scrollHeight - s.clientHeight * 2.5)" : "s.scrollHeight"};
					if (${name === "huge-code" && position === "reading"}) {
						const code = p.session.querySelector('pre');
						s.scrollTop += code.getBoundingClientRect().top - s.getBoundingClientRect().top - 120;
					}
				})()`);
				await settle();
				for (let repeat = 0; repeat < 3; repeat++) {
					for (const direction of ["open", "close"]) {
						await page(`(() => {
							const p = window.__panelTranscript, s = p.scroller, view = s.getBoundingClientRect();
							const paragraphs = [...p.session.querySelectorAll('[data-plume-quote=assistant] p')];
							p.anchor = paragraphs.find(e => { const r = e.getBoundingClientRect(); return r.top >= view.top + 10 && r.top < view.bottom - 20; }) ?? paragraphs.at(-1);
							p.body = p.anchor.closest('[data-plume-quote=assistant]');
							p.active = true; p.frames = [];
							p.sample = t => {
								const content = getComputedStyle(p.session.parentElement), style = getComputedStyle(p.session);
								const cap = parseFloat(style.maxWidth);
								const expected = Math.min(Number.isFinite(cap) ? cap : Infinity, document.querySelector('[data-panel-layout] > main').getBoundingClientRect().width - p.gutter - (s.offsetWidth - s.clientWidth) - parseFloat(content.paddingLeft) - parseFloat(content.paddingRight));
								const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--plume-bottom-inset')) || 0;
								return { t, main: document.querySelector('[data-panel-layout] > main').getBoundingClientRect().width,
									viewport: s.getBoundingClientRect().width, body: p.body.getBoundingClientRect().width, paragraph: p.anchor.getBoundingClientRect().width,
									expected, top: s.scrollTop, lag: s.scrollHeight - s.clientHeight - s.scrollTop, height: s.scrollHeight, view: s.clientHeight,
									anchor: p.anchor.isConnected ? p.anchor.getBoundingClientRect().top - s.getBoundingClientRect().top : null,
									connected: p.body.isConnected, blank: s.scrollTop > 0 ? s.getBoundingClientRect().bottom - p.session.getBoundingClientRect().bottom - inset : 0,
									codeOverflow: Math.max(0, ...[...p.body.querySelectorAll('pre')].map(code => code.getBoundingClientRect().width - p.body.getBoundingClientRect().width)) };
							};
							p.frames.push(p.sample(performance.now()));
							const tick = t => { if (!p.active) return; p.frames.push(p.sample(t)); p.raf = requestAnimationFrame(tick); };
							p.raf = requestAnimationFrame(tick);
							// 应用自己的 ResizeObserver 已先注册；补记它调整后的滚动位置，避免把绘制前的中间态当成跳动。
							p.observer = new ResizeObserver(() => {
								const last = p.frames.at(-1);
								if (p.active && last) Object.assign(last, p.sample(last.t));
							});
							p.observer.observe(s); p.observer.observe(p.session);
						})()`);
						await clickReal(window, TOGGLE);
						await until(`document.querySelector('[data-panel-area]').inert === ${direction === "close"}`, direction);
						await settle();
						const frames = await page<Frame[]>(
							`(() => { const p = window.__panelTranscript; p.active = false; cancelAnimationFrame(p.raf); p.observer.disconnect(); return p.frames; })()`,
						);
						samples.push({ name, position, direction, repeat, frames });
						await writeFile(join(outDir, "panel-transcript.json"), JSON.stringify({ samples, failures }, null, 2));
					}
				}
				await writeFile(join(outDir, `smoke-panel-transcript-${name}-${position}.png`), (await window.webContents.capturePage()).toPNG());
			}
		}
		const report = samples.map((sample) => {
			const { frames } = sample;
			const first = frames[0]!;
			const last = frames.at(-1)!;
			const start = Math.max(0, frames.findIndex((f) => Math.abs(f.main - first.main) > 0.1) - 1);
			const end = frames.findLastIndex((f) => Math.abs(f.main - last.main) > 0.1) + 2;
			const animation = frames.slice(start, Math.max(start + 1, end));
			const intervals = animation
				.slice(1)
				.map((f, i) => f.t - animation[i]!.t)
				.sort((a, b) => a - b);
			const moving = frames.filter((f) => Math.abs(f.main - first.main) > 1 && Math.abs(f.main - last.main) > 1);
			const widthError = Math.max(...frames.map((f) => Math.abs(f.body - f.expected)), ...frames.map((f) => Math.abs(f.paragraph - f.body)));
			const tail = frames.filter((f) => Math.abs(f.main - last.main) <= 1);
			const tailJump = tail.length ? Math.max(...tail.map((f) => Math.abs(f.body - last.body))) : 0;
			const anchorDrift = Math.max(...frames.map((f) => Math.abs((f.anchor ?? Infinity) - (first.anchor ?? 0))));
			const label = `${sample.name}/${sample.position}/${sample.direction}/${sample.repeat}`;
			const check = (ok: boolean, message: string) => {
				if (!ok) failures.push(`${label}: ${message}`);
			};
			check(moving.length >= 3, "动画必须有至少 3 个中间帧");
			check(Math.abs(first.main - last.main) > 100, "真实开关必须改变对话卡片宽度");
			check(widthError <= 3, `正文必须逐帧贴合可用宽度，最大误差 ${widthError.toFixed(1)}px`);
			check(tailJump <= 3, `卡片到位后正文不能再跳宽，末段跳变 ${tailJump.toFixed(1)}px`);
			check(
				frames.every((f) => f.connected && f.anchor !== null),
				"正文与阅读锚点不能重挂",
			);
			check(
				frames.every((f) => f.blank <= 3),
				"不能露出额外的底部空白",
			);
			check(
				frames.every((f) => f.codeOverflow <= 3),
				"代码块必须留在正文宽度内，长代码自行横滚",
			);
			if (sample.position === "bottom") check(last.lag <= 3, `贴底状态应恢复到最新，距底 ${last.lag.toFixed(1)}px`);
			else {
				check(last.lag > last.view * 0.5, "阅读历史时不能被拖回底部");
				check(anchorDrift <= 64, `阅读锚点不能明显跳离原处，漂移 ${anchorDrift.toFixed(1)}px`);
			}
			return {
				name: sample.name,
				position: sample.position,
				direction: sample.direction,
				repeat: sample.repeat,
				frames: frames.length,
				movingFrames: moving.length,
				animationMs: animation.at(-1)!.t - animation[0]!.t,
				p95FrameMs: intervals[Math.max(0, Math.ceil(intervals.length * 0.95) - 1)] ?? 0,
				maxFrameMs: Math.max(0, ...intervals),
				over32Ms: intervals.filter((ms) => ms > 32).length,
				widthError,
				tailJump,
				anchorDrift,
				finalLag: last.lag,
			};
		});
		await writeFile(
			join(outDir, "panel-transcript.json"),
			JSON.stringify(
				{
					conditions: { width: 1200, height: 800, zoom: 1, reducedMotion: false, longTurns: 24, hugeParagraphs: 360, codeLines: 240 },
					report,
					failures,
					samples,
				},
				null,
				2,
			),
		);
		console.log("PLUME_PANEL_TRANSCRIPT", JSON.stringify({ report, failures }));
		assert.equal(failures.length, 0, failures.join("\n"));
	} catch (error) {
		await page("(() => { const p = window.__panelTranscript; if (p) { p.active = false; cancelAnimationFrame(p.raf); p.observer?.disconnect(); } })()").catch(
			() => undefined,
		);
		await writeFile(join(outDir, "panel-transcript-error.txt"), String(error));
		await writeFile(join(outDir, "smoke-panel-transcript-failed.png"), (await window.webContents.capturePage()).toPNG()).catch(() => undefined);
		throw error;
	} finally {
		setModel(undefined);
		window.setSize(size[0]!, size[1]!);
	}
}
