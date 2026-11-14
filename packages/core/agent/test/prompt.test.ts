import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelContext, Plugin } from "@plume/contract";
import { PluginHost } from "../src/host.ts";
import { settlePrompt } from "../src/prompt/sections.ts";

describe("systemPrompt 跟着 sections 重拼", () => {
	const sections = [
		{ id: "identity", text: "I" },
		{ id: "workspace", text: "W" },
	];
	const context: ModelContext = {
		sessionId: "s",
		session: { id: "s", kind: "top" },
		cwd: "/",
		scratchDir: "/scratch/s",
		model: { id: "m", name: "M" },
		permissionMode: "auto",
		shell: { kind: "posix", label: "zsh", sandbox: "workspace-write" },
		personalization: { tone: "professional", customInstructions: "" },
		systemPrompt: "I\n\nW",
		sections,
		messages: [],
		tools: [],
	};

	it("按段落重拼字符串；直接改字符串的不作数；没变的原样交回", () => {
		expect(settlePrompt({ ...context, sections: [{ id: "identity", text: "J" }, ...sections.slice(1)] }).systemPrompt).toBe("J\n\nW");
		expect(settlePrompt({ ...context, systemPrompt: "别的" }).systemPrompt).toBe("I\n\nW");
		const same = { ...context };
		expect(settlePrompt(same)).toBe(same);
	});

	it("钩子里外层加一段、里层按段改，每一层读到的字符串都跟得上", async () => {
		const outer: Plugin = {
			name: "outer",
			apply: (ctx) => ctx.hook("model.context", (input, next) => next({ ...input, sections: [...input.sections, { id: "outer", text: "OUTER" }] })),
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
			{ settle: settlePrompt },
		);
		expect(seen?.sections.map((section) => section.id)).toEqual(["workspace", "outer"]);
		expect(seen?.systemPrompt).toBe("W\n\nOUTER");
		expect(result.systemPrompt).toBe("W\n\nOUTER\n\nAFTER");
		await rm(dir, { recursive: true, force: true });
	});
});
