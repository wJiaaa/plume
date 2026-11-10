import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FakeReply } from "@plume/agent/testing";
import type { Remote } from "@plume/rpc";
import { app, type BrowserWindow } from "electron";
import type { AgentProcessApi } from "../shared/protocol.ts";
import { runPluginCli } from "./smoke-plugin-cli.ts";

const ASK = "冒烟：看一下这台机器的磁盘";
const DONE = "根分区用了 92%，先看看哪些日志最大。";

/**
 * SSH 运维（市场插件 plume.ssh）：先装上它，起一个本机的假 SSH 服务（plugins/ssh/test/smoke-server.mjs，只听 127.0.0.1）。
 * 在「SSH 主机」页新建一台主机、点它连上：第一次连先核对指纹，信任以后终端里出现服务器的提示符。然后对右边的运维助手说一句，
 * 假模型先 `ssh_sessions` 再 `ssh_run`：审批卡画在助手这一列的输入框上方（插件的独立会话没有别处可压），点「运行」后命令经 exec
 * 通道执行，工具卡片写着退出码。运维助手的会话记在插件名下、不挂在任何会话下，侧栏里没有它。
 */
export async function checkSsh(options: {
	window: BrowserWindow;
	agent: Remote<AgentProcessApi>;
	plugin: { cli: string | undefined | void; pluginsDir: string; installDir: string };
	outDir: string;
	setModel(override: ((request: Record<string, unknown>) => FakeReply) | undefined): void;
}): Promise<void> {
	const { window, agent, plugin, outDir, setModel } = options;
	const page = <T>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
	const wait = async (condition: () => Promise<boolean>, label: string, timeout = 20_000) => {
		const end = Date.now() + timeout;
		while (!(await condition())) {
			if (Date.now() > end) throw new Error(`SSH 冒烟等待超时：${label}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	const until = (code: string, label: string) => wait(() => page<boolean>(`Boolean(${code})`), label);
	const click = async (selector: string, label: string) =>
		until(
			`(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (!target || target.disabled) return false; target.click(); return true; })()`,
			label,
		);
	const type = async (selector: string, value: string) => {
		await until(`document.querySelector(${JSON.stringify(selector)})`, `输入框 ${selector}`);
		await page(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select?.(); })()`);
		await window.webContents.insertText(value);
	};
	const capture = async (name: string) => {
		await page("new Promise(resolve => setTimeout(resolve, 400))");
		await writeFile(join(outDir, name), (await window.webContents.capturePage()).toPNG());
	};

	const script = resolve(app.getAppPath(), "../../../plume-plugins/plugins/ssh/test/smoke-server.mjs");
	const server = spawn(process.execPath, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "inherit"] });
	try {
		const port = await new Promise<number>((done, fail) => {
			let buffered = "";
			server.stdout.on("data", (chunk: Buffer) => {
				buffered += chunk.toString();
				const match = /PORT (\d+)/.exec(buffered);
				if (match) done(Number(match[1]));
			});
			server.on("exit", (code) => fail(new Error(`假 SSH 服务退出了（${code}）`)));
		});

		if (!plugin.cli) throw new Error("没有插件安装命令");
		await runPluginCli(plugin.cli, ["install", join(plugin.pluginsDir, "ssh"), "--to", plugin.installDir]);
		await wait(async () => (await agent.plugins()).some((item) => item.name === "plume.ssh" && item.state === "active"), "SSH 插件加载");
		await until(
			`(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "SSH 主机"); button?.click(); return Boolean(button); })()`,
			"侧栏的「SSH 主机」",
		);
		await until(`document.querySelector('[data-ssh-hosts] .ssh-assistant')`, "主机页和运维助手");

		// 新建一台主机：名称、地址、端口、账号、密码。
		await click("[data-ssh-new-host]", "新建主机");
		await page(`document.querySelectorAll('[data-ssh-host-form] input').forEach((input, index) => input.setAttribute('data-smoke-field', String(index)))`);
		await type('[data-smoke-field="0"]', "smoke-web");
		await type('[data-smoke-field="1"]', "127.0.0.1");
		await type('[data-smoke-field="2"]', String(port));
		await type('[data-smoke-field="3"]', "plume");
		await type('[data-smoke-field="4"]', "smoke-pass");
		await click("[data-ssh-save-host]", "保存主机");
		await until(`!document.querySelector('[data-ssh-host-form]') && document.querySelector('[data-ssh-connect]')`, "主机进了列表");

		// 连上：第一次连先核对指纹。
		await click("[data-ssh-connect]", "点主机连接");
		await until(`document.querySelector('[data-ssh-hostkey] [data-ssh-fingerprint]')?.textContent.startsWith('SHA256:')`, "指纹核对卡");
		await capture("smoke-ssh-hostkey.png");
		await click("[data-ssh-trust]", "信任并连接");
		await until(`document.querySelector('.ssh-terminal')?.textContent.includes('plume@smoke:~$')`, "终端里的提示符");
		await until(`document.querySelector('[data-ssh-tab="smoke-web"] .ssh-dot[data-state="connected"]')`, "标签显示已连接");

		// 运维助手：列连接、请求执行一条命令，审批卡在助手这一列里。
		setModel((request) => {
			const messages = JSON.stringify(request.messages);
			const tools = new Set(((request.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name));
			if (!messages.includes("toolu_ssh_sessions")) {
				assert.ok(tools.has("ssh_sessions") && tools.has("ssh_run"), "运维助手里有 SSH 工具");
				assert.match(JSON.stringify(request.system ?? ""), /SSH operations assistant/, "运维助手的提示词");
				return { toolCalls: [{ id: "toolu_ssh_sessions", name: "ssh_sessions", args: {} }] };
			}
			if (!messages.includes("toolu_ssh_run")) {
				const id = /\\"id\\":\\"([0-9a-f-]{36})\\"/.exec(messages)?.[1];
				assert.ok(id, "ssh_sessions 交回了连接 id");
				return {
					toolCalls: [{ id: "toolu_ssh_run", name: "ssh_run", args: { connection: id, command: "df -h /", reason: "看根分区的占用" } }],
				};
			}
			return { text: DONE };
		});
		// 第一句还没发时，运维助手这一段已经开好（空的），输入框旁就有模型和思考档位，能先换模型。
		await until(`document.querySelector('.ssh-assistant [data-model-trigger]')`, "发第一句前就有模型选择");
		await capture("smoke-ssh-empty.png");
		await page(`document.querySelector('.ssh-assistant .cm-content').focus()`);
		await window.webContents.insertText(ASK);
		await click(".ssh-assistant [data-composer-send=send]", "发给运维助手");
		await until(`document.querySelector('.ssh-assistant [data-approval-region] [data-ssh-run-accept]')`, "审批卡在运维助手这一列");
		await capture("smoke-ssh-approval.png");
		await click(".ssh-assistant [data-ssh-run-accept]", "运行");
		await until(`document.querySelector('.ssh-assistant [data-ssh-run-status="succeeded"]')`, "工具卡片：退出码 0");
		await until(`document.querySelector('.ssh-assistant')?.textContent.includes(${JSON.stringify(DONE)})`, "运维助手的回复");
		await capture("smoke-ssh.png");
		await page('window.plume.saveAppearance({ theme: "dark" })');
		await until("matchMedia('(prefers-color-scheme: dark)').matches", "深色主题");
		await capture("smoke-ssh-dark.png");
		await page('window.plume.saveAppearance({ theme: "light" })');

		const assistant = (await agent.sessions()).find((item) => item.owner === "plume.ssh");
		assert.ok(assistant, "运维助手的会话记在插件名下");
		assert.equal(assistant.parentId, undefined, "运维助手的会话不挂在别的会话下");
		assert.equal(await page<boolean>(`document.querySelector('[data-plume-row="${assistant.id}"]') === null`), true, "侧栏里没有运维助手的会话");
	} finally {
		setModel(undefined);
		server.kill();
	}
}
