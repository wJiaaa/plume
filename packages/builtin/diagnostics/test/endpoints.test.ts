/**
 * 环境卡片里后台任务的端口：系统表的解析、进程树、输出里打印的地址。
 */

import { expect, it } from "vitest";
import { advertisedEndpoints, descendants, parseLsof, parseProcesses, parseSs, parseWindowsListeners, serviceUrl } from "../src/endpoints.ts";

it("端口：系统表保留 IPv4/IPv6，只认这个任务进程树里的", () => {
	const tree = parseProcesses(" 10 1\n20 10\n30 20\n40 1\n");
	expect([...descendants(10, tree)]).toEqual([10, 20, 30]);
	expect(parseLsof("p30\nn*:3000\nn[::1]:8080\np40\nn127.0.0.1:9999")).toEqual([
		{ pid: 30, address: "*", port: 3000 },
		{ pid: 30, address: "::1", port: 8080 },
		{ pid: 40, address: "127.0.0.1", port: 9999 },
	]);
	expect(parseSs('LISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=30,fd=8))')).toEqual([{ pid: 30, address: "127.0.0.1", port: 3000 }]);
	expect(parseWindowsListeners({ processes: [{ pid: 2, parent: 1 }], listeners: [{ pid: 2, address: "::", port: 5173 }] }, "bad").listeners).toEqual([
		{ pid: 2, address: "::", port: 5173 },
	]);
	expect(() => parseWindowsListeners({ processes: [], listeners: [{ pid: "2", address: "::", port: 80 }] }, "bad")).toThrow("bad");
});

it("端口：输出里的地址要对得上本机监听；系统表缺席时用它自己打印的本机地址", () => {
	const endpoint = { pid: 20, address: "0.0.0.0", port: 3000 };
	expect(serviceUrl(endpoint, "docs https://example.com:3000/\nserver http://localhost:3000/app")).toBe("http://127.0.0.1:3000/app");
	expect(serviceUrl(endpoint, "http://localhost:4000/")).toBeUndefined();
	expect(advertisedEndpoints(20, "started\nhttp://127.0.0.1:5173/\n")).toEqual([{ pid: 20, address: "127.0.0.1", port: 5173, url: "http://127.0.0.1:5173/" }]);
	expect(advertisedEndpoints(20, "http://localhost:3000/app\nhttps://example.com:3000/\nhttp://127.0.0.1/")).toEqual([
		{ pid: 20, address: "127.0.0.1", port: 3000, url: "http://127.0.0.1:3000/app" },
	]);
	expect(advertisedEndpoints(0, "http://127.0.0.1:5173/")).toEqual([]);
});
