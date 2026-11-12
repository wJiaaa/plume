import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedSuites } from "../smoke-changed.mjs";

const ENTRY = "apps/desktop/src/main/smoke.ts";

/** 一份最小的冒烟：公共开头用 kit，a 段用 a，b 段用 b，主流程用 main；b 引用 deep。 */
function fixture(): string {
	const repo = mkdtempSync(join(tmpdir(), "plume-smoke-changed-"));
	const dir = join(repo, "apps/desktop/src/main");
	mkdirSync(dir, { recursive: true });
	const files: Record<string, string> = {
		"smoke-kit.ts": "export const wait = () => {};\n",
		"smoke-a.ts": "export function runA() {}\n",
		"smoke-deep.ts": "export const DEEP = 1;\n",
		"smoke-b.ts": 'import { DEEP } from "./smoke-deep.ts";\nexport function runB() { return DEEP; }\n',
		"smoke-main.ts": "export function runMain() {}\n",
		"smoke.ts": [
			'import { wait } from "./smoke-kit.ts";',
			'import { runA } from "./smoke-a.ts";',
			'import { runB } from "./smoke-b.ts";',
			'import { runMain } from "./smoke-main.ts";',
			"async function smoke() {",
			"\tconst until = () => wait();",
			"\ttry {",
			'\t\tif (process.env.PLUME_SMOKE_ONLY === "a") {',
			"\t\t\trunA();",
			"\t\t}",
			'\t\tif (process.env.PLUME_SMOKE_ONLY === "b") {',
			"\t\t\trunB();",
			"\t\t}",
			'\t\tif (process.env.PLUME_SMOKE_ONLY) throw new Error("unknown");',
			"\t\trunMain();",
			"\t} finally {}",
			"}",
			"",
		].join("\n"),
	};
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return repo;
}

const KNOWN = ["main", "a", "b"];
const picked = (repo: string, file: string): string[] => changedSuites(repo, ENTRY, KNOWN, [`apps/desktop/src/main/${file}`]).suites;

test("段自己的冒烟文件只挑用它的那段", () => {
	const repo = fixture();
	try {
		assert.deepEqual(picked(repo, "smoke-a.ts"), ["a"]);
		assert.deepEqual(picked(repo, "smoke-main.ts"), ["main"]);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("间接引用的冒烟文件跟着引用它的那段走", () => {
	const repo = fixture();
	try {
		assert.deepEqual(picked(repo, "smoke-deep.ts"), ["b"]);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("公共开头用到的冒烟文件每段都靠它，全跑", () => {
	const repo = fixture();
	try {
		assert.deepEqual(picked(repo, "smoke-kit.ts"), KNOWN);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("只给一段用的测试插件只挑那一段", () => {
	const repo = fixture();
	const probe = ["packages/testing/steward-probe/src/ui.tsx"];
	try {
		assert.deepEqual(changedSuites(repo, ENTRY, [...KNOWN, "steward"], probe).suites, ["steward"]);
		// 那一段不在能跑的里（改了名、删了）时不认，照旧全跑。
		assert.deepEqual(changedSuites(repo, ENTRY, KNOWN, probe).suites, KNOWN);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
