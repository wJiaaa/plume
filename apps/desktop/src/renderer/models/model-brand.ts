/**
 * 一个模型是哪家做的。
 *
 * Plume 连的是你给的任意端点，没有「厂商」字段可读——关于一个模型能知道的只有填的 id 和起的名字。两样都拿来匹配，
 * 因为单靠哪一样都不可靠：中转把 `deepseek-v4-flash` 的显示名写成「DeepSeek V4 Flash」，网关给 id 加 `anthropic/`
 * 前缀，私有代理干脆叫它 `fast`。两次认出的机会比一次好，认错了也只是错一个标，不会发错请求。
 *
 * 词边界比看上去要紧。`o3` 作为子串会出现在和 OpenAI 无关的 `qwen-o3` 一类 id 里，更糟的是出现在版本号里——所以
 * OpenAI 的短别名按整词匹配，长而无歧义的名字在哪都算。中文名不加边界：`\b` 只认 ASCII 单词字符，两个汉字之间从不触发。
 *
 * 顺序就是优先级：`deepseek-v3` 不能因为一个 `v3` 变成 OpenAI，所以无歧义的厂商先问。
 */

export type Brand =
	| "openai"
	| "claude"
	| "deepseek"
	| "gemini"
	| "qwen"
	| "grok"
	| "mistral"
	| "hunyuan"
	| "kimi"
	| "minimax"
	| "stepfun"
	| "baichuan"
	| "doubao"
	| "yi"
	| "glm";

// i18n-exempt：中文厂商名是用来匹配模型名的规则，不是界面文案。
const RULES: { brand: Brand; test: RegExp }[] = [
	{ brand: "deepseek", test: /deepseek/ },
	{ brand: "claude", test: /claude|anthropic|\bopus\b|\bsonnet\b|\bhaiku\b/ },
	{ brand: "kimi", test: /kimi|moonshot/ },
	// `ep-` 是火山引擎的接入点 id（`ep-20250101…`），所以只认词首：放在词中间会命中每个阶跃模型——`step-3` 里就有 `ep-`。
	{ brand: "doubao", test: /doubao|豆包|skylark|\bep-/ },
	{ brand: "minimax", test: /minimax|abab/ },
	{ brand: "stepfun", test: /stepfun|step-|阶跃/ },
	{ brand: "baichuan", test: /baichuan|百川/ },
	{ brand: "yi", test: /\byi-|\blingyi\b|零一万物/ },
	{ brand: "qwen", test: /qwen|qwq|qvq|tongyi|通义|千问/ },
	{ brand: "gemini", test: /gemini|gemma|\bpalm\b/ },
	{ brand: "grok", test: /\bgrok\b|\bxai\b/ },
	{ brand: "mistral", test: /mistral|mixtral|codestral|devstral|magistral|ministral|pixtral/ },
	{ brand: "hunyuan", test: /hunyuan|混元/ },
	// `chatglm` 单独写出来：`glm` 前的词边界在一个词里面不会触发。
	{ brand: "glm", test: /\bglm|chatglm|zhipu|智谱/ },
	// 放最后，也是唯一要按整词小心匹配的：`o3`/`o4` 只有两个字符，很多不是 OpenAI 的 id 里都有。
	{ brand: "openai", test: /openai|chatgpt|\bgpt|codex|davinci|\bo[1345](?:-[a-z]+)*\b/ },
];

/**
 * 模型背后的品牌，都不匹配时为 null。
 *
 * null 是正常的答案而不是失败：自部署、微调的模型叫什么全凭主人高兴，调用方给它们画中性的标。
 */
export function brandOf(modelId: string | null | undefined, displayName?: string | null): Brand | null {
	const haystack = `${modelId ?? ""} ${displayName ?? ""}`.toLowerCase();
	if (!haystack.trim()) return null;
	return RULES.find((rule) => rule.test.test(haystack))?.brand ?? null;
}

/**
 * 一家厂商除品牌键以外的叫法：Gemini 的 `google`、Kimi 的 `moonshot`。
 *
 * 只放厂商名，不放旗下的系列名——`sonnet` 会匹配到远比搜「Anthropic」想要的多的东西。
 */
const HOUSE_WORDS: Record<Brand, readonly string[]> = {
	openai: ["openai", "chatgpt"],
	claude: ["claude", "anthropic"],
	deepseek: ["deepseek"],
	gemini: ["gemini", "google"],
	qwen: ["qwen", "tongyi"],
	grok: ["grok", "xai"],
	mistral: ["mistral"],
	hunyuan: ["hunyuan", "tencent"],
	kimi: ["kimi", "moonshot"],
	minimax: ["minimax"],
	stepfun: ["stepfun"],
	baichuan: ["baichuan"],
	doubao: ["doubao"],
	yi: ["yi"],
	glm: ["zhipu", "zai"],
};

/** 一家厂商的所有叫法，用来让「google」这样的搜索匹配到 `gemini-…`。 */
export function houseWords(brand: Brand): readonly string[] {
	return [brand, ...HOUSE_WORDS[brand]];
}

/**
 * 厂商在屏幕上的名字，给选择器左侧只有标的那一列用。
 *
 * 专有名词，各语言同一种写法——和标本身不翻译是一个道理。
 */
const BRAND_NAMES: Record<Brand, string> = {
	openai: "OpenAI",
	claude: "Claude",
	deepseek: "DeepSeek",
	gemini: "Gemini",
	qwen: "Qwen",
	grok: "Grok",
	mistral: "Mistral",
	hunyuan: "Hunyuan",
	kimi: "Kimi",
	minimax: "MiniMax",
	stepfun: "StepFun",
	baichuan: "Baichuan",
	doubao: "Doubao",
	yi: "Yi",
	glm: "GLM",
};

export function brandName(brand: Brand): string {
	return BRAND_NAMES[brand];
}
