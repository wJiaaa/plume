import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelContext, Plugin } from "@plume/contract";
import { PluginHost } from "../src/host.ts";
import { settlePrompt } from "../src/prompt/sections.ts";

describe("systemPrompt 和 sections 对齐", () => {
	const sections = [
		{ id: "identity", text: "I" },
		{ id: "workspace", text: "W" },
	];
	const context: ModelContext = {
		sessionId: "s",
		cwd: "/",
		scratchDir: "/scratch/s",
		model: { id: "m", name: "M" },
		permissionMode: "auto",
		personalization: { tone: "professional", customInstructions: "" },
		systemPrompt: "I\n\nW",
		sections,
		messages: [],
		tools: [],
	};

	it("只改段落：重新拼字符串", () => {
		expect(settlePrompt(context, { ...context, sections: [{ id: "identity", text: "J" }, ...sections.slice(1)] }).systemPrompt).toBe("J\n\nW");
	});

	it("只往字符串后面接：接上的那截成为 extension 段", () => {
		const settled = settlePrompt(context, { ...context, systemPrompt: "I\n\nW\nHINT" });
		expect(settled.sections).toEqual([...sections, { id: "extension", text: "HINT" }]);
		expect(settled.systemPrompt).toBe("I\n\nW\n\nHINT");
	});

	it("整个换掉字符串：只剩一段 extension", () => {
		const settled = settlePrompt(context, { ...context, systemPrompt: "全新的" });
		expect(settled.sections).toEqual([{ id: "extension", text: "全新的" }]);
		expect(settled.systemPrompt).toBe("全新的");
	});

	it("两个都改了以段落为准；都没改原样交回", () => {
		expect(settlePrompt(context, { ...context, systemPrompt: "别的", sections: [{ id: "x", text: "X" }] }).systemPrompt).toBe("X");
		const same = { ...context };
		expect(settlePrompt(context, same)).toBe(same);
	});

	it("钩子里外层拼字符串、里层按段改，两边的改动都留着", async () => {
		const outer: Plugin = {
			name: "outer",
			apply: (ctx) => ctx.hook("model.context", (input, next) => next({ ...input, systemPrompt: `${input.systemPrompt}\nOUTER` })),
		};
		const inner: Plugin = {
			name: "inner",
			apply: (ctx) =>
				ctx.hook(
					"model.context",
					async (input, next) => {
						const out = await next({ ...input, sections: input.sections.filter((section) => section.id !== "identity") });
						return { ...out, sections: [...out.sections, { id: "after", text: "AFTER" }] };
					},
					{ order: 10 },
				),
		};
		const dir = await mkdtemp(join(tmpdir(), "plume-prompt-"));
		const host = new PluginHost({
			dataDir: dir,
			appDataDir: dir,
			disabled: new Set(),
			log: () => {},
			model: {
				complete: async () => "",
				usage: async () => ({ requests: [], providerNames: {}, archived: [] }),
				findImageModel: async () => ({ reason: "none", candidates: [] }),
				image: async () => ({ ok: false, failure: { summary: "" } }),
			},
			notice: () => {},
		});
		await host.load([outer, inner].map((plugin) => ({ key: plugin.name, load: async () => plugin })));
		let seen: ModelContext | undefined;
		const result = await host.run(
			"model.context",
			context,
			async (input) => {
				seen = input;
				return input;
			},
			settlePrompt,
		);
		expect(seen?.sections.map((section) => section.id)).toEqual(["workspace", "extension"]);
		expect(seen?.systemPrompt).toBe("W\n\nOUTER");
		expect(result.systemPrompt).toBe("W\n\nOUTER\n\nAFTER");
		await rm(dir, { recursive: true, force: true });
	});
});
