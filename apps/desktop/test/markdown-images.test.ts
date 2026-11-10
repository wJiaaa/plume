import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentService } from "@plume/contract";
import type { Remote } from "@plume/rpc";
import { connectFiles, localImageUrl } from "../src/renderer/files/open-file.ts";

test("本地图按原会话读取，修改时间进入媒体地址，不可读保留为空", async () => {
	const calls: string[][] = [];
	let version = 1;
	connectFiles({
		readFile: async (session: string, path: string) => {
			calls.push([session, path]);
			if (path.includes("outside")) return null;
			if (path.includes("failed")) throw new Error("unavailable");
			return { modifiedAt: version };
		},
	} as unknown as Remote<AgentService>);
	const url = await localImageUrl("original", "/project/a b.svg");
	assert.equal(url, "plume-media://f/original/%2Fproject%2Fa%20b.svg?v=1");
	version++;
	assert.equal(await localImageUrl("original", "/project/a b.svg"), "plume-media://f/original/%2Fproject%2Fa%20b.svg?v=2");
	assert.equal(await localImageUrl("other", "/outside.svg"), null);
	assert.equal(await localImageUrl("original", "/failed.svg"), null);
	assert.deepEqual(calls[0], ["original", "/project/a b.svg"]);
	assert.deepEqual(calls[2], ["other", "/outside.svg"]);
});
