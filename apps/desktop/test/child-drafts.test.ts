import assert from "node:assert/strict";
import { test } from "node:test";
import {
	childDraft,
	dropChildDraft,
	EMPTY_CHILD_DRAFT,
	flushChildDrafts,
	seedChildQuote,
	setChildDraft,
	subscribeChildDrafts,
	takeChildQuoteFocus,
	type ChildDraft,
} from "../src/renderer/conversation/child-drafts.ts";

test("可搬窗草稿按标签保存，发送和关闭清理，存储失败不丢内存并阻止交接", () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const entries = new Map<string, string>();
	let blocked = false;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => {
				if (blocked) throw new Error("quota");
				entries.set(key, value);
			},
			removeItem: (key: string) => entries.delete(key),
		},
	});
	let changes = 0;
	const stop = subscribeChildDrafts(() => changes++);
	try {
		setChildDraft("a", { ...EMPTY_CHILD_DRAFT, text: "尚未发送" });
		setChildDraft("b", { ...EMPTY_CHILD_DRAFT, text: "另一段" });
		assert.equal(childDraft("a").text, "尚未发送");
		// 落盘攒着写：敲字时只改内存，交接前 flush 当场写齐。
		assert.equal(entries.has("plume.child-draft:a"), false);
		flushChildDrafts();
		assert.deepEqual(JSON.parse(entries.get("plume.child-draft:a")!), childDraft("a"));
		assert.equal(childDraft("b").text, "另一段");
		blocked = true;
		setChildDraft("a", { ...EMPTY_CHILD_DRAFT, text: "继续保留" });
		assert.equal(childDraft("a").text, "继续保留");
		assert.throws(flushChildDrafts, /quota/);
		blocked = false;
		flushChildDrafts();
		assert.equal(JSON.parse(entries.get("plume.child-draft:a")!).text, "继续保留");
		setChildDraft("a", EMPTY_CHILD_DRAFT);
		flushChildDrafts();
		assert.equal(entries.has("plume.child-draft:a"), false);
		dropChildDraft("b");
		assert.equal(childDraft("b"), EMPTY_CHILD_DRAFT);
		assert.ok(changes >= 5);
	} finally {
		dropChildDraft("a");
		dropChildDraft("b");
		stop();
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});

test("划词追加到原草稿，保存来源、附件和已有引用，跨窗恢复且聚焦只消费一次", () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const entries = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => entries.set(key, value),
			removeItem: (key: string) => entries.delete(key),
		},
	});
	const before: ChildDraft = {
		text: "看看【图片 1】",
		attachments: [{ id: "image", name: "image.png", label: "图片 1", mimeType: "image/png", data: "aGVsbG8=", isText: false, kind: "image" }],
		quotes: [{ id: "first", text: "第一段", from: "assistant" }],
	};
	const second = { id: "second", text: "我问过的第二段", from: "user" } as const;
	try {
		setChildDraft("quoted", before);
		seedChildQuote("quoted", second);
		const expected = { ...before, quotes: [...before.quotes, second] };
		assert.deepEqual(childDraft("quoted"), expected);
		assert.equal(before.quotes.length, 1);
		assert.equal(takeChildQuoteFocus("quoted"), true);
		assert.equal(takeChildQuoteFocus("quoted"), false);
		flushChildDrafts();
		entries.set("plume.child-draft:restored", entries.get("plume.child-draft:quoted")!);
		assert.deepEqual(childDraft("restored"), expected);
		assert.equal(takeChildQuoteFocus("restored"), false);
		assert.equal(childDraft("another"), EMPTY_CHILD_DRAFT);
		setChildDraft("quoted", EMPTY_CHILD_DRAFT);
		seedChildQuote("quoted", second);
		assert.deepEqual(childDraft("quoted"), { text: "", attachments: [], quotes: [second] });
		dropChildDraft("quoted");
		assert.equal(takeChildQuoteFocus("quoted"), false);
		assert.equal(entries.has("plume.child-draft:quoted"), false);
	} finally {
		for (const key of ["quoted", "restored", "another"]) dropChildDraft(key);
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});

test("草稿存储损坏时不让输入框崩溃", () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	let raw = "{";
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => raw, removeItem() {} } });
	try {
		assert.equal(childDraft("broken-json"), EMPTY_CHILD_DRAFT);
		raw = JSON.stringify({ text: "", attachments: [], quotes: [{ id: "x", text: "x", from: "tool" }] });
		assert.equal(childDraft("broken-quote"), EMPTY_CHILD_DRAFT);
		raw = JSON.stringify({ text: "", attachments: [{ id: "x", name: "x", mimeType: "text/plain", isText: true, text: {} }], quotes: [] });
		assert.equal(childDraft("broken-file"), EMPTY_CHILD_DRAFT);
	} finally {
		for (const key of ["broken-json", "broken-quote", "broken-file"]) dropChildDraft(key);
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});
