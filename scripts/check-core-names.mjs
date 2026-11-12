/**
 * 本体不按名字认具体插件，内置插件也不按名字认别的插件（`pnpm check:plugins` 的规则 4、5、6，由 scripts/check-plugins.mjs 调用）。
 * 规则和例外的来由见 spec/domain/plugin-primitives.md。
 *
 * 本体是 packages/core、packages/contract、packages/client、apps/desktop/src；测试和冒烟（`apps/desktop/src/main/smoke*`）不算，
 * 它们本来就要装上具体插件、点具体面板。只查代码，注释不算：注释里写「内置插件 plume.prompt 提供」是在说明契约由谁兑现，
 * 不会让本体的行为跟着某个插件走；连注释一起查的话，这类说明只能删掉或者登记一长串例外。
 *
 * 规则 4：代码里不出现插件名。名单是内置插件（packages/builtin/<目录>/src/index.ts 里的 `name`）加上 MARKET_PLUGINS，
 *   按整个名字比（以插件名打头的面板 id `plume.side-chat/chat` 也算）；`plume.sidebar`、`plume.panel-tabs` 这些
 *   localStorage 键不在名单里，`window.plume.*` 前面是点，都不受影响。
 * 规则 5：不按名字认插件的工具、提示词段和送达标签。名单是 BUILTIN_TOOLS、BUILTIN_MARKS、MARKET_TOOLS、MARKET_MARKS。
 *   带下划线或大写字母的名字（`todo_write`、`mcp__`、`projectMemory`）在字符串字面量里作为一个词出现就算（`"<subagent_result"` 也算）；
 *   全小写的单个词（`task`、`skill`、`monitor`）和日常用词撞得多，只在整个字面量就是它、而且在比较、`case`、
 *   `.has()` / `.includes()` / `.startsWith()` / `.endsWith()` 的参数或 `new Set([…])` 里时才算；字面量里用反引号括着的
 *   （提示词点名工具的写法，`` "派给 `task`" ``）也算。正则字面量不查。
 * 规则 6：内置插件不认别的插件。内置插件 A 的源码（packages/builtin/A/src，不含测试）按规则 4、5 的方式查，名单是别的内置插件的
 *   插件名、BUILTIN_TOOLS 和 BUILTIN_MARKS 里登记在别的目录名下的名字，加上市场插件的全部（内置插件不认识市场插件）；A 自己的不算。
 *   A 带给模型的技能（packages/builtin/A/skills 下的 .md）是写给模型的话，整篇当一个字面量查。
 *   要用别的插件的能力走服务、按声明（`ToolDefinition.category`、`PromptSection.category`、`details` 里 `@plume/contract` 定的形状）认。
 *
 * 名单怎么维护：
 * - 内置插件名从源码读，不用管。
 * - BUILTIN_TOOLS、BUILTIN_MARKS 按内置插件的目录登记它注册的工具（`ctx.tools.register` 的 `name`，是常量就写常量的值）
 *   和它自己定的段名、标签，新加、改名时同步；登记的名字在那个插件的 src 里找不到时报「名单过时」。
 *   段名只登记不会和日常用词撞的（`identity`、`skills` 这类不查）。
 * - MARKET_PLUGINS、MARKET_TOOLS、MARKET_MARKS 抄自插件仓库 plume-plugins 的 `plugins/*`（这个仓库不读插件仓库），那边加插件、
 *   加工具时补上。
 * - 现有的正当命中登记在 ALLOWED，每条写明理由；登记了却已经不命中的报「例外过时」。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 本体的目录（相对仓库根）。 */
const CORE_DIRS = ["packages/core", "packages/contract", "packages/client", "apps/desktop/src"];

/** 内置插件目录 → 它注册的工具。`mcp__` 是 plume.mcp 登记 MCP 工具时的名字前缀。 */
const BUILTIN_TOOLS = {
	"ask-user": ["ask_user"],
	browser: ["browser_open", "browser_act", "browser_tabs", "browser_screenshot", "browser_viewport"],
	compaction: ["recall"],
	mcp: ["mcp_search", "mcp_call", "mcp__"],
	plan: ["submit_plan"],
	"side-chat": ["read_main_chat", "dispatch_task", "control_main"],
	skills: ["skill"],
	"spawn-session": ["spawn_session", "archive_session"],
	subagents: ["task", "stop_subagent", "yield"],
	todo: ["todo_write"],
	tools: ["read", "write", "edit", "ls", "glob", "grep", "bash", "bash_output", "monitor", "schedule_wakeup", "cron_create", "cron_list", "cron_delete"],
	web: ["web_search", "web_fetch"],
};

/** 内置插件目录 → 它自己定的提示词段名、送达标签。 */
const BUILTIN_MARKS = {
	mcp: ["mcpDeferred"],
	prompt: ["userInstructions", "projectInstructions"],
	"spawn-session": ["session_result"],
	subagents: ["subagent_result"],
	tools: ["background_job", "monitor_events"],
};

/** 插件仓库 plume-plugins 里的市场插件。 */
const MARKET_PLUGINS = [
	"plume.followups",
	"plume.hooks",
	"plume.im",
	"plume.image",
	"plume.index",
	"plume.lsp",
	"plume.memory",
	"plume.native-ui",
	"plume.preview",
	"plume.pull-requests",
	"plume.review",
	"plume.scheduled",
	"plume.screenshot",
	"plume.sessions",
	"plume.skin-studio",
	"plume.ssh",
	"plume.summary",
	"plume.terminal",
	"plume.usage",
	"plume.welcome",
];

/** 市场插件注册的工具。 */
const MARKET_TOOLS = [
	"image_generate",
	"symbol",
	"lsp",
	"learn",
	"ui_help",
	"preview",
	"read_pull_request",
	"review_session",
	"list_sessions",
	"read_session",
	"ask_session",
	"reply_session",
	"notify_session",
	"skin_studio_theme",
	"ssh_run",
	"ssh_sessions",
];

/** 市场插件自己定的提示词段名（plume.memory）。 */
const MARKET_MARKS = ["userMemory", "projectMemory"];

/** 正当的命中：文件（相对仓库根）+ 名字，写明为什么不算认插件。 */
const ALLOWED = [
	{
		file: "apps/desktop/src/renderer/market/card.tsx",
		name: "skill",
		reason: "插件包的种类（PluginKind，package.json 的 plume.kind），和技能插件的工具 skill 同字，不是在认工具",
	},
	{
		file: "apps/desktop/src/renderer/market/detail.tsx",
		name: "skill",
		reason: "同上：插件市场按插件包的种类分页",
	},
	{
		file: "packages/core/agent/src/agent.ts",
		name: "read",
		reason: "会话互发的信的下落（LetterFate.status：对方读到了），和读文件的工具同字",
	},
	{
		file: "apps/desktop/src/main/security-policy.ts",
		name: "bash",
		reason: "打开文件时当成可执行脚本的扩展名（.bash），不是工具",
	},
	{
		file: "apps/desktop/src/renderer/conversation/shell-reads.ts",
		name: "ls",
		reason: "shell 命令里只读的程序名（判断一条命令是不是只在读），不是工具",
	},
	{
		file: "apps/desktop/src/renderer/conversation/shell-reads.ts",
		name: "grep",
		reason: "同上：shell 程序名和 git 的只读子命令",
	},
	{
		file: "apps/desktop/src/renderer/markdown/shell-command.ts",
		name: "bash",
		reason: "Markdown 代码块的语言标签（```bash），不是工具",
	},
	{
		file: "apps/desktop/src/renderer/sidebar/ProjectDialog.tsx",
		name: "edit",
		reason: "项目菜单里的模式（编辑项目），不是工具",
	},
	{
		file: "packages/builtin/approval/src/risk-tables.ts",
		name: "bash",
		reason: "shell 程序名（`bash -c …`、`curl … | bash` 里的那个程序），不是工具",
	},
	{
		file: "packages/core/sandbox/src/login-path.ts",
		name: "bash",
		reason: "同上：问 PATH 时起的登录 shell 的程序名",
	},
	{
		file: "packages/builtin/browser/src/tools.ts",
		name: "read",
		reason: 'browser_act 自己的动作（action: "read" 读当前页），和读文件的工具同字',
	},
	{
		file: "packages/builtin/browser/skills/browser/SKILL.md",
		name: "read",
		reason: "同上：技能里说的是 browser_act 的 read 动作",
	},
];

/** 内置插件目录：带给模型的技能在这下面（`skills/<名字>/SKILL.md`），规则 6 也查。 */
const BUILTIN_SKILLS = "skills";
/** `pnpm build:plugins` 把仓库根的 skills/plume-plugin 拷到这里随应用发，见 scripts/build-plugins.mjs。 */
const GENERATED_SKILL = "packages/builtin/skills/skills/plume-plugin/";

/** 把注释换成空白，行号不变。行注释只认行首或空白后的 `//`，字符串里的 URL 不受影响。 */
function blankComments(text) {
	return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " ")).replace(/(^|\s)\/\/.*$/gm, "$1");
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 带下划线或大写字母的名字不会和日常用词撞。 */
const distinctive = (name) => /[_A-Z]/.test(name);
/** 字符串字面量（单引号、双引号、模板；不跨行）。 */
const LITERAL = /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
/** 前面是比较、`case`、集合查询的调用时，全小写的单个词才算。 */
const COMPARED_BEFORE = /(?:[!=]==?|\bcase|\.(?:has|includes|startsWith|endsWith)\()\s*$/;
const COMPARED_AFTER = /^\s*[!=]==?/;
/** 字面量里用反引号括着的名字：提示词点名工具的写法。模板字符串里的反引号带着转义。 */
const quoted = (name) => new RegExp(`\\\\?\`${escape(name)}\\\\?\``);

/**
 * 一段源码里认插件的地方：`{ line, kind: "plugin" | "name", name }`。
 * @param {string} text 源码
 * @param {{ plugins: Set<string>, names: Set<string> }} lists 插件名；工具名、段名、标签
 */
export function scanCode(text, { plugins, names }) {
	const code = blankComments(text);
	const lineOf = (index) => code.slice(0, index).split("\n").length;
	const hits = [];
	for (const match of code.matchAll(/(?<![\w$.])plume\.[a-z0-9][a-z0-9.-]*/g)) {
		const name = match[0].replace(/[.-]+$/, "");
		if (plugins.has(name)) hits.push({ line: lineOf(match.index), kind: "plugin", name });
	}
	// 结尾是下划线的是前缀（`mcp__`），后面接着字母也算。
	const words = [...names]
		.filter(distinctive)
		.map((name) => ({ name, pattern: new RegExp(`(?<![\\w$])${escape(name)}${name.endsWith("_") ? "" : "(?![\\w$])"}`) }));
	const lowercase = [...names].filter((name) => !distinctive(name));
	const sets = [...code.matchAll(/new\s+Set\s*\(\s*\[[^\]]*\]/g)].map((match) => [match.index, match.index + match[0].length]);
	for (const match of code.matchAll(LITERAL)) {
		const content = match[2];
		const start = match.index;
		const end = start + match[0].length;
		for (const { name } of words.filter(({ pattern }) => pattern.test(content))) hits.push({ line: lineOf(start), kind: "name", name });
		for (const name of lowercase.filter((name) => quoted(name).test(content))) hits.push({ line: lineOf(start), kind: "name", name });
		if (!names.has(content) || distinctive(content)) continue;
		const compared =
			COMPARED_BEFORE.test(code.slice(Math.max(0, start - 24), start)) ||
			COMPARED_AFTER.test(code.slice(end, end + 6)) ||
			sets.some(([from, to]) => start > from && end <= to);
		if (compared) hits.push({ line: lineOf(start), kind: "name", name: content });
	}
	return hits;
}

/**
 * 一篇写给模型的文字（技能的 SKILL.md）里认插件的地方：插件名、带下划线或大写字母的名字出现就算，全小写的单个词在反引号里才算。
 * @param {string} text 正文
 * @param {{ plugins: Set<string>, names: Set<string> }} lists 同 `scanCode`
 */
export function scanText(text, { plugins, names }) {
	const lineOf = (index) => text.slice(0, index).split("\n").length;
	const hits = [];
	for (const match of text.matchAll(/(?<![\w$.])plume\.[a-z0-9][a-z0-9.-]*/g)) {
		const name = match[0].replace(/[.-]+$/, "");
		if (plugins.has(name)) hits.push({ line: lineOf(match.index), kind: "plugin", name });
	}
	for (const name of names) {
		const pattern = distinctive(name)
			? new RegExp(`(?<![\\w$])${escape(name)}${name.endsWith("_") ? "" : "(?![\\w$])"}`, "g")
			: new RegExp(`\`${escape(name)}\``, "g");
		for (const match of text.matchAll(pattern)) hits.push({ line: lineOf(match.index), kind: "name", name });
	}
	return hits;
}

function sourceFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (["node_modules", "dist", "test", "tests"].includes(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sourceFiles(path, out);
		else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name) && !name.startsWith("smoke")) out.push(path);
	}
	return out;
}

function textFiles(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) textFiles(path, out);
		else if (name.endsWith(".md")) out.push(path);
	}
	return out;
}

/** 本体和内置插件里认插件的地方，和名单本身的问题：`{ file, message }`，file 是绝对路径。 */
export function nameProblems(root) {
	const problems = [];
	const self = join(root, "scripts/check-core-names.mjs");
	const builtinDir = join(root, "packages/builtin");
	/** 内置插件目录 → 插件名。 */
	const builtins = new Map();
	for (const dir of readdirSync(builtinDir)) {
		if (!existsSync(join(builtinDir, dir, "package.json"))) continue;
		const entry = join(builtinDir, dir, "src/index.ts");
		const name = existsSync(entry) ? readFileSync(entry, "utf8").match(/\bname:\s*"(plume\.[a-z0-9.-]+)"/)?.[1] : undefined;
		if (name) builtins.set(dir, name);
		else problems.push({ file: entry, message: '读不出内置插件的名字（找 `name: "plume.…"`），规则 4、6 会漏掉它' });
	}
	for (const listed of [BUILTIN_TOOLS, BUILTIN_MARKS]) {
		for (const [dir, names] of Object.entries(listed)) {
			const source = sourceFiles(join(builtinDir, dir, "src"))
				.map((file) => readFileSync(file, "utf8"))
				.join("\n");
			for (const name of names) if (!source.includes(name)) problems.push({ file: self, message: `名单过时：packages/builtin/${dir}/src 里找不到 ${name}` });
		}
	}
	const used = new Set();
	const check = (file, hits, explain) => {
		const path = relative(root, file);
		for (const hit of hits) {
			const allowed = ALLOWED.findIndex((entry) => entry.file === path && entry.name === hit.name);
			if (allowed >= 0) {
				used.add(allowed);
				continue;
			}
			problems.push({ file, message: explain(hit) });
		}
	};

	// 规则 4、5：本体。
	const all = {
		plugins: new Set([...builtins.values(), ...MARKET_PLUGINS]),
		names: new Set([...Object.values(BUILTIN_TOOLS).flat(), ...Object.values(BUILTIN_MARKS).flat(), ...MARKET_TOOLS, ...MARKET_MARKS]),
	};
	for (const dir of CORE_DIRS) {
		for (const file of sourceFiles(join(root, dir))) {
			check(file, scanCode(readFileSync(file, "utf8"), all), (hit) =>
				hit.kind === "plugin"
					? `第 ${hit.line} 行认了插件 ${hit.name}：本体按插件的声明和接口的形状办事，不认插件名`
					: `第 ${hit.line} 行按名字认了插件的 ${hit.name}：让插件经声明告诉本体（ToolDefinition 的 describe、category，段的 category，ui.toolLine，details 的通用形状）`,
			);
		}
	}

	// 规则 6：内置插件不认别的插件，自己的不算。
	for (const [dir, own] of builtins) {
		const others = {
			plugins: new Set([...[...builtins.values()].filter((name) => name !== own), ...MARKET_PLUGINS]),
			names: new Set([
				...Object.entries(BUILTIN_TOOLS).flatMap(([other, names]) => (other === dir ? [] : names)),
				...Object.entries(BUILTIN_MARKS).flatMap(([other, names]) => (other === dir ? [] : names)),
				...MARKET_TOOLS,
				...MARKET_MARKS,
			]),
		};
		const explain = (hit) =>
			hit.kind === "plugin"
				? `第 ${hit.line} 行认了插件 ${hit.name}：内置插件不按名字找别的插件，要用它的能力走服务（ctx.provide / inject）`
				: `第 ${hit.line} 行按名字认了别的插件的 ${hit.name}：按声明认（ToolDefinition.category、PromptSection.category、details 的通用形状），提示词里要点名工具就按类别在工具表里找它叫什么`;
		for (const file of sourceFiles(join(builtinDir, dir, "src"))) check(file, scanCode(readFileSync(file, "utf8"), others), explain);
		for (const file of textFiles(join(builtinDir, dir, BUILTIN_SKILLS))) {
			// 构建时拷进来的那份写插件的 skill（scripts/build-plugins.mjs，不进仓库）是给插件作者看的文档，本来就要点名各个插件，不查。
			if (file.split(sep).join("/").includes(GENERATED_SKILL)) continue;
			check(file, scanText(readFileSync(file, "utf8"), others), explain);
		}
	}

	ALLOWED.forEach((entry, index) => {
		if (!used.has(index))
			problems.push({ file: join(root, entry.file), message: `例外过时：已经不再命中 ${entry.name}，从 scripts/check-core-names.mjs 的 ALLOWED 删掉` });
	});
	return problems;
}
