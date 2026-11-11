/**
 * 硬编码中文检查（`pnpm check` 的一部分）：界面上给人读的文字要走 i18n，不能直接写在代码里。
 *
 * 算法在插件 SDK 的 lib/lint/i18n.mjs（插件作者的 `plume-plugin check` 用同一份）。算一条的：字符串字面量或 JSX 文本里有汉字或中文标点。不算的：注释（注释本来就用中文写）、
 * 日志调用的参数（`console.*` 和 Plume 的 log，写给调试的人看的）、紧跟在 `i18n-exempt` 注释后面、到下一个空行为止的几行
 * （给人读但不能翻译的字：发给模型的提示词、和存量数据比对的固定字符串……注释里写明原因）。
 *
 * 中文标点单独算：词都翻译完以后剩下的就是 `parts.join("、")`、`${name}：${message}` 这种，
 * 只查汉字会放过它们，而它们在英文界面里会夹出中文标点。
 *
 * 不设基线：Plume 已经全部换掉，出现一条就失败。
 *
 *   node scripts/check-i18n.mjs          # 报告，有发现就非零退出
 *   node scripts/check-i18n.mjs --list   # 把每一条打出来
 *
 * 文案放哪：
 * - 渲染进程（产品界面、@plume/ui）：`@plume/ui` 的 `useI18n().t()` / `translate()`，
 *   key 加进 packages/client/ui/src/i18n/messages/ 的 zh-CN.ts 和 en.ts（zh-CN 是源，en satisfies 它，漏一种语言是类型错误）。
 * - 主进程：apps/desktop/src/main/i18n.ts 的 nativeText()（菜单栏图标的菜单）；对话框标题由渲染进程传进来。
 * - agent 进程：packages/core/agent/src/i18n.ts 的 text()。
 * - 插件：自带中英两份文案，放在 src/messages.ts；界面入口用 `@plume/ui` 的 useI18n() 取当前语言，逻辑入口用 ctx.locale()（例子见 packages/builtin/todo）。
 */

import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { chineseFindings } from "../packages/sdk/plugin-sdk/lib/lint/i18n.mjs";

const root = resolve(import.meta.dirname, "..");

/** 扫描的目录：所有会把文字放到人眼前的代码。市场插件在插件仓库里，由它自己的检查（插件 SDK 的同一条规则）管。 */
const SCANNED = ["apps/desktop/src", "packages/client", "packages/core/agent/src", "packages/builtin"];

/**
 * 内容本身就是中文的文件。
 *
 * - 文案目录：本来就该写成多种语言。
 * - locales.ts：语言选项用它自己的文字写自己的名字（「中」「简体中文」），翻译了反而读不懂。
 * - smoke.ts：冒烟按默认的中文界面找按钮、读文字，它的断言信息是写给开发者的。
 * - 插件自带的文案：插件拿不到产品的目录，两种语言写在自己的 src/messages.ts 里（例子见 packages/builtin/todo）。
 */
const EXEMPT = [
	"packages/client/ui/src/i18n/messages/",
	"packages/client/ui/src/i18n/locales.ts",
	"packages/core/agent/src/i18n.ts",
	"apps/desktop/src/main/i18n.ts",
	"apps/desktop/src/main/smoke.ts",
	// 交付卡真实 Electron 冒烟的中文选择器与断言，同 smoke.ts。
	"apps/desktop/src/main/smoke-delivery.ts",
	// 文件预览真实 Electron 冒烟的中文选择器与断言。
	"apps/desktop/src/main/smoke-files.ts",
	"apps/desktop/src/main/smoke-file-operations.ts",
	"apps/desktop/src/main/smoke-file-terminal.ts",
	"apps/desktop/src/main/smoke-quote-side-chat.ts",
	"apps/desktop/src/main/smoke-project-config.ts",
	"apps/desktop/src/main/smoke-gallery.ts",
	"apps/desktop/src/main/smoke-navigation.ts",
	"apps/desktop/src/main/smoke-document-plugins.ts",
	// 面板与拖拽冒烟同样按中文界面查找，断言不属于产品文案。
	"apps/desktop/src/main/smoke-sidebar-resize.ts",
	"apps/desktop/src/main/smoke-panels.ts",
	// 浏览器插件的冒烟同样按中文界面找菜单项、发消息，断言是写给开发者的。
	"apps/desktop/src/main/smoke-browser.ts",
	// 原生界面块冒烟的模型样例、中文选择器及开发者断言。
	"apps/desktop/src/main/smoke-native-ui.ts",
	// Markdown 图片冒烟的中文样例、选择器和开发者断言。
	"apps/desktop/src/main/smoke-markdown-images.ts",
	// 网页预览冒烟的页面样例、中文选择器和断言。
	"apps/desktop/src/main/smoke-preview.ts",
	// 换肤工坊冒烟的中文选择器、假模型回答和开发者断言。
	"apps/desktop/src/main/smoke-skin-studio.ts",
	// 拉取请求冒烟只访问本机假服务，中文选择器和断言不属于产品文案。
	"apps/desktop/src/main/smoke-pull-requests.ts",
	// 应用更新冒烟按中文界面找按钮、读状态，断言是写给开发者的。
	"apps/desktop/src/main/smoke-update.ts",
	// 分叉、编辑重发、撤回的冒烟按中文界面找按钮，断言是写给开发者的。
	"apps/desktop/src/main/smoke-message-edits.ts",
	// 独立窗口的冒烟按中文界面找菜单项，断言是写给开发者的。
	"apps/desktop/src/main/smoke-session-window.ts",
	// 桌面兼容的冒烟按中文界面找面板开关和「添加面板」，断言是写给开发者的。
	"apps/desktop/src/main/smoke-desktop-compat.ts",
	// 输入历史、列表设置菜单、排队条菜单的冒烟按中文界面找按钮，断言是写给开发者的。
	"apps/desktop/src/main/smoke-composer-history.ts",
	"apps/desktop/src/main/smoke-queue.ts",
	// 本体会话列表、草稿和排队的冒烟按中文界面找按钮，断言是写给开发者的。
	"apps/desktop/src/main/smoke-conversations.ts",
	// 提问卡真实 Electron 冒烟的中文选择器与断言，同 smoke.ts。
	"apps/desktop/src/main/smoke-question.ts",
	// 后台命令送达的冒烟按中文界面读那一行，假模型的回复和断言是写给开发者的。
	"apps/desktop/src/main/smoke-background-job.ts",
	// 环境卡片的冒烟按中文界面读开关的说明、端口和唤醒，假模型的回复和断言是写给开发者的。
	"apps/desktop/src/main/smoke-environment.ts",
	"apps/desktop/src/main/smoke-peers.ts",
	"apps/desktop/src/main/smoke-spawn-session.ts",
	// `/compact` 的冒烟按中文界面读压缩那一行，假模型的回复和断言是写给开发者的。
	"apps/desktop/src/main/smoke-compact.ts",
	// 使用统计的冒烟按中文界面找设置章节、读图例，假模型的回复和断言是写给开发者的。
	"apps/desktop/src/main/smoke-usage.ts",
	// 记忆文件的冒烟按中文界面找「记忆文件」、读文件面板，断言是写给开发者的。
	"apps/desktop/src/main/smoke-memory-files.ts",
	"apps/desktop/src/main/smoke-input-menu.ts",
	// 钩子插件的冒烟按中文界面读待审核提示、找按钮，假模型的回复和断言是写给开发者的。
	"apps/desktop/src/main/smoke-hooks.ts",
	// 撤回时退回文件的冒烟按中文界面找确认框的按钮、读问题标签，断言是写给开发者的。
	"apps/desktop/src/main/smoke-revert-files.ts",
	// 点开文件的冒烟按中文界面找右键菜单项、同名候选和出口条按钮，断言是写给开发者的。
	"apps/desktop/src/main/smoke-open-file.ts",
	"apps/desktop/src/main/smoke-kit.ts",
];

const PLUGIN_MESSAGES = /^packages\/builtin\/[^/]+\/src\/messages\.ts$/;

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		// 测试写给开发者看，不扫。
		if (["node_modules", "dist", "out", "test"].includes(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.tsx?$/.test(name)) out.push(path);
	}
	return out;
}

const list = process.argv.includes("--list");
const detail = {};
let total = 0;

for (const dir of SCANNED) {
	for (const path of walk(join(root, dir)).sort()) {
		const key = relative(root, path).replaceAll("\\", "/");
		if (EXEMPT.some((prefix) => key.startsWith(prefix)) || PLUGIN_MESSAGES.test(key)) continue;
		const found = chineseFindings(await readFile(path, "utf8"));
		if (found.length > 0) {
			detail[key] = found;
			total += found.length;
		}
	}
}

if (total > 0) {
	if (list) {
		for (const [file, found] of Object.entries(detail)) {
			console.log(`\n${file}  (${found.length})`);
			for (const one of found) console.log(`  ${String(one.line).padStart(4)}  ${one.text}`);
		}
	}
	console.error(
		`\n✖ 有 ${total} 处硬编码中文：\n${Object.entries(detail)
			.map(([file, found]) => `  ${file}: ${found.length}`)
			.join("\n")}\n\n` +
			"界面文案要走 i18n，放哪见 scripts/check-i18n.mjs 开头。标点也算：列表用 formatList，夹在变量两边的「：」「（）」写进词条模板。\n" +
			"看清单：node scripts/check-i18n.mjs --list\n",
	);
	process.exit(1);
}
console.log("✓ 没有硬编码中文");
