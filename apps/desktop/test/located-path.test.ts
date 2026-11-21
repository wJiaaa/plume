import assert from "node:assert/strict";
import { test } from "vitest";

test("会话删掉了：存下的路径结论里它的那几条一起清掉，别的会话的留着", async () => {
	const entries = new Map<string, string>([
		[
			"plume.located-paths",
			JSON.stringify([
				["gone\0src/a.ts", ["/w/src/a.ts"]],
				["kept\0src/b.ts", ["/w/src/b.ts"]],
			]),
		],
	]);
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => entries.set(key, value),
			removeItem: (key: string) => entries.delete(key),
		},
	});
	try {
		// 模块加载时读一次存下的那份，所以先放好 localStorage 再引。
		const { forgetLocatedPaths } = await import("../src/renderer/markdown/located-path.ts");
		forgetLocatedPaths((sessionId) => sessionId === "gone");
		assert.deepEqual(JSON.parse(entries.get("plume.located-paths")!), [["kept\0src/b.ts", ["/w/src/b.ts"]]]);
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});
