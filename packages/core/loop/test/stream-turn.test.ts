import type { RequestOptions } from "@plume/llm/types";
import { expect, it, vi } from "vitest";
import type { RetrySettled } from "../src/hiccups.ts";

// 适配器先说要重试，等的时候直接抛错（不是交回一条出错的回复）。
vi.mock("@plume/llm", () => ({
	streamAssistant: (_provider: unknown, _model: unknown, _context: unknown, options: RequestOptions) => ({
		async next() {
			options.onRetry?.({ delayMs: 1000, reason: "overloaded" } as Parameters<NonNullable<RequestOptions["onRetry"]>>[0]);
			throw new Error("adapter blew up");
		},
	}),
}));

const { streamTurn } = await import("../src/stream-turn.ts");

it("等重试时适配器抛错：那次重试照样收场，界面上不留一个一直挂着的倒计时", async () => {
	const settled: RetrySettled[] = [];
	const turn = streamTurn({
		provider: {} as never,
		model: { id: "m", name: "m" } as never,
		context: {} as never,
		options: {},
		draft: () => undefined,
		keep: () => undefined,
		retry: () => undefined,
		settled: (info) => settled.push(info),
	});
	await expect(turn).rejects.toThrow("adapter blew up");
	expect(settled).toEqual([{ outcome: "gave_up", attempts: 1 }]);
});
