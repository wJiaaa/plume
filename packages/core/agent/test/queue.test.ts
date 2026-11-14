import { expect, it } from "vitest";
import type { QueuedMessage } from "@plume/contract";
import { SessionQueues } from "../src/queue.ts";

function memory(saved: Map<string, unknown> = new Map()) {
	return {
		saved,
		queues: () => new Map(saved),
		saveQueue: (sessionId: string, entries: readonly QueuedMessage[]) => void saved.set(sessionId, structuredClone(entries)),
	};
}

const say = (text: string) => ({ content: [{ type: "text" as const, text }] });

it("插话排在已有的插话后面、没标的前面，按插进来的先后取；放回的不再是插话", () => {
	const queues = SessionQueues.open(
		memory(),
		() => undefined,
		(error) => {
			throw error;
		},
	);
	queues.push("s", say("排着"), "排着");
	queues.push("s", say("第一句插话"), "第一句插话", {}, true);
	queues.push("s", say("第二句插话"), "第二句插话", {}, true);
	expect(queues.list("s").map((entry) => [entry.preview, entry.steered])).toEqual([
		["第一句插话", true],
		["第二句插话", true],
		["排着", undefined],
	]);

	// 读的时候只看不取：读进去以后才从条上收走。
	const first = queues.peekSteered("s")!;
	expect(first.preview).toBe("第一句插话");
	expect(queues.list("s")).toHaveLength(3);
	queues.take("s", first.id);
	expect(queues.peekSteered("s")!.preview).toBe("第二句插话");

	queues.unsteer("s");
	expect(queues.hasSteered("s")).toBe(false);
	expect(queues.peekSteered("s")).toBeUndefined();
});

it("「插进这一轮」标成插话排到插话后面，不插时挪到队首", () => {
	const queues = SessionQueues.open(
		memory(),
		() => undefined,
		() => undefined,
	);
	queues.push("s", say("a"), "a", {}, true);
	const b = queues.push("s", say("b"), "b");
	const c = queues.push("s", say("c"), "c");
	queues.promote("s", c.id, true);
	expect(queues.list("s").map((entry) => [entry.preview, entry.steered])).toEqual([
		["a", true],
		["c", true],
		["b", undefined],
	]);
	queues.unsteer("s");
	queues.promote("s", b.id, false);
	expect(queues.list("s").map((entry) => entry.preview)).toEqual(["b", "a", "c"]);
});

it("重开应用时没有一轮在跑，存下的插话成了普通排着的一条", () => {
	const store = memory();
	const before = SessionQueues.open(
		store,
		() => undefined,
		() => undefined,
	);
	before.push("s", say("插话"), "插话", {}, true);
	const after = SessionQueues.open(
		store,
		() => undefined,
		() => undefined,
	);
	expect(after.list("s")).toMatchObject([{ preview: "插话" }]);
	expect(after.hasSteered("s")).toBe(false);
});
