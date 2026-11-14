import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import type { BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { clickVisible, clickVisibleIn, contextMenuVisible } from "./smoke-kit.ts";

const PROMPTS = ["起一个本地服务，盯着它，一分钟后叫醒你", "顺便看看端口", "好，等它自己醒"];
const STARTED = "服务起来了，盯着输出、约好回来都安排好了。";
const REPLIES = ["端口在环境卡片里。", "好的，到点我会自己接着做。"];
const WOKE = "唤醒到点了，接着看服务。";
const SUMMARY = "冒烟会话：起了一个本地服务，监视一条命令的输出，安排了检查回来看服务。";
const FIRE = "冒烟里到点的检查";
const CANCEL = "冒烟里取消的检查";
const AGAIN = "冒烟里被叫醒后再安排的检查";
/** 在本机随便一个端口上开 HTTP 服务，把地址打出来：端口发现既能从系统表找到它，也能拿输出里的地址补全 URL。 */
const SERVER = `node -e "require('node:http').createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', function () { console.log('http://127.0.0.1:' + this.address().port + '/') })"`;

/**
 * 环境卡片的几样关联：假模型一轮里起一条后台 HTTP 服务、一个没有输出的 `monitor`、两次 `schedule_wakeup`（一分钟、十分钟后的检查）。
 * 卡片收着时开关上有圆点、说明里数着监视和待触发的检查；打开后「后台任务」一节里服务那一行有端口签、监视那一行有「监视」签，
 * 服务被认成挂着的（`TrackedJob.stand`）、会话不再算有后台的事没完，同一节里两个检查，取消掉十分钟那个；
 * 点服务那一行到任务面板看服务地址。再说两句凑够摘要要的三句人话，等一分钟那个到点——对话里出现「检查 · …」那一行、会话被叫醒开一轮，
 * 那一轮再安排一次；换成英文界面，转录里的工具行（在 memo 后面）、送达那一行和卡片不重挂就当场换过来，再换回中文；在卡片里取消它，安排它的那一行标「已停止」。最后归档这个会话：服务、监视跟着停掉（端口不再应答），
 * 之后没有「后台命令完成」那一行、不再请求模型。卡片里没有「全部停止」。这段要一分多钟，大头是等到点的一分钟。
 *
 * 会话摘要单独一段（`part: "summary"`，段名 environment-summary）：装上市场插件 plume.summary，说三句人话，这一轮结束静下来一分钟后
 * 卡片里出现摘要，设置 › 智能体里有选摘要模型的那一行。原来接在唤醒后面，两个一分钟串着等，整段两分多钟；分开后两段并行。
 */
export async function checkEnvironment(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; install(name: string): Promise<void>; installDir: string };
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
	part: "wakeup" | "summary";
}): Promise<void> {
	const { window, agent, plugin, outDir, setModel, part } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string, timeout = 15_000) => {
		const end = Date.now() + timeout;
		while (!(await condition())) {
			if (Date.now() > end) throw new Error(`环境卡片等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	// 跟在别的段后面跑时权限可能停在「请求批准」：等的同时把弹出的审批卡都答「允许一次」，单独跑时没有这张卡。
	const until = (code: string, label: string, timeout?: number) =>
		wait(
			async () => {
				if (await page<boolean>(`[...document.querySelectorAll('[data-approval-card] button')].some((button) => button.textContent.includes('允许一次'))`))
					await clickVisible(page, `[data-approval-card] button`, /允许一次/);
				return page<boolean>(code);
			},
			label,
			timeout,
		);
	const settled = () => page(`new Promise(resolve => setTimeout(resolve, 500))`);
	const capture = async (name: string) => {
		await settled();
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};
	const chatHas = (text: string) => `document.querySelector('[data-screen=chat]')?.textContent.includes(${JSON.stringify(text)}) === true`;
	const send = async (text: string) => {
		await page(`document.querySelector('.cm-content').focus()`);
		await window.webContents.insertText(text);
		await until(`document.querySelector('[data-composer-send=send]')?.disabled === false`, "可以发送");
		await clickVisible(page, `[data-composer-send=send]`);
	};
	const toggleLabel = () => page<string>(`document.querySelector('[data-environment-toggle]')?.getAttribute('aria-label') ?? ''`);
	if (part === "summary") {
		await checkSummary();
		return;
	}
	let requests = 0;
	setModel((request) => {
		requests++;
		const messages = (request.messages ?? []) as Array<{ role?: string }>;
		// 看上一条回复之后送来的全部，不只最后一条：人的话、唤醒的送达后面还会接一段 `<env>` 环境信息，
		// 只认最后一条就认不出唤醒、又回一遍起服务的工具调用。
		const last = JSON.stringify(messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1));
		if (last.includes("toolu_env_again")) return { text: WOKE };
		// 被叫醒的那一轮再约一次：之后在卡片里取消它，看约它的那一行标「已停止」。
		if (last.includes("<wakeup"))
			return { toolCalls: [{ id: "toolu_env_again", name: "schedule_wakeup", args: { delay_seconds: 60, prompt: "再看一次服务", reason: AGAIN } }] };
		if (last.includes(PROMPTS[1]!)) return { text: REPLIES[0]! };
		if (last.includes(PROMPTS[2]!)) return { text: REPLIES[1]! };
		if (last.includes("toolu_env_server")) return { text: STARTED };
		if (!last.includes(PROMPTS[0]!)) return { text: `没认出这一轮：${last.slice(0, 200)}` };
		return {
			toolCalls: [
				{ id: "toolu_env_server", name: "bash", args: { command: SERVER, description: "冒烟用的本地服务", run_in_background: true } },
				{ id: "toolu_env_monitor", name: "monitor", args: { command: "sleep 600", description: "冒烟用的监视" } },
				{ id: "toolu_env_fire", name: "schedule_wakeup", args: { delay_seconds: 60, prompt: "看看服务还在不在", reason: FIRE } },
				{ id: "toolu_env_cancel", name: "schedule_wakeup", args: { delay_seconds: 600, prompt: "十分钟后再看", reason: CANCEL } },
			],
		};
	});
	try {
		const previous = new Set((await agent.sessions()).map((item) => item.id));
		window.webContents.send("plume:command", "new-session");
		await until(`document.querySelector('[data-screen=empty]') !== null`, "新建对话");
		await send(PROMPTS[0]!);
		await wait(async () => (await agent.sessions()).some((item) => !previous.has(item.id)), "新会话已创建");
		await until(chatHas(STARTED), "这一轮安排好服务、监视和唤醒后收尾");
		await until(`document.querySelector('[data-environment-toggle]') !== null`, "环境开关已加载");

		// 卡片收着：开关上的圆点和说明数着监视和待触发的检查。
		if (await page<boolean>(`document.querySelector('[data-environment]') !== null`)) await clickVisible(page, `[data-environment-toggle]`);
		await until(`document.querySelector('[data-environment-toggle] [data-environment-dot]') !== null`, "收着的开关上有圆点");
		await wait(async () => /1 个监视在跑，2 个检查待触发/.test(await toggleLabel()), "开关说明数着监视和待触发的检查");
		await capture("smoke-environment-toggle.png");

		// 打开卡片：「后台任务」一节里服务那一行有端口签、监视那一行有「监视」签，两个检查也列在同一节里；没有「全部停止」。
		await clickVisible(page, `[data-environment-toggle]`);
		await until(`document.querySelector('[data-environment-port]')?.textContent.startsWith(':') === true`, "服务那一行有端口签", 30_000);
		await until(`document.querySelector('[data-environment-monitor]') !== null`, "监视那一行有监视签");
		// 服务打印了本机地址，plume.tools 经 `TrackedJob.stand` 标成挂着的；监视登记时就是挂着的。两样都还在跑，会话却不算还有后台的事没完
		// （`background` 不再是 true）：stand 没生效的话，它要一直等到最后归档。
		await wait(async () => (await agent.sessions()).find((item) => !previous.has(item.id))?.background !== true, "服务被认成挂着的，会话不再等它结束");
		if ((await page<number>(`document.querySelectorAll('[data-environment-job]').length`)) !== 2) throw new Error("服务和监视应该都还在跑");
		await until(`document.querySelectorAll('[data-environment-section$="/jobs"] [data-environment-wakeup]').length === 2`, "检查和后台命令列在同一节里，两个");
		if (await page<boolean>(`document.querySelector('[data-environment-section$="/wakeups"], [data-environment-stop-all]') !== null`))
			throw new Error("环境卡片里还有单独的定时唤醒一节或「全部停止」");
		if (!(await page<boolean>(`/检查 · \\d+:\\d\\d$/.test(document.querySelector('[data-environment-wakeup][data-plan=checkIn]').textContent)`)))
			throw new Error("检查那一行没在小字里写「检查 · 几点」");
		if (!(await page<boolean>(`document.querySelector('[data-environment-monitor]').textContent === '监视'`))) throw new Error("监视那一行没有「监视」签");
		if (await page<boolean>(`document.querySelector('[data-environment-toggle] [data-environment-dot]') !== null`))
			throw new Error("卡片开着时开关上还挂着圆点");
		await capture("smoke-environment-card.png");

		// 卡片的放法：在右边那一列里，从不进输入框上方；够宽时停靠、输入框让出这一列，窄了浮在转录右上角。
		const placement = () =>
			page<{ lane: string | null; inComposer: boolean; overlap: boolean }>(`(() => {
				const card = document.querySelector('[data-environment]');
				const composer = document.querySelector('.plume-composer-dock');
				const a = card?.getBoundingClientRect(), b = composer?.getBoundingClientRect();
				return {
					lane: card?.closest('[data-conversation-lane]')?.getAttribute('data-conversation-lane') ?? null,
					inComposer: Boolean(card?.closest('.plume-composer-dock')),
					overlap: Boolean(a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom),
				};
			})()`);
		const wide = await placement();
		if (!wide.lane || wide.inComposer || wide.overlap) throw new Error(`环境卡片没在右边那一列：${JSON.stringify(wide)}`);
		const [width, height] = window.getContentSize();
		window.setContentSize(Math.min(width!, 700), height!);
		await until(
			`document.querySelector('[data-environment]')?.closest('[data-conversation-lane]')?.getAttribute('data-conversation-lane') === 'floating'`,
			"窄窗口里环境卡片浮在转录上",
		);
		const narrow = await placement();
		if (narrow.inComposer || narrow.overlap) throw new Error(`窄窗口里环境卡片落到了输入框那里：${JSON.stringify(narrow)}`);
		await capture("smoke-environment-card-narrow.png");
		window.setContentSize(width!, height!);
		await settled();

		// 取消十分钟那项。
		await clickVisibleIn(
			page,
			`[...document.querySelectorAll('[data-environment-wakeup]')].filter((row) => row.textContent.includes(${JSON.stringify(CANCEL)})).map((row) => row.querySelector('[data-wakeup-cancel]'))`,
			"十分钟那项的取消",
		);
		await until(
			`document.querySelectorAll('[data-environment-wakeup]').length === 1 && document.querySelector('[data-environment-wakeup]').textContent.includes(${JSON.stringify(FIRE)})`,
			"取消后只剩一分钟那项",
		);

		// 点服务那一行：任务面板里列出服务地址，带打开、复制。
		const port = await page<string>(`document.querySelector('[data-environment-port]').textContent.slice(1)`);
		await clickVisibleIn(page, `[...document.querySelectorAll('[data-environment-port]')].map((port) => port.closest('button'))`, "服务那一行");
		await until(`document.querySelector('[data-session-services] [data-service-endpoint="${port}"]') !== null`, "任务面板列出服务地址");
		if (!(await page<string>(`document.querySelector('[data-service-endpoint="${port}"]').textContent`)).includes(`127.0.0.1:${port}`))
			throw new Error("服务地址不是本机这个端口");
		await capture("smoke-environment-endpoint.png");

		// 凑够摘要要的三句人话。
		await send(PROMPTS[1]!);
		await until(chatHas(REPLIES[0]!), "第二句的回复");
		await send(PROMPTS[2]!);
		await until(chatHas(REPLIES[1]!), "第三句的回复");

		// 一分钟那个到点：送达那一行（「检查 · 那句话」）和被叫醒的一轮。
		const row = "[data-screen=chat] [data-delivery-row][data-delivery-kind=wakeup]";
		await until(`document.querySelector(${JSON.stringify(row)})?.textContent.includes(${JSON.stringify(FIRE)}) === true`, "对话里出现检查到点那一行", 120_000);
		if (!(await page<string>(`document.querySelector(${JSON.stringify(row)}).textContent`)).includes(`检查 · ${FIRE}`))
			throw new Error("送达那一行没写「检查 · 那句话」");
		await until(chatHas(WOKE), "唤醒叫醒会话开了一轮");
		await until(
			`document.querySelectorAll('[data-environment-wakeup]').length === 1 && document.querySelector('[data-environment-wakeup]').textContent.includes(${JSON.stringify(AGAIN)})`,
			"到点那项不在了，只剩被叫醒的那一轮新约的",
		);
		await page(`document.querySelector(${JSON.stringify(row)}).scrollIntoView({ block: 'center' })`);
		await capture("smoke-environment-wakeup.png");
		// 再安排那次调用：行上说动作和理由，没到点时照跑完画。
		const again = `[data-screen=chat] [data-tool-call="toolu_env_again"]`;
		await until(
			`document.querySelector(${JSON.stringify(again)})?.dataset.status === 'done' && document.querySelector(${JSON.stringify(again)}).textContent.includes(${JSON.stringify(`已安排检查 ${AGAIN}`)})`,
			"安排检查的那一行说动作和那句话",
		);
		// 点开它：列成几行「名称 值」（检查时间、原因、有效期、ID、提示词），不摆写给模型的结果。
		await clickVisible(page, `${again} > button`);
		await until(
			`document.querySelector(${JSON.stringify(`${again} [data-tool-fields]`)})?.textContent.includes('检查时间') === true && document.querySelector(${JSON.stringify(`${again} [data-tool-fields]`)}).textContent.includes('再看一次服务')`,
			"点开安排检查的那一行列出几样事实",
		);
		await page(`document.querySelector(${JSON.stringify(again)}).scrollIntoView({ block: 'center' })`);
		await capture("smoke-environment-wakeup-fields.png");
		await clickVisible(page, `${again} > button`);
		await until(`document.querySelector(${JSON.stringify(`${again} > button`)})?.getAttribute('aria-expanded') === 'false'`, "收起安排检查的那一行");

		// 换界面语言：转录里的工具行、送达那一行和卡片当场换成英文。工具行在 memo 后面，没订阅语言时会停在中文。
		// 先在那一行的节点上做个记号，回来时还在才说明对话没被重挂——重挂了谁都会换，验不出什么。
		const setLanguage = async (sections: string, title: string, option: string, backLabel: string) => {
			window.webContents.send("plume:command", "settings");
			await until(`document.querySelector('[data-screen=settings]') !== null`, `换成 ${option}：打开设置`);
			await clickVisible(page, `[aria-label="${sections}"] button`, sections === "设置章节" ? "常规" : "General");
			await clickVisible(page, `[aria-haspopup=menu][aria-label="${title}"]`);
			// 选项前面还有语言的小标记（EN、中），按结尾认。
			await clickVisible(page, `[role=menuitem]`, new RegExp(`${option}$`));
			await clickVisible(page, "button", backLabel);
			await until(`document.querySelector('[data-screen=chat]') !== null`, `换成 ${option}：回到对话`);
		};
		await page(`document.querySelector(${JSON.stringify(again)}).plumeSmokeMark = true`);
		await setLanguage("设置章节", "界面语言", "English", "Back to workspace");
		if (!(await page<boolean>(`document.querySelector(${JSON.stringify(again)})?.plumeSmokeMark === true`)))
			throw new Error("换语言后对话被重新挂载了，验不出工具行跟没跟着换");
		await until(
			`document.querySelector(${JSON.stringify(again)}).textContent.includes(${JSON.stringify(`Scheduled check-in ${AGAIN}`)}) && document.querySelector(${JSON.stringify(row)}).textContent.includes(${JSON.stringify(`Check-in · ${FIRE}`)}) && /^Check-in · /.test(document.querySelector('[data-environment-wakeup] [data-plume-tip] > :last-child')?.textContent ?? '')`,
			"换成英文后工具行、送达那一行和卡片当场跟着换",
		);
		if (
			await page<boolean>(
				`(() => { const screen = document.querySelector('[data-screen=chat]').cloneNode(true); screen.querySelector('.plume-composer-dock')?.remove(); return /已安排检查|运行 \\d 个命令/.test(screen.textContent); })()`,
			)
		)
			throw new Error("换成英文后转录里还有中文的工具说法");
		await capture("smoke-environment-english.png");
		await setLanguage("Settings sections", "Interface language", "简体中文", "返回工作区");
		await until(`document.querySelector(${JSON.stringify(again)}).textContent.includes(${JSON.stringify(`已安排检查 ${AGAIN}`)})`, "换回中文");

		// 在卡片里取消再安排的那个：转录里安排它的那一行跟着标「已停止」。
		await clickVisibleIn(page, `[...document.querySelectorAll('[data-environment-wakeup] [data-wakeup-cancel]')]`, "再安排那个的取消");
		await until(`document.querySelectorAll('[data-environment-wakeup]').length === 0`, "取消后卡片里没有检查了");
		await until(
			`document.querySelector(${JSON.stringify(again)})?.dataset.status === 'failed' && document.querySelector(${JSON.stringify(again)}).textContent.includes('已停止')`,
			"取消的那个在安排它的那一行标「已停止」",
		);

		// 归档：服务、监视跟着停掉，不在人看不见的地方接着跑；停掉的退出时不送回会话，也不再请求模型。
		await until(`document.querySelectorAll('[data-environment-job]').length === 2`, "归档前服务和监视还在跑");
		const answers = () =>
			fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).then(
				() => true,
				() => false,
			);
		if (!(await answers())) throw new Error("归档前服务就不应答了");
		const id = (await agent.sessions()).find((item) => !previous.has(item.id))!.id;
		const before = requests;
		await contextMenuVisible(page, `[data-plume-row="${id}"]`);
		await clickVisible(page, `[role=menu][aria-label="会话选项"] [role=menuitem]`, "归档");
		await wait(async () => (await agent.sessions()).find((item) => item.id === id)?.archived === true, "会话已归档");
		await wait(async () => !(await answers()), "归档后服务停掉、端口不再应答");
		await page(`new Promise(resolve => setTimeout(resolve, 3000))`);
		if (requests !== before) throw new Error(`归档后又请求了 ${requests - before} 次模型`);
		const session = (await agent.sessions()).find((item) => item.id === id);
		if (session?.running) throw new Error("归档后会话又开了一轮");
		await capture("smoke-environment-archived.png");
	} finally {
		setModel(undefined);
	}

	/** 说三句人话（摘要要够三句），这一轮结束静下来一分钟后卡片里出现摘要；生成摘要不算在会话里，不出现在对话中。 */
	async function checkSummary() {
		if (!plugin.cli) throw new Error("没有生成 plume-plugin 启动脚本");
		await plugin.install("summary");
		await wait(async () => (await agent.plugins()).some((status) => status.key === "summary" && status.state === "active"), "装上会话摘要插件");
		let summaries = 0;
		const replies = [STARTED, ...REPLIES];
		setModel((request) => {
			if (JSON.stringify(request.system ?? "").includes("实时摘要")) {
				summaries++;
				return { text: SUMMARY };
			}
			const messages = (request.messages ?? []) as Array<{ role?: string }>;
			// 和上面一样看上一条回复之后的全部：人这句后面还接着一段 `<env>` 环境信息。
			const last = JSON.stringify(messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1));
			const index = PROMPTS.findIndex((prompt) => last.includes(prompt));
			return { text: replies[index] ?? `没认出这一轮：${last.slice(0, 200)}` };
		});
		try {
			window.webContents.send("plume:command", "new-session");
			await until(`document.querySelector('[data-screen=empty]') !== null`, "新建对话");
			for (const [index, prompt] of PROMPTS.entries()) {
				await send(prompt);
				await until(chatHas(replies[index]!), `第 ${index + 1} 句的回复`);
			}
			await until(`document.querySelector('[data-environment-toggle]') !== null`, "环境开关已加载");
			if (!(await page<boolean>(`document.querySelector('[data-environment]') !== null`))) await clickVisible(page, `[data-environment-toggle]`);
			await until(
				`document.querySelector('[data-environment-summary]')?.textContent.includes(${JSON.stringify(SUMMARY)}) === true`,
				"卡片里出现会话摘要",
				150_000,
			);
			if (summaries !== 1) throw new Error(`应该生成一次摘要，实际 ${summaries} 次`);
			// 环境卡片也在对话那一屏里：去掉它再看转录。
			const transcript = await page<string>(
				`(() => { const screen = document.querySelector('[data-screen=chat]').cloneNode(true); screen.querySelector('[data-environment]')?.remove(); return screen.textContent; })()`,
			);
			if (transcript.includes(SUMMARY)) throw new Error("摘要混进了对话");
			await page(`document.querySelector('[data-environment-summary]').scrollIntoView({ block: 'nearest' })`);
			await capture("smoke-environment-summary.png");
		} finally {
			setModel(undefined);
		}

		window.webContents.send("plume:command", "settings");
		await until(`document.querySelector('[aria-label=设置章节]') !== null`, "设置打开");
		await clickVisible(page, `[aria-label=设置章节] button`, "智能体");
		await until(`document.body.textContent.includes('会话摘要模型')`, "智能体设置里有会话摘要模型");
		await page(
			`[...document.querySelectorAll('*')].find((node) => node.childElementCount === 0 && node.textContent === '会话摘要模型')?.scrollIntoView({ block: 'center' })`,
		);
		await capture("smoke-environment-summary-model.png");
	}
}
