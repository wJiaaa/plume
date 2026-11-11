/**
 * Windows 上保存定义：杀毒、索引程序刚看到文件写出时会开着它一会儿，这时 rename 被拒（EPERM、EBUSY）。这只在 Windows 上、
 * 也只在那一瞬间发生，按需复现不了，所以平台和拒绝都是假的。
 */

import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentDefinitions } from "../src/definitions.ts";
import { MESSAGES } from "../src/messages.ts";

const text = MESSAGES.en;

function asWindows(t: TestContext): void {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform);
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	t.after(() => Object.defineProperty(process, "platform", platform));
}

/** 往名叫 `target` 的文件上 rename 时先拒 `times` 次，之后真的 rename。 */
function refuseRenames(t: TestContext, target: string, code: string, times: number): { refused: () => number } {
	const real = fsPromises.rename;
	let refused = 0;
	const mocked = t.mock.method(fsPromises, "rename", async (from: string, to: string) => {
		if (basename(to) === target && refused < times) {
			refused += 1;
			throw Object.assign(new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`), { code });
		}
		return real(from, to);
	});
	// 内置模块的具名导入绑的是一份拷贝，这一步才把它们指到假的上面。
	syncBuiltinESMExports();
	t.after(() => {
		mocked.mock.restore();
		syncBuiltinESMExports();
	});
	return { refused: () => refused };
}

test("Windows 上保存时一时被拒，等一下重试，不算失败", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "plume-agent-defs-windows-"));
	const home = join(root, "home");
	mkdirSync(home);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const definitions = new AgentDefinitions(
		home,
		() => text,
		async () => {},
	);
	const draft = { name: "helper", description: "Helps", prompt: "Help out", tools: ["read"] as string[] | "*" };
	await definitions.save(null, { scope: "user", draft }, ["read"]);
	const record = (await definitions.list(null)).find((entry) => entry.definition.name === "helper");
	assert.ok(record);

	asWindows(t);
	const { refused } = refuseRenames(t, "helper.md", "EPERM", 2);
	await definitions.save(null, { id: record.id, revision: record.revision, scope: "user", draft: { ...draft, prompt: "Saved again." } }, ["read"]);
	assert.equal(refused(), 2, "前提：前两次 rename 被拒了");
	assert.match(readFileSync(join(home, "agents", "helper.md"), "utf8"), /Saved again\./);
});
