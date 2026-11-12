/**
 * 界面文案的两份目录（中文、英文）：key 一样、`{变量}` 一样、复数形式齐全，以及语言怎么选。
 * 类型保证了 en 不缺 key，但 `node --test` 只剥类型不检查，类型也看不到字符串里面。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatList } from "../src/i18n/list.ts";
import { resolveUiLocale } from "../src/i18n/locales.ts";
import { MESSAGE_CATALOGS, type MessageKey, type PluralForms, type ResolvedUiLocale } from "../src/i18n/messages/index.ts";
import { pluralCategory, pluralForm } from "../src/i18n/plural.ts";
import { setActiveLocale } from "../src/i18n/translate.ts";

test("跟随系统时按语言族选：各地区的中文都落到简体中文，其余落到英文", () => {
	assert.equal(resolveUiLocale("system", ["zh-Hant-HK"]), "zh-CN");
	assert.equal(resolveUiLocale("system", ["zh-CN"]), "zh-CN");
	assert.equal(resolveUiLocale("system", ["en-GB"]), "en");
	assert.equal(resolveUiLocale("system", ["ja-JP", "zh-CN"]), "zh-CN");
	assert.equal(resolveUiLocale("system", ["es-MX"]), "en");
});

test("指定了语言就不看系统", () => {
	assert.equal(resolveUiLocale("en", ["zh-CN"]), "en");
	assert.equal(resolveUiLocale("zh-CN", ["en-US"]), "zh-CN");
});

test("两份目录的 key 一样", () => {
	const source = Object.keys(MESSAGE_CATALOGS["zh-CN"]).sort();
	for (const [locale, catalog] of Object.entries(MESSAGE_CATALOGS)) {
		assert.deepEqual(Object.keys(catalog).sort(), source, `${locale} 缺少界面文案`);
	}
});

/** 一个词条能显示出来的每一句：它自己，或者它的每个复数形式。 */
const forms = (entry: (typeof MESSAGE_CATALOGS)["en"][MessageKey]): string[] => (typeof entry === "string" ? [entry] : Object.values(entry));

test("每一句翻译都保留中文原文的 {变量}", () => {
	// 改名或漏掉的变量只在那一种语言里露出字面的 `{name}`；复数形式各自是一句，逐句对照。
	const slots = (text: string) => [...new Set([...text.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]))].sort();
	const source = MESSAGE_CATALOGS["zh-CN"] as Record<MessageKey, string>;
	for (const [locale, catalog] of Object.entries(MESSAGE_CATALOGS)) {
		for (const [key, entry] of Object.entries(catalog)) {
			for (const text of forms(entry)) assert.deepEqual(slots(text), slots(source[key as MessageKey]), `${locale} ${key}: ${text}`);
		}
	}
});

test("文案里不写 HTML 实体", () => {
	// 文案是当文本放进界面的，React 不解实体：`&#10;` 在屏幕上就是五个字符。要换行写 `\n`。
	for (const [locale, catalog] of Object.entries(MESSAGE_CATALOGS)) {
		for (const [key, entry] of Object.entries(catalog)) {
			for (const text of forms(entry)) assert.doesNotMatch(text, /&(#\d+|#x[\da-f]+|[a-z]+);/i, `${locale} ${key}`);
		}
	}
});

test("复数形式正好覆盖这种语言数数时用到的类别", () => {
	// 缺了一类，那些数就落到 other；多了一类，永远不会被选中。各自在作者看的那种语言里都读得通，只能在这里查。
	for (const [locale, catalog] of Object.entries(MESSAGE_CATALOGS)) {
		const rules = new Intl.PluralRules(locale);
		const known = new Set<string>(rules.resolvedOptions().pluralCategories);
		const counted = new Set<string>(Array.from({ length: 1001 }, (_, n) => rules.select(n)));
		for (const [key, entry] of Object.entries(catalog)) {
			if (typeof entry === "string") continue;
			const given = Object.keys(entry);
			assert.ok(counted.size > 1, `${locale} ${key}：${locale} 每个数说法都一样，写成一句就行`);
			for (const category of given) assert.ok(known.has(category), `${locale} ${key}：${locale} 没有 "${category}"`);
			for (const category of counted) assert.ok(given.includes(category), `${locale} ${key}：少了 "${category}"`);
		}
	}
});

test("英文里数数的句子有单数形式", () => {
	/*
	 * 「1 conversations」：一句数数的话写成了一个字符串。英文里这种句子是数字后面隔一两个词跟一个复数，
	 * 所以这种形状的单句就是少了 one。数字是 `{n}`，或者中文原文里后面跟着量词的变量（「{total} 行」「{requests} 次请求」）。
	 */
	// 例外：这些句子里的数不会是 1，原因写在旁边。
	const exempt: Record<string, string> = {
		"modelSettings.catalogStatus": "数的是整份模型目录，上千条，不会是 1",
		"contextMeter.usedOfLimit": "后面的数是模型的上下文窗口，成千上万个 token，不会是 1",
	};
	const source = MESSAGE_CATALOGS["zh-CN"] as Record<MessageKey, string>;
	const measured = /\{(\w+)\} ?(?:个|次|条|项|行|列|处|份|张|篇|位|台|页|组|轮|天|小时|分钟|秒|字|名|件|段|层|步|遍|场|批|封|token)/g;
	const counts = (key: MessageKey) => ["n", ...Array.from(source[key].matchAll(measured), (match) => match[1])];
	const plain = Object.entries(MESSAGE_CATALOGS.en).filter(
		([key, entry]) =>
			typeof entry === "string" &&
			!(key in exempt) &&
			counts(key as MessageKey).some((slot) => new RegExp(`\\{${slot}\\} (?:[a-z-]+ )?[a-z-]+(?:s\\b|\\(s\\))`, "i").test(entry)),
	);
	assert.deepEqual(
		plain.map(([key, entry]) => `${key}: ${entry}`),
		[],
	);
});

test("英文 1 是单数，0、2 和小数是复数；中文每个数都一样", () => {
	assert.deepEqual(
		[1].map((n) => pluralCategory("en", n)),
		["one"],
	);
	assert.deepEqual(
		[0, 2, 5, 11, 21, 101, 1.5].map((n) => pluralCategory("en", n)),
		Array(7).fill("other"),
	);
	assert.deepEqual(
		[0, 1, 2, 5, 21, 1.5].map((n) => pluralCategory("zh-CN", n)),
		Array(6).fill("other"),
	);
});

test("写成数字的计数照样选形式，格式化过的落到 other", () => {
	const message: PluralForms = { one: "{n} message", other: "{n} messages" };
	assert.equal(pluralForm("en", message, "1"), "{n} message");
	assert.equal(pluralForm("en", message, "2"), "{n} messages");
	assert.equal(pluralForm("en", message, "1,234"), "{n} messages");
	assert.equal(pluralForm("en", message, undefined), "{n} messages");
	assert.equal(pluralForm("en", "a plain string", 1), "a plain string");
	assert.equal(pluralForm("en", { other: "other" }, 1), "other");
});

// 用 Record：多一种语言而没定它的分隔符，这里就是类型错误。
const THREE: Record<ResolvedUiLocale, string> = { "zh-CN": "a、b、c", en: "a, b, c" };

test("列表按界面语言的分隔符连起来，不加连词", () => {
	for (const [locale, joined] of Object.entries(THREE)) assert.equal(formatList(["a", "b", "c"], locale as ResolvedUiLocale), joined, locale);
	assert.equal(formatList(["a", "b"], "en"), "a, b");
	assert.equal(formatList(["a"], "en"), "a");
	assert.equal(formatList([], "zh-CN"), "");
	try {
		setActiveLocale("en");
		assert.equal(formatList(["a", "b"]), "a, b");
	} finally {
		setActiveLocale("zh-CN");
	}
	assert.equal(formatList(["a", "b"]), "a、b");
});
