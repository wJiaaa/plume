/**
 * 划词引用的锚点计算：节点离开转录、空框或滚出视口时收起，不把 0×0 交给弹层甩到窗口左上角。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { quoteAnchor } from "../src/renderer/conversation/quote.ts";

const previousNode = globalThis.Node;

beforeEach(() => {
	if (!globalThis.Node) {
		(globalThis as unknown as { Node: { TEXT_NODE: number } }).Node = { TEXT_NODE: 3 };
	}
});

afterEach(() => {
	if (previousNode === undefined) {
		delete (globalThis as unknown as { Node?: unknown }).Node;
	} else {
		globalThis.Node = previousNode;
	}
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		x: left,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

function makeRange(options: { connected?: boolean; bounds: DOMRect }): Range {
	const node = { nodeType: Node.TEXT_NODE, isConnected: options.connected ?? true } as unknown as Node;
	return {
		startContainer: node,
		endContainer: node,
		commonAncestorContainer: node,
		getBoundingClientRect: () => options.bounds,
	} as unknown as Range;
}

function makeBox(options: { contains?: boolean; bounds: DOMRect }): HTMLElement {
	return {
		contains: () => options.contains ?? true,
		getBoundingClientRect: () => options.bounds,
	} as unknown as HTMLElement;
}

test("选区在转录视口内时返回横中线和上沿", () => {
	const box = makeBox({ bounds: rect(240, 48, 800, 600) });
	const range = makeRange({ bounds: rect(400, 200, 120, 20) });
	assert.deepEqual(quoteAnchor(range, box), { x: 460, y: 200 });
});

test("选区节点已摘出文档或不在转录内时返回 null", () => {
	const box = makeBox({ bounds: rect(240, 48, 800, 600) });
	assert.equal(quoteAnchor(makeRange({ connected: false, bounds: rect(0, 0, 0, 0) }), box), null);
	assert.equal(
		quoteAnchor(makeRange({ connected: true, bounds: rect(400, 200, 120, 20) }), makeBox({ contains: false, bounds: rect(240, 48, 800, 600) })),
		null,
	);
});

test("选区或转录量出空框时返回 null（防止 0×0 甩到左上角）", () => {
	const box = makeBox({ bounds: rect(240, 48, 800, 600) });
	assert.equal(quoteAnchor(makeRange({ bounds: rect(0, 0, 0, 0) }), box), null);
	assert.equal(quoteAnchor(makeRange({ bounds: rect(400, 200, 120, 20) }), makeBox({ bounds: rect(0, 0, 0, 0) })), null);
});

test("选区完全滚出转录视口时返回 null，上沿超出顶边时贴住视口上沿", () => {
	const box = makeBox({ bounds: rect(240, 48, 800, 600) });
	// 完全滚到视口上方 / 下方
	assert.equal(quoteAnchor(makeRange({ bounds: rect(400, 10, 120, 20) }), box), null);
	assert.equal(quoteAnchor(makeRange({ bounds: rect(400, 650, 120, 20) }), box), null);
	// 上半截滚出顶边、下半截仍在视口里：纵坐标贴住视口上沿
	assert.deepEqual(quoteAnchor(makeRange({ bounds: rect(400, 20, 120, 60) }), box), { x: 460, y: 48 });
});
