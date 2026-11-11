import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skinValues } from "../src/renderer/skin-values.ts";
import { skinRegistry } from "../src/renderer/skins.ts";
import { uiLifetime } from "../src/renderer/ui-lifetime.ts";
import { ThemeOverrides } from "../src/main/theme-overrides.ts";
import { BackgroundImageStore, imageExtension } from "../src/main/background-image.ts";
import {
	cleanAppearance,
	editableAppearancePatch,
	effectiveAppearance,
	patchAppearance,
	resetAppearancePatch,
	type Appearance,
} from "../src/shared/appearance.ts";

const hasToken = (token: string) => ["bg", "fg", "root", "accent-dim"].includes(token);

test("停靠侧栏透明共用外圈底层，只有 compact 浮出侧栏单独铺底", () => {
	const source = readFileSync(new URL("../src/renderer/app.tsx", import.meta.url), "utf8");
	const aside = source.slice(source.indexOf("<aside"), source.indexOf("</aside>"));
	assert.match(aside, /compact\s*\? `absolute[^`]*bg-sidebar/);
	assert.match(aside, /: "relative shrink-0 overflow-hidden"/);
	assert.doesNotMatch(aside, /managedSkin/);
});

test("旧种子皮肤不接管偏好，数据皮肤必须同时提供名字和模式", () => {
	const legacy = { light: { bg: "var(--plume-shell)" }, dark: { fg: "currentColor" } };
	assert.equal(skinValues(legacy, hasToken).managed, undefined);
	assert.equal(skinValues({ ...legacy, name: "青春" }, hasToken).managed, undefined);
	assert.equal(skinValues({ ...legacy, mode: "dark" }, hasToken).managed, undefined);
	assert.deepEqual(skinValues({ ...legacy, name: " Finch ", mode: "light" }, hasToken).managed, { name: "Finch", mode: "light" });
	assert.deepEqual(skinValues({ name: "Plume default", mode: "system" }, hasToken).managed, { name: "Plume default", mode: "system" });
	for (const skin of [null, [], { name: "" }, { mode: "invalid" }, { light: [] }, { light: { missing: "red" } }, { dark: { bg: 2 } }, { light: { bg: " " } }]) {
		assert.throws(() => skinValues(skin, hasToken));
	}
});

test("皮肤更新不叠样式表，null 和卸载恢复前一套及管理状态，坏数据不留下半套", (t) => {
	type Rule = { cssRules: Array<{ style: { setProperty: (name: string, value: string) => void } }> };
	const styles: Array<{
		dataset: Record<string, string>;
		removed: boolean;
		sheet: { disabled: boolean; cssRules: Rule[]; insertRule: (rule: string, index: number) => number };
		remove: () => void;
	}> = [];
	const document = {
		documentElement: {},
		head: { append: (style: (typeof styles)[number]) => styles.push(style) },
		createElement: () => {
			const rules: Rule[] = [];
			const style = {
				dataset: {},
				removed: false,
				sheet: {
					disabled: false,
					cssRules: rules,
					insertRule: (_rule: string, index: number) => {
						rules.splice(index, 0, { cssRules: [{ style: { setProperty: () => {} } }] });
						return index;
					},
				},
				remove: () => {
					style.removed = true;
				},
			};
			return style;
		},
	};
	for (const [name, value] of Object.entries({
		document,
		getComputedStyle: () => ({ getPropertyValue: (name: string) => (hasToken(name.slice("--plume-".length)) ? "initial" : "") }),
	})) {
		const original = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { value, configurable: true });
		t.after(() => {
			if (original) Object.defineProperty(globalThis, name, original);
			else Reflect.deleteProperty(globalThis, name);
		});
	}
	let managed: { name: string; mode: "system" | "light" | "dark" } | undefined;
	const skins = skinRegistry((value) => {
		managed = value;
	});
	const data = { name: "Finch", mode: "dark", light: { root: "inherit", "accent-dim": "transparent" }, dark: { root: "inherit" } };
	skins.set("legacy", { light: { bg: "inherit" } });
	skins.set("default", { name: "Plume default", mode: "system" });
	assert.deepEqual(managed, { name: "Plume default", mode: "system" });
	skins.set("default", null);
	skins.set("studio", data);
	assert.equal(styles[0]!.sheet.disabled, true);
	assert.deepEqual(managed, { name: "Finch", mode: "dark" });
	skins.set("studio", { ...data, name: "Finch II", mode: "light" });
	assert.equal(styles[1]!.removed, true);
	assert.equal(styles.filter((style) => !style.removed).length, 2);
	assert.deepEqual(managed, { name: "Finch II", mode: "light" });
	assert.throws(() => skins.set("studio", { light: { bg: "inherit" }, dark: { missing: "red" } }));
	assert.equal(styles.length, 4);
	assert.equal(managed?.name, "Finch II");
	skins.set("studio", null);
	assert.equal(managed, undefined);
	assert.equal(styles[0]!.sheet.disabled, false);
	skins.remove("legacy");
	assert.ok(styles.every((style) => style.removed));
	skins.set("studio", data);
	skins.remove("studio");
	assert.equal(managed, undefined);
});

test("界面入口先失效再逆序清理，停用、重载或 apply 失败后旧异步回调不能复活皮肤", async () => {
	const cleaned: string[] = [];
	const errors: unknown[] = [];
	const old = uiLifetime((error) => errors.push(error));
	let skin = "old";
	const delayed = async () => {
		await Promise.resolve();
		if (old.active) skin = "resurrected";
	};
	old.effect(() => {
		cleaned.push("first");
	});
	old.effect(() => {
		assert.equal(old.active, false);
		throw new Error("cleanup failed");
	});
	old.effect(() => {
		cleaned.push("last");
	});
	const pending = delayed();
	old.dispose();
	old.dispose();
	const replacement = uiLifetime(() => {});
	skin = "new";
	await pending;
	assert.equal(skin, "new");
	assert.equal(replacement.active, true);
	assert.deepEqual(cleaned, ["last", "first"]);
	assert.equal(errors.length, 1);
	old.effect(() => {
		cleaned.push("late");
	});
	assert.equal(cleaned.at(-1), "late");
	assert.throws(() => old.effect(null as never));
});

test("主进程深浅覆盖按 owner 释放，不影响其他窗口，最后一个撤下才恢复用户模式", () => {
	const overrides = new ThemeOverrides();
	const userTheme = "system";
	overrides.set(1, "system");
	assert.equal(overrides.mode, "system");
	overrides.set(1, "dark");
	overrides.set(2, "dark");
	overrides.set(1, null);
	assert.equal(overrides.mode, "dark");
	overrides.set(3, "light");
	assert.equal(overrides.mode, "light");
	overrides.set(3, null);
	assert.equal(overrides.mode, "dark");
	overrides.set(2, null);
	assert.equal(overrides.mode ?? userTheme, "system");
	overrides.set(2, null);
	assert.equal(overrides.mode, undefined);
});

test("背景输入只接受真实支持的图片签名", () => {
	assert.equal(imageExtension("drop.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
	assert.equal(imageExtension("drop.webp", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), "webp");
	assert.equal(imageExtension("drop.txt", new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
	assert.equal(imageExtension("drop.png", new Uint8Array([1, 2, 3, 4])), null);
});

test("并发导入在外观引用提交前保留原图，提交后才清理未引用文件", async () => {
	const directory = await mkdtemp(join(tmpdir(), "plume-background-"));
	try {
		const store = new BackgroundImageStore(directory);
		const original = "chat-1.png";
		await writeFile(join(directory, original), "old");
		const [first, second] = await Promise.all([store.import(new Uint8Array([1]), "png"), store.import(new Uint8Array([2]), "png")]);
		if (!("name" in first) || !("name" in second)) throw new Error("background import failed");
		assert.equal(await readFile(join(directory, original), "utf8"), "old");
		await store.commit(original);
		assert.equal(await readFile(join(directory, original), "utf8"), "old");
		await store.commit(second.name);
		await assert.rejects(readFile(join(directory, original)));
		assert.equal((await readFile(join(directory, second.name))).at(0), 2);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("数据皮肤仅暂停界面种子，字体、代码和背景偏好继续生效，恢复默认不删除只读原值", () => {
	const saved: Appearance = {
		theme: "system",
		accent: "#AABBCC",
		contrast: 0,
		lightBackground: "#FFFFFF",
		lightForeground: "#111111",
		darkBackground: "#111111",
		darkForeground: "#FFFFFF",
		uiFont: "system-ui",
		uiFontSize: 16,
		codeDarkTheme: "github-dark",
		codeFont: "monospace",
		codeFontSize: 14,
		inlineCode: "custom",
		inlineCodeDarkBg: "#112233",
		chatBackground: "chat-123.png",
		vibrancy: false,
	};
	const original = structuredClone(saved);
	const effective = effectiveAppearance(saved, true);
	assert.equal(effective.accent, undefined);
	assert.equal(effective.theme, undefined);
	assert.equal(effective.contrast, undefined);
	assert.equal(effective.lightBackground, undefined);
	assert.equal(effective.codeDarkTheme, "github-dark");
	assert.equal(effective.inlineCodeDarkBg, "#112233");
	assert.equal(effective.uiFont, "system-ui");
	assert.equal(effective.chatBackground, "chat-123.png");
	assert.equal(effective.vibrancy, false);
	assert.deepEqual(saved, original);
	assert.equal(effectiveAppearance(saved, false), saved);
	assert.equal(patchAppearance(saved, { chatBackgroundFit: "tile" }).chatBackgroundFit, "tile");
	assert.equal(cleanAppearance({ chatBackgroundFit: "stretch" }).chatBackgroundFit, undefined);
	assert.equal(patchAppearance(saved, { grain: true }).grain, true);
	assert.equal(cleanAppearance({ grain: "yes" }).grain, undefined);
	assert.deepEqual(patchAppearance(saved, editableAppearancePatch({ accent: null, theme: "light", codeFontSize: 17 }, true)), { ...saved, codeFontSize: 17 });
	const reset = patchAppearance(saved, editableAppearancePatch(resetAppearancePatch(saved), true));
	assert.deepEqual(reset, {
		theme: "system",
		accent: "#AABBCC",
		contrast: 0,
		lightBackground: "#FFFFFF",
		lightForeground: "#111111",
		darkBackground: "#111111",
		darkForeground: "#FFFFFF",
	});
});
