/**
 * 硬编码中文检查（`pnpm check` 的一部分）：界面上给人读的文字要走 i18n，不能直接写在代码里。
 *
 * 算一条的：字符串字面量或 JSX 文本里有汉字或中文标点。不算的：注释（注释本来就用中文写）、
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
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { MARKET_DIR } from "./market.mjs";

const root = resolve(import.meta.dirname, "..");

/** 扫描的目录：所有会把文字放到人眼前的代码。市场插件在旁边的插件仓库里（scripts/market.mjs），没放在旁边时跳过。 */
const SCANNED = ["apps/desktop/src", "packages/client", "packages/core/agent/src", "packages/builtin", MARKET_DIR].filter((dir) => existsSync(join(root, dir)));

/**
 * 内容本身就是中文的文件。
 *
 * - 文案目录：本来就该写成多种语言。
 * - locales.ts：语言选项用它自己的文字写自己的名字（「中」「简体中文」），翻译了反而读不懂。
 * - smoke.ts：冒烟按默认的中文界面找按钮、读文字，它的断言信息是写给开发者的。
 * - 内置插件 plume.tools 的工具表（tools.ts）：工具的说明和结果都是发给模型的，是提示词的一部分，不随界面语言变。
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
	// SSH 冒烟只连本机假服务，中文选择器、假模型回答和断言不属于产品文案。
	"apps/desktop/src/main/smoke-ssh.ts",
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
	"packages/builtin/tools/src/tools.ts",
];

const PLUGIN_MESSAGES = /^(\.\.\/plume-plugins\/plugins|packages\/builtin)\/[^/]+\/src\/messages\.ts$/;

/** 汉字，和中文句子用的标点（分隔、括号、句读；不是全部全角字符）。 */
const CHINESE = /[一-鿿、，：；（）「」『』。！？]/;

/**
 * 去掉注释，换行保留（块注释里的也一个换一个），行号才对得上，`i18n-exempt` 也按行认。
 * 认得字符串：示例 URL 里的 `//` 不是注释，当成注释会把那一行后面的文字都跳过去。
 * 模板字符串会嵌套，`${…}` 里又可以有字符串和注释，所以用一个栈。
 */
function stripComments(src) {
	let out = "";
	const stack = [];
	const inside = () => stack[stack.length - 1];

	for (let i = 0; i < src.length;) {
		const char = src[i];
		const two = src.slice(i, i + 2);
		const state = inside();

		if (state === "'" || state === '"' || state === "`") {
			if (char === "\\") {
				out += two;
				i += 2;
				continue;
			}
			if (char === state) stack.pop();
			else if (state === "`" && two === "${") {
				stack.push("{");
				out += two;
				i += 2;
				continue;
			}
			out += char;
			i += 1;
			continue;
		}

		// 代码，或者 `${…}` 里面：这里的注释都是注释。
		if (two === "//") {
			// 停在换行前，让循环自己把换行抄过去；这里再补一个，后面的行号都会错一行。
			const end = src.indexOf("\n", i);
			i = end === -1 ? src.length : end;
			continue;
		}
		if (two === "/*") {
			const end = src.indexOf("*/", i + 2);
			const body = src.slice(i, end === -1 ? src.length : end + 2);
			i = end === -1 ? src.length : end + 2;
			out += body.replace(/[^\n]/g, "");
			continue;
		}
		if (char === "'" || char === '"' || char === "`") stack.push(char);
		else if (char === "{") stack.push("{");
		else if (char === "}" && state === "{") stack.pop();
		out += char;
		i += 1;
	}
	return out;
}

/** 只进日志的调用：`console.*`，和 Plume 自己的日志函数（`log(…)`、`this.options.log(…)`、`ctx.log.warn(…)`）。 */
const LOG_CALL = /\b(?:console\s*\.\s*(?:log|info|warn|error|debug|trace)|(?:\w+\s*\.\s*)*log(?:\s*\.\s*(?:info|warn|error))?)\s*\(/g;

/**
 * 把日志调用的参数整段抹掉（换行保留）：只进日志的不算。
 * 找调用时先把字符串内容遮住，字符串里恰好有 `console.log(` 不会被当成调用，日志字符串里的括号也不会提前结束它。
 */
function stripLogs(stripped) {
	const masked = stripped.replace(
		/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
		(literal) => literal[0] + literal.slice(1, -1).replace(/[^\n]/g, " ") + literal.at(-1),
	);
	let out = stripped;
	for (const call of masked.matchAll(LOG_CALL)) {
		const open = call.index + call[0].length - 1;
		let close = masked.length;
		for (let i = open, depth = 0; i < masked.length; i++) {
			if (masked[i] === "(") depth += 1;
			else if (masked[i] === ")" && --depth === 0) {
				close = i;
				break;
			}
		}
		out = out.slice(0, open + 1) + out.slice(open + 1, close).replace(/[^\n]/g, " ") + out.slice(close);
	}
	return out;
}

/**
 * `i18n-exempt` 注释管到的行：从下一行到第一个空行。
 *
 * 给有这样一种字留的：人读不到、也不能跟着语言变的固定字符串（发给模型的提示词、和存量数据比对的词）。
 * 整个文件豁免太宽（同一个文件里往往还有真正的界面文案），所以豁免写在它管的那几行上面，原因写在注释里。
 * 一条注释管到空行为止，一张表只要写一次。
 */
function exemptLines(source) {
	const lines = source.split("\n");
	const exempt = new Set();
	for (let i = 0; i < lines.length; i++) {
		if (!/i18n-exempt\b/.test(lines[i])) continue;
		for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) exempt.add(j + 1);
	}
	return exempt;
}

/**
 * 一个文件里所有给人读的中文，`{ line, text }`。
 *
 * 先认字符串字面量，再把它们的内容遮住：剩下还有中文的，只能是 JSX 文本（`.tsx` 里标签之间的字，
 * 包括写在 `{cond && <p>…</p>}` 这种表达式里的）。不去配对标签和花括号：配对的写法会被箭头函数的 `>`
 * 和表达式里的 `n > 1` 带偏，整段跳过真正的文字。
 */
export function findings(source) {
	const stripped = stripLogs(stripComments(source));
	const spared = exemptLines(source);
	const found = [];
	const at = (index) => stripped.slice(0, index).split("\n").length;
	const keep = (line, text) => {
		if (!spared.has(line)) found.push({ line, text });
	};
	// 认得转义，`"他说 \"好\""` 是一条，不是两条。
	const literal = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
	for (const match of stripped.matchAll(literal)) {
		if (CHINESE.test(match[0])) keep(at(match.index), match[0].trim().slice(0, 80));
	}
	const masked = stripped.replace(literal, (text) => text.replace(/[^\n]/g, " "));
	masked.split("\n").forEach((line, index) => {
		// 字符串已经遮住，剩下的 `//` 是注释（正则字面量里的引号可能让前面没认出它）。
		const code = line.replace(/\/\/.*$/, "");
		if (CHINESE.test(code)) keep(index + 1, code.trim().replace(/\s+/g, " ").slice(0, 80));
	});
	return found;
}

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
		const found = findings(await readFile(path, "utf8"));
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
