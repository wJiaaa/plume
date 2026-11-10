import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { classifyFailure, failureOf, worthRetrying } from "../src/ai/failure.ts";
import { RetryBudget, fetchWithRetry, retryStream } from "../src/ai/retry.ts";
import { DEFAULT_RETRY_POLICY } from "../src/config/retry-policy.ts";

/*
 * 发请求之前就注定失败的那些。
 *
 * 它们从 fetch 里抛出来，于是被当成「没见过的连接问题」归到 network——而 network 可以设成无限重试。
 * 密钥里混进一个零宽字符，界面就在「重连中」里一直转下去，可这个请求连发都没发出去。
 */

const noSleep = async () => {};

/** 真的 fetch 抛出来的错误，而不是照着样子捏的：形状（有没有 cause、cause 上有没有 code）才是要点。 */
async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	assert.fail("应当抛错");
}

async function withHttpServer<T>(run: (port: number) => Promise<T>): Promise<T> {
	const server: Server = createServer((_request, response) => response.end("plain http"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		return await run((server.address() as AddressInfo).port);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

/** 经 `fetchWithRetry` 发出去，默认策略（network 无限）。返回发了几次和最后抛出的那个。 */
async function sendOnce(init: RequestInit, url = "http://127.0.0.1:9/"): Promise<{ calls: number; error: unknown }> {
	let calls = 0;
	const error = await thrownBy(() =>
		fetchWithRetry(
			(input, options) => {
				calls++;
				// 逃生阀：判错时这里是真的无限转。抛异常会被当成断线接着重试，所以答一个终局的状态码。
				if (calls > 5) return Promise.resolve(new Response("重试没停下来", { status: 401 }));
				return fetch(input, options);
			},
			url,
			init,
			{ budget: new RetryBudget(DEFAULT_RETRY_POLICY), sleep: noSleep },
		),
	);
	return { calls, error };
}

test("密钥里混进零宽或全角字符：一次都不重发，提示去看密钥", async () => {
	const { calls, error } = await sendOnce({ headers: { authorization: "Bearer sk-\u200babc\uff21" } });
	assert.equal(calls, 1);
	const failure = failureOf(error);
	assert.equal(failure.kind, "fatal");
	assert.equal(failure.hint, "check-key");
	assert.match(failure.detail ?? "", /ByteString/, "原文留着，人才知道是哪个字符");
});

test("请求头里带换行：一次都不重发", async () => {
	const { calls, error } = await sendOnce({ headers: { "x-api-key": "abc\ndef" } });
	assert.equal(calls, 1);
	assert.equal(failureOf(error).kind, "fatal");
	assert.equal(failureOf(error).hint, "check-key");
});

test("https 连只开了 http 的本地服务：协议对不上，不是断线", async () => {
	await withHttpServer(async (port) => {
		const { calls, error } = await sendOnce({}, `https://127.0.0.1:${port}/`);
		assert.equal(calls, 1);
		const failure = failureOf(error);
		assert.equal(failure.kind, "fatal");
		assert.equal(failure.hint, "check-model");
	});
});

test("不认识的协议：接口地址写错了", async () => {
	const { calls, error } = await sendOnce({}, "ftp://127.0.0.1/");
	assert.equal(calls, 1);
	assert.equal(failureOf(error).kind, "fatal");
	assert.equal(failureOf(error).summary, "接口地址无效");
});

test("证书链缺一环、链里有自签：证书问题，不重试", () => {
	for (const code of ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_GET_ISSUER_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_NOT_YET_VALID"]) {
		const failure = classifyFailure({ from: "transport", error: new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }) });
		assert.equal(failure.kind, "fatal", `${code} 应当直接报错`);
		assert.equal(failure.summary, "证书校验失败");
	}
});

test("证书和 TLS 的码藏在 cause 链里层、或是名单外的新名字，照样不重试", () => {
	const nested = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error("socket error"), { cause: Object.assign(new Error(code), { code }) }) });
	const flat = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
	for (const error of [nested("CERT_HAS_EXPIRED"), flat("CERT_REVOKED"), flat("ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED"), flat("ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN")]) {
		const failure = classifyFailure({ from: "transport", error });
		assert.equal(failure.kind, "fatal", String((error as Error & { cause: Error }).cause.message));
		assert.equal(failure.summary, "证书校验失败");
	}
	// 握手超时、握手时的临时告警是网络在抖，不是证书坏了。
	for (const code of ["ERR_TLS_HANDSHAKE_TIMEOUT", "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC"]) {
		assert.equal(classifyFailure({ from: "transport", error: flat(code) }).kind, "network", code);
	}
});

test("代理要认证（407）不重试，提示去看代理；代理别的状态照旧当断线", () => {
	const proxy = (status: number) =>
		new TypeError("fetch failed", { cause: Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), { code: "UND_ERR_ABORTED" }) });
	const failure = classifyFailure({ from: "transport", error: proxy(407), sending: true });
	assert.equal(failure.kind, "fatal");
	assert.match(failure.summary, /代理/);
	assert.equal(classifyFailure({ from: "transport", error: proxy(502), sending: true }).kind, "network");
});

test("真正的断线照旧是 network、照旧重试", () => {
	const cases: unknown[] = [
		new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }),
		new TypeError("fetch failed", { cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }) }),
		new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }),
		new TypeError("terminated", { cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }) }),
	];
	for (const error of cases) {
		for (const sending of [false, true]) {
			const failure = classifyFailure({ from: "transport", error, sending });
			assert.equal(failure.kind, "network", `${(error as Error).message} 应当算断线`);
			assert.equal(worthRetrying(failure), true);
		}
	}
});

test("流里由解码代码自己抛的 TypeError 不算「请求发不出去」，照旧重试", async () => {
	// 中转发来一帧形状不对的 JSON，解码时 `undefined.choices` 抛了——换一次响应可能就好了。
	let calls = 0;
	const stream = retryStream(
		async function* () {
			calls++;
			if (calls === 1) throw new TypeError("Cannot read properties of undefined (reading 'choices')");
			yield "ok";
		},
		{ budget: new RetryBudget(DEFAULT_RETRY_POLICY), reset: () => {}, sleep: noSleep },
	);
	const seen: string[] = [];
	for await (const value of stream) seen.push(value);
	assert.deepEqual(seen, ["ok"]);
	assert.equal(calls, 2);
});

test("请求发不出去的结论穿过 retryStream 不会被重新猜成断线", async () => {
	let attempts = 0;
	let sent = 0;
	const budget = new RetryBudget(DEFAULT_RETRY_POLICY);
	const stream = retryStream(
		async function* () {
			attempts++;
			// 逃生阀：判错时内外两层都会无限转。
			if (attempts > 3) return;
			await fetchWithRetry(
				(input, init) => {
					if (++sent > 3) return Promise.resolve(new Response("重试没停下来", { status: 401 }));
					return fetch(input, init);
				},
				"http://127.0.0.1:9/",
				{ headers: { authorization: "Bearer \u200b" } },
				{ budget, sleep: noSleep },
			);
			yield "unreachable";
		},
		{ budget, reset: () => {}, sleep: noSleep },
	);
	await assert.rejects(async () => {
		for await (const _ of stream) assert.fail("不该产出");
	});
	assert.equal(sent, 1);
	assert.equal(attempts, 1);
});

test("undici 拒收地址的原话包在第二层 cause 里也认得出：不当断线重试", () => {
	const error = new TypeError("fetch failed", { cause: new Error("socket wrapper", { cause: new Error("bad port") }) });
	const failure = classifyFailure({ from: "transport", error });
	assert.equal(failure.kind, "fatal");
	assert.equal(failure.summary, "接口地址无效");
});
