/**
 * 回复里代码块的语法配色。
 *
 * 不为每个代码块起一个 CodeMirror 编辑器：一段转录里几十个片段，每个都带一个 view、一棵 DOM 和自己的事件，
 * 而这些字没人会去改。用同一套语法解析、遍历语法树切出带类名的片段，配色一样，代价小得多。
 */

import { HighlightStyle, type Language, StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { type Tree, TreeFragment } from "@lezer/common";
import { highlightTree, tags as t } from "@lezer/highlight";

/** 配色只取 `--plume-syntax-*`：深浅色和皮肤由 token 自己切，样式只生成一次。 */
const c = (name: string) => `var(--plume-syntax-${name})`;

function highlightStyle(): HighlightStyle {
	return HighlightStyle.define([
		{ tag: [t.keyword, t.modifier, t.controlKeyword], color: c("keyword") },
		{ tag: [t.definitionKeyword, t.moduleKeyword], color: c("keyword") },
		{ tag: [t.string, t.special(t.string)], color: c("string") },
		{ tag: [t.number, t.bool, t.null, t.atom], color: c("number") },
		{ tag: [t.comment, t.blockComment, t.lineComment], color: c("comment"), fontStyle: "italic" },
		{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: c("function") },
		/*
		 * 键就是键，不管语法怎么叫它。
		 *
		 * JSON 把键标成 `propertyName`，YAML 和 JavaScript 的对象字面量标成 `definition(propertyName)`。
		 * 后者要是跟着 `definition(variableName)` 走成正文色，一个 YAML 文件就是一面平墙：键和值一样重，
		 * 只有带引号的字符串有颜色。
		 */
		{ tag: [t.definition(t.propertyName)], color: c("function") },
		/*
		 * 正在被定义的名字上色，被使用的不上。
		 *
		 * `func Greet(...)`、`const answer = 42` 里最有信息量的就是这一行要引入的那个词；普通代码里大多数
		 * 标识符都出现在定义处，它们是正文色的话，深色主题下看上去就是白字偶尔点缀几处颜色。
		 */
		{ tag: [t.definition(t.variableName)], color: c("function") },
		/*
		 * 不带引号的标量，YAML 右边大多是它。
		 *
		 * 语法分不清 `true`、`1.2.3` 和一个裸词——都是 `Literal`——所以没法像有类型的语言那样分成布尔和数字。
		 * 照实画：键带颜色，值是正文。
		 */
		{ tag: [t.content], color: c("variable") },
		// 锚点和别名（&name、*name）是引用，和其他标签一样读。
		{ tag: [t.labelName], color: c("keyword") },
		{ tag: [t.typeName, t.className, t.namespace, t.constant(t.variableName), t.standard(t.variableName), t.special(t.variableName)], color: c("type") },
		{ tag: [t.propertyName], color: c("function") },
		{ tag: [t.variableName], color: c("variable") },
		{ tag: [t.operator], color: c("operator") },
		{ tag: [t.punctuation, t.separator, t.bracket], color: c("punctuation") },
		{ tag: [t.tagName], color: c("tag") },
		{ tag: [t.attributeName], color: c("attribute") },
		// properties、ini 模式把值标成 `quote`；不映射的话配置文件只有键有颜色。
		{ tag: [t.attributeValue, t.quote], color: c("string") },
		{ tag: [t.heading], color: c("function"), fontWeight: "600" },
		{ tag: [t.link, t.url], color: c("function"), textDecoration: "underline" },
		{ tag: [t.emphasis], fontStyle: "italic" },
		{ tag: [t.strong], fontWeight: "600" },
		{ tag: [t.strikethrough], textDecoration: "line-through" },
		{ tag: [t.meta, t.processingInstruction], color: c("comment") },
		{ tag: [t.invalid], color: c("tag") },
		{ tag: [t.escape, t.regexp], color: c("attribute") },
		// 补丁：没有这两条整段一个颜色。借现有的两档，不另设 token。
		{ tag: [t.inserted], color: c("string") },
		{ tag: [t.deleted], color: c("number") },
	]);
}

/** 各语言的语法，按扩展名作键，用到才加载：一段只出现 TypeScript 的转录不该为 Python 和 SQL 的解析器买单。 */
const GRAMMARS: Record<string, () => Promise<Extension>> = {
	ts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
	mts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
	cts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
	tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
	js: async () => (await import("@codemirror/lang-javascript")).javascript(),
	mjs: async () => (await import("@codemirror/lang-javascript")).javascript(),
	cjs: async () => (await import("@codemirror/lang-javascript")).javascript(),
	jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
	json: async () => (await import("@codemirror/lang-json")).json(),
	/*
	 * 用旧模式而不是 `lang-json`，因为它认得注释。
	 *
	 * `.jsonc` 和 `.json` 只差这一点，用严格语法解析的话每一行 `//` 都成了正文——这个格式存在的理由反而看不见。
	 * 代价是键画成字符串色而不是自己的颜色，小得多。
	 */
	jsonc: async () => {
		const { json } = await import("@codemirror/legacy-modes/mode/javascript");
		return StreamLanguage.define(json);
	},
	md: async () => (await import("@codemirror/lang-markdown")).markdown(),
	mdx: async () => (await import("@codemirror/lang-markdown")).markdown(),
	css: async () => (await import("@codemirror/lang-css")).css(),
	scss: async () => (await import("@codemirror/lang-css")).css(),
	less: async () => (await import("@codemirror/lang-css")).css(),
	html: async () => (await import("@codemirror/lang-html")).html(),
	htm: async () => (await import("@codemirror/lang-html")).html(),
	vue: async () => vueSupport(),
	// Svelte 的块和 Vue 一个形状（`<style lang="scss">`、`<script lang="ts">`），套同一套嵌套；它自己的模板语法不覆盖。
	svelte: async () => vueSupport(),
	xml: async () => (await import("@codemirror/lang-xml")).xml(),
	svg: async () => (await import("@codemirror/lang-xml")).xml(),
	py: async () => (await import("@codemirror/lang-python")).python(),
	rs: async () => (await import("@codemirror/lang-rust")).rust(),
	go: async () => (await import("@codemirror/lang-go")).go(),
	java: async () => (await import("@codemirror/lang-java")).java(),
	kt: async () => (await import("@codemirror/lang-java")).java(),
	c: async () => (await import("@codemirror/lang-cpp")).cpp(),
	h: async () => (await import("@codemirror/lang-cpp")).cpp(),
	cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
	hpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
	cc: async () => (await import("@codemirror/lang-cpp")).cpp(),
	sql: async () => (await import("@codemirror/lang-sql")).sql(),
	yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
	yml: async () => (await import("@codemirror/lang-yaml")).yaml(),

	/*
	 * 下面都是 `@codemirror/legacy-modes` 的 `StreamLanguage`。
	 *
	 * 这些是按行的格式，没有树形语法，而一个项目的配置大多就是用它们写的：shell 脚本、Dockerfile、`.toml`、`.env`。
	 * 不上色的话，一个通篇是键、值和注释的文件，注释读起来不像注释。
	 */
	sh: async () => stream(shellWithOperators((await import("@codemirror/legacy-modes/mode/shell")).shell)),
	bash: async () => stream(shellWithOperators((await import("@codemirror/legacy-modes/mode/shell")).shell)),
	zsh: async () => stream(shellWithOperators((await import("@codemirror/legacy-modes/mode/shell")).shell)),
	fish: async () => stream(shellWithOperators((await import("@codemirror/legacy-modes/mode/shell")).shell)),
	toml: async () => stream((await import("@codemirror/legacy-modes/mode/toml")).toml),
	dockerfile: async () => stream((await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
	ini: async () => stream((await import("@codemirror/legacy-modes/mode/properties")).properties),
	ruby: async () => stream((await import("@codemirror/legacy-modes/mode/ruby")).ruby),
	perl: async () => stream((await import("@codemirror/legacy-modes/mode/perl")).perl),
	haskell: async () => stream((await import("@codemirror/legacy-modes/mode/haskell")).haskell),
	clojure: async () => stream((await import("@codemirror/legacy-modes/mode/clojure")).clojure),
	powershell: async () => stream((await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
	protobuf: async () => stream((await import("@codemirror/legacy-modes/mode/protobuf")).protobuf),
	cfg: async () => stream((await import("@codemirror/legacy-modes/mode/properties")).properties),
	conf: async () => stream((await import("@codemirror/legacy-modes/mode/properties")).properties),
	properties: async () => stream((await import("@codemirror/legacy-modes/mode/properties")).properties),
	// 自己的语法而不是 properties：properties 把 `KEY=value` 两半都标成定义，名字和值一个颜色。见 `dotenv-mode.ts`。
	env: async () => (await import("./dotenv-mode.ts")).dotenvLanguage,
	diff: async () => stream((await import("@codemirror/legacy-modes/mode/diff")).diff),
	patch: async () => stream((await import("@codemirror/legacy-modes/mode/diff")).diff),
	lua: async () => stream((await import("@codemirror/legacy-modes/mode/lua")).lua),
	rb: async () => stream((await import("@codemirror/legacy-modes/mode/ruby")).ruby),
	swift: async () => stream((await import("@codemirror/legacy-modes/mode/swift")).swift),
	ps1: async () => stream((await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
	psm1: async () => stream((await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
	pl: async () => stream((await import("@codemirror/legacy-modes/mode/perl")).perl),
	r: async () => stream((await import("@codemirror/legacy-modes/mode/r")).r),
	jl: async () => stream((await import("@codemirror/legacy-modes/mode/julia")).julia),
	hs: async () => stream((await import("@codemirror/legacy-modes/mode/haskell")).haskell),
	clj: async () => stream((await import("@codemirror/legacy-modes/mode/clojure")).clojure),
	/*
	 * 用 Ruby 的语法而不是 Erlang 的，虽然它们共用一个运行时。
	 *
	 * Elixir 的表面语法几乎全来自 Ruby：`#` 注释、`def ... do ... end`、`@attributes`、`#{}` 插值；Erlang 用 `%`
	 * 注释、句号收尾。按 Erlang 解析的话，Elixir 文件里的每条注释都画成了代码。
	 */
	ex: async () => stream((await import("@codemirror/legacy-modes/mode/ruby")).ruby),
	erl: async () => stream((await import("@codemirror/legacy-modes/mode/erlang")).erlang),
	scala: async () => stream((await import("@codemirror/legacy-modes/mode/clike")).scala),
	cs: async () => stream((await import("@codemirror/legacy-modes/mode/clike")).csharp),
	m: async () => stream((await import("@codemirror/legacy-modes/mode/clike")).objectiveC),
	dart: async () => stream((await import("@codemirror/legacy-modes/mode/clike")).dart),
	groovy: async () => stream((await import("@codemirror/legacy-modes/mode/groovy")).groovy),
	proto: async () => stream((await import("@codemirror/legacy-modes/mode/protobuf")).protobuf),
	nginx: async () => stream((await import("@codemirror/legacy-modes/mode/nginx")).nginx),
	cmake: async () => stream((await import("@codemirror/legacy-modes/mode/cmake")).cmake),
	php: async () => (await import("@codemirror/lang-php")).php(),
	graphql: async () => (await import("./graphql-mode.ts")).graphqlLanguage,
	tex: async () => stream((await import("@codemirror/legacy-modes/mode/stex")).stex),
	gitignore: async () => (await import("./ignore-mode.ts")).ignoreLanguage,
};

function stream(mode: Parameters<typeof StreamLanguage.define>[0]): Extension {
	return StreamLanguage.define(mode);
}

/**
 * 一段里除了这些什么都没有，那它就是个操作符。
 *
 * 管道、逻辑连接、重定向、分组、条件括号。它们在 shell 里是结构，不是标点：`a | b` 和 `a > b` 是两件完全
 * 不同的事，区别全落在那一个字符上。
 */
const SHELL_OPERATOR = /^[|&;<>()[\]]+$/;

/**
 * shell 的结构符号，legacy 语法自己不标。
 *
 * legacy 的 shell 模式认得命令、参数、变量、字符串、关键字和注释，但对 `|`、`&&`、`>`、`[[` 一律返回 null——
 * 一条 `grep … | awk … && rm …` 在语义最重的几处反而没有颜色。
 *
 * 补在原模式**之后**：只有原模式明确不认的一段才接手，字符串里的 `|`、注释里的 `>` 早被标成 string 和 comment，
 * 碰不到。整段必须全是操作符字符才算：`>&2` 切成 `>` 和 `&2`，后者不上色——宁可少标一个，也不把普通文字误判成结构。
 */
function shellWithOperators(mode: Parameters<typeof StreamLanguage.define>[0]): Parameters<typeof StreamLanguage.define>[0] {
	return {
		...mode,
		token(input, state) {
			const named = mode.token(input, state);
			if (named) return named;
			return SHELL_OPERATOR.test(input.current()) ? "operator" : named;
		},
	};
}

/**
 * 单文件组件，连同它各个块里真正用的语言。
 *
 * 只用 `html()` 的话外层标签有颜色，中间几百行没有：HTML 只认 `<script>` 是 JavaScript、`<style>` 是 CSS，而 Vue
 * 文件里常见的是 `<style lang="scss">` 和 `<script setup lang="ts">`。所以把嵌套写明，由 `lang` 属性决定——SCSS
 * 当 CSS 解析会在第一个 `$变量` 处停下，配错比不配更糟。
 *
 * 只建一次、共用：每个解析器都拉自己的语法模块，四个块的文件不该加载四份。
 */
let vueCache: Promise<Extension> | null = null;
function vueSupport(): Promise<Extension> {
	vueCache ??= (async () => {
		const [{ html }, { vue }, { sass }, { less }, { css }, { javascript }] = await Promise.all([
			import("@codemirror/lang-html"),
			import("@codemirror/lang-vue"),
			import("@codemirror/lang-sass"),
			import("@codemirror/lang-less"),
			import("@codemirror/lang-css"),
			import("@codemirror/lang-javascript"),
		]);

		const styleBlocks = [
			{ tag: "style", attrs: (a: Record<string, string>) => a.lang === "scss", parser: sass().language.parser },
			{ tag: "style", attrs: (a: Record<string, string>) => a.lang === "sass", parser: sass({ indented: true }).language.parser },
			{ tag: "style", attrs: (a: Record<string, string>) => a.lang === "less", parser: less().language.parser },
			// 没写 `lang`：CSS 是默认，也是最稳的猜测。
			{ tag: "style", attrs: (a: Record<string, string>) => !a.lang, parser: css().language.parser },
		];

		const scriptBlocks = [
			{
				tag: "script",
				attrs: (a: Record<string, string>) => a.lang === "ts" || a.lang === "typescript",
				parser: javascript({ typescript: true }).language.parser,
			},
			{
				tag: "script",
				attrs: (a: Record<string, string>) => a.lang === "tsx",
				parser: javascript({ typescript: true, jsx: true }).language.parser,
			},
		];

		const base = html({ nestedLanguages: [...styleBlocks, ...scriptBlocks], autoCloseTags: false });
		// 模板部分（指令、插值、简写）用 Vue 自己的语法，叠在这层之上。
		return vue({ base });
	})();
	return vueCache;
}

/**
 * 名字本身就是类型的文件。
 *
 * `Dockerfile` 没有扩展名，`.gitignore` 整个是扩展名，`CMakeLists.txt` 自称 `.txt` 其实不是——所以先查这张表再看扩展名。
 */
const BY_FILENAME: Record<string, string> = {
	dockerfile: "dockerfile",
	containerfile: "dockerfile",
	makefile: "sh",
	gnumakefile: "sh",
	"cmakelists.txt": "cmake",
	".gitignore": "gitignore",
	".dockerignore": "gitignore",
	".npmignore": "gitignore",
	".eslintignore": "gitignore",
	".prettierignore": "gitignore",
	".vercelignore": "gitignore",
	".gitattributes": "gitignore",
	".env": "env",
	".editorconfig": "ini",
	".babelrc": "json",
	".prettierrc": "json",
	".eslintrc": "json",
	".npmrc": "ini",
	".nvmrc": "properties",
	"nginx.conf": "nginx",
	// Go 自己的清单，既不是 TOML 也不是纯文本。
	"go.mod": "properties",
	"go.sum": "properties",
	// Ruby 靠约定而不是扩展名。
	gemfile: "ruby",
	rakefile: "ruby",
	podfile: "ruby",
	guardfile: "ruby",
	// shell 的启动文件，常打开，又没有扩展名可看。
	".bashrc": "sh",
	".bash_profile": "sh",
	".zshrc": "sh",
	".zprofile": "sh",
	".profile": "sh",
	".zshenv": "sh",
	".eslintrc.json": "json",
	".babelrc.json": "json",
	".stylelintrc": "json",
	".swcrc": "json",
	".yarnrc": "properties",
	"jsconfig.json": "json",
	"pnpm-workspace.yaml": "yaml",
	"docker-compose.yml": "yaml",
	"docker-compose.yaml": "yaml",
	procfile: "properties",
};

/**
 * 按名字前缀定语法的文件。
 *
 * `.env.local`、`Dockerfile.dev`：同一种文件后面加个限定词，上面那张表按整名匹配，它们都会落成纯文本。
 * 只列这个约定几乎通用的几族，更少见的交给扩展名。
 */
const BY_FILENAME_PREFIX: [prefix: string, grammar: string][] = [
	[".env.", "env"],
	["dockerfile.", "dockerfile"],
	["docker-compose.", "yaml"],
];

/** 一个文件名要的语法在语法表里的键，认不出给 null。 */
export function grammarKeyFor(path: string): string | null {
	const name = path.toLowerCase().split(/[/\\]/).pop() ?? "";
	const byName = BY_FILENAME[name];
	if (byName) return GRAMMARS[byName] ? byName : null;
	for (const [prefix, grammar] of BY_FILENAME_PREFIX) {
		if (name.startsWith(prefix) && GRAMMARS[grammar]) return grammar;
	}
	// 开头的点算整个名字（`.env`），上面的表已经看过了。
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	const extension = name.slice(dot + 1);
	return GRAMMARS[extension] ? extension : null;
}

/** 按文件路径加载语法，给编辑器用。认不出给 null，调用方按纯文本显示。 */
export function loadLanguageFor(path: string): Promise<Extension> | null {
	const key = grammarKeyFor(path);
	return key ? GRAMMARS[key]!() : null;
}

/**
 * 围栏上写的语言名到语法表的键。语法表按扩展名作键，围栏按语言名写（` ```typescript `），这里只列两者不同的。
 */
const FENCE_ALIASES: Record<string, string> = {
	typescript: "ts",
	javascript: "js",
	python: "py",
	rust: "rs",
	golang: "go",
	kotlin: "kt",
	"c++": "cpp",
	"objective-c": "c",
	// 没有 make 的语法，Makefile 按 shell 上色是最接近的。
	makefile: "sh",
	make: "sh",
	mk: "sh",
	markdown: "md",
	yml: "yaml",
};

/** 加载围栏语言的语法。认不出来（shell 会话、没写语言）给 null，调用方画纯文本，不去猜。 */
export async function loadFenceLanguage(info: string): Promise<Language | null> {
	const name = info
		.toLowerCase()
		.trim()
		.split(/[\s:,]/)[0];
	if (!name) return null;
	const load = GRAMMARS[FENCE_ALIASES[name] ?? name];
	if (!load) return null;
	try {
		return asLanguage(await load());
	} catch {
		return null;
	}
}

/**
 * 从语法模块交回来的东西里取出 `Language`。
 *
 * `@codemirror/lang-*` 给的是 `LanguageSupport`，语言在 `.language` 上；`StreamLanguage.define` 直接给 `Language`。
 * 只认前一种的话，所有 legacy 语法（shell、toml、dockerfile……）加载了、能解析，却被丢掉画成纯文本，而围栏上照样
 * 显示语言名，看不出出了问题。也可能是数组（语言加一个附带的插件），取其中能给出语言的那个。
 *
 * 判断看 `parser` 而不是 `instanceof`：`tokenize` 要的就是它，也不在乎对象来自哪个包。
 */
function asLanguage(loaded: unknown): Language | null {
	if (Array.isArray(loaded)) {
		for (const member of loaded) {
			const found = asLanguage(member);
			if (found) return found;
		}
		return null;
	}
	const support = loaded as { language?: Language };
	const candidate = support?.language ?? (loaded as Language | null);
	return candidate && typeof (candidate as Language).parser === "object" ? candidate : null;
}

export interface Token {
	text: string;
	/** 这个片段的高亮类名；没有规则认领的字是 ""。 */
	className: string;
}

/**
 * 把代码切成带颜色的片段。
 *
 * `highlightTree` 只回调命中规则的区间，中间的空白、没人认领的标点要自己补上，否则字会缺块。
 */
export function tokenize(code: string, language: Language, style: HighlightStyle): Token[] {
	return runs(code, language.parser.parse(code), style);
}

/** 一段代码解析过的样子，留给它接着长的时候用。 */
export interface Grown {
	code: string;
	language: Language;
	style: HighlightStyle;
	tree: Tree;
	tokens: Token[];
}

/**
 * 正在输出的代码块用的 `tokenize`：代码只在后面接着长时，只重新解析长出来的那一截。
 *
 * 流式输出时代码块每帧都长几个字。每帧整块重新解析，耗时跟着块长走——600 行一次 11ms，已经超过一帧。Lezer 的
 * 增量解析把上一次的树当作碎片交回去，没被改动碰到的节点原样复用；配色也只重算尾巴。
 *
 * 不是接着长（改了前面、换了语言）就整块重来，和 `tokenize` 一样。
 */
export function tokenizeGrowing(code: string, language: Language, style: HighlightStyle, previous?: Grown): Grown {
	if (previous && previous.code === code && previous.language === language && previous.style === style) return previous;
	if (!previous || previous.language !== language || previous.style !== style || !code.startsWith(previous.code)) {
		const tree = language.parser.parse(code);
		return { code, language, style, tree, tokens: runs(code, tree, style) };
	}
	const end = previous.code.length;
	const fragments = TreeFragment.applyChanges(TreeFragment.addTree(previous.tree), [{ fromA: end, toA: end, fromB: end, toB: code.length }]);
	const tree = language.parser.parse(code, fragments);
	/*
	 * 配色也只重算尾巴：从上一次末尾的前一行开头算起，前面的沿用。
	 *
	 * 往回多退一行，是给「后面的字改变了前面的读法」留的余地——一行末尾的 `/` 是除号还是正则的开头，要看下一行。
	 * 更远的影响（一个没收口的块注释）在输出中途可能暂时配错，写完那一刻整块按 `tokenize` 重算，最终和从头解析的一样。
	 */
	const from = Math.max(0, code.lastIndexOf("\n", code.lastIndexOf("\n", end - 1) - 1) + 1);
	const kept: Token[] = [];
	let at = 0;
	for (const token of previous.tokens) {
		if (at >= from) break;
		const text = at + token.text.length > from ? token.text.slice(0, from - at) : token.text;
		kept.push(text === token.text ? token : { text, className: token.className });
		at += text.length;
	}
	return { code, language, style, tree, tokens: runs(code, tree, style, from, kept) };
}

function runs(code: string, tree: Tree, style: HighlightStyle, from = 0, tokens: Token[] = []): Token[] {
	let at = from;
	highlightTree(
		tree,
		style,
		(start, to, className) => {
			if (start > at) tokens.push({ text: code.slice(at, start), className: "" });
			tokens.push({ text: code.slice(start, to), className });
			at = to;
		},
		from,
	);
	if (at < code.length) tokens.push({ text: code.slice(at), className: "" });
	return tokens;
}

let shared: HighlightStyle | null = null;

/**
 * 全应用共用的一套高亮样式，第一次有人要时生成并挂进文档。
 *
 * `HighlightStyle` 生成的类名本来由编辑器挂到自己的根上；不起编辑器画同样的类，规则就得自己放进文档，否则每个片段
 * 带着一个背后什么都没有的类名。配色全是 `var(--plume-syntax-*)`，深浅色和皮肤由 token 切，样式不用重建，类名也就
 * 一直有效。规则按文本读出来放进 `<style>`，不直接用 `style-mod`：那是 CodeMirror 自己的间接依赖。
 */
export function sharedHighlightStyle(): HighlightStyle {
	if (shared) return shared;
	shared = highlightStyle();
	const rules = shared.module?.getRules();
	if (rules) {
		const element = document.createElement("style");
		element.dataset.plumeHighlight = "";
		element.textContent = rules;
		document.head.append(element);
	}
	return shared;
}
