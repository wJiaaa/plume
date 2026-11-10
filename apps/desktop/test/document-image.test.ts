import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocumentImageLoader } from "../src/main/document-image.ts";

const picture = () => new Response("pixels", { headers: { "content-type": "image/png" } });

test("同一图片合并请求并缓存成功结果", async () => {
	let calls = 0;
	const api = createDocumentImageLoader(async () => {
		calls++;
		return picture();
	});
	const values = await Promise.all([api("https://images.test/a"), api("https://images.test/a")]);
	assert.deepEqual(values, ["data:image/png;base64,cGl4ZWxz", "data:image/png;base64,cGl4ZWxz"]);
	assert.equal(await api("https://images.test/a"), values[0]);
	assert.equal(calls, 1);
});

test("拒绝非 HTTPS、凭据及重定向降级，跟随合法相对跳转", async () => {
	const calls: string[] = [];
	const api = createDocumentImageLoader(async (url, init) => {
		assert.equal(init?.credentials, "omit");
		assert.equal(init?.redirect, "manual");
		calls.push(url);
		if (url.endsWith("/bad")) return new Response(null, { status: 302, headers: { location: "http://images.test/a" } });
		if (url.endsWith("/redirect")) return new Response(null, { status: 302, headers: { location: "/good" } });
		return picture();
	});
	for (const url of ["file:///secret.png", "http://images.test/a", "https://user:pass@images.test/a", "not a url", null]) {
		assert.equal(await api(url), null);
	}
	assert.equal(calls.length, 0);
	assert.equal(await api("https://images.test/bad"), null);
	assert.ok(await api("https://images.test/redirect"));
	assert.deepEqual(calls, ["https://images.test/bad", "https://images.test/redirect", "https://images.test/good"]);
});

test("拒绝非图、空响应、错误状态和无限重定向", async () => {
	for (const response of [new Response("html"), new Response(null, { headers: { "content-type": "image/png" } }), new Response("missing", { status: 404 })]) {
		assert.equal(await createDocumentImageLoader(async () => response)("https://images.test/a"), null);
	}
	let calls = 0;
	const api = createDocumentImageLoader(async () => {
		calls++;
		return new Response(null, { status: 302, headers: { location: "/loop" } });
	});
	assert.equal(await api("https://images.test/loop"), null);
	assert.equal(calls, 6);
});

test("大小限制同时检查声明和实际流量，超限取消读取", async () => {
	for (const declared of [true, false]) {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(3 * 1024 * 1024));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { "content-type": "image/png", ...(declared ? { "content-length": "6000000" } : {}) } },
		);
		assert.equal(await createDocumentImageLoader(async () => response)("https://images.test/large"), null);
		assert.equal(cancelled, true);
	}
});

test("失败一分钟后重试，下载异常不抛给界面", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1000 });
	let calls = 0;
	const api = createDocumentImageLoader(async () => {
		if (++calls === 1) throw new Error("offline");
		return picture();
	});
	assert.equal(await api("https://images.test/retry"), null);
	assert.equal(await api("https://images.test/retry"), null);
	assert.equal(calls, 1);
	t.mock.timers.tick(60_001);
	assert.ok(await api("https://images.test/retry"));
	assert.equal(calls, 2);
});

test("最多同时下载六张，结束后释放排队请求", async () => {
	let active = 0;
	let max = 0;
	const api = createDocumentImageLoader(async () => {
		max = Math.max(max, ++active);
		await new Promise((resolve) => setTimeout(resolve, 1));
		active--;
		return picture();
	});
	assert.ok((await Promise.all(Array.from({ length: 15 }, (_, i) => api(`https://images.test/${i}`)))).every(Boolean));
	assert.equal(max, 6);
});
