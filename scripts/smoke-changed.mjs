/**
 * `PLUME_SMOKE_ONLY=changed`：按改了哪些文件挑要跑的段，改动小时不用整轮都跑。
 *
 * 改动是相对 PLUME_SMOKE_BASE（缺省 HEAD，即还没提交的改动；在分支上可设成 main）的差异，加上没跟踪的新文件。挑法：
 * - 文档、spec、单元测试、检查脚本：不用跑冒烟；
 * - 某一段自己的冒烟文件（`smoke-<x>.ts`）：用到它的那几段；
 * - 其余（界面、主进程、本体、内置插件、共用的包、smoke.ts 本身……）：哪段都可能受影响，全跑。
 * 段用到哪些冒烟文件从 smoke.ts 里读：每段是一个 `if (process.env.PLUME_SMOKE_ONLY === "<段名>") { … }`，主流程是最后那一长串。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKIP = [/\.md$/, /^spec\//, /^docs\//, /(^|\/)test\//, /\.test\.[cm]?[jt]sx?$/, /^scripts\/check-[^/]+\.mjs$/, /^\.github\//];

/** 返回要跑的段名和每段为什么要跑；`known` 是能跑的全部段（含 main）。 */
export function changedSuites(repo, entry, known, changed = changedFiles(repo)) {
	const base = process.env.PLUME_SMOKE_BASE || "HEAD";
	const usage = suiteUsage(repo, entry, known);
	const picked = new Map();
	const add = (suite, why) => {
		if (!picked.has(suite)) picked.set(suite, why);
	};
	for (const path of changed) {
		if (SKIP.some((pattern) => pattern.test(path))) continue;
		const own = /^apps\/desktop\/src\/main\/(smoke-[^/]+\.ts)$/.exec(path);
		if (own) {
			const users = known.filter((suite) => usage.get(suite)?.files.has(own[1]));
			if (users.length > 0) {
				for (const suite of users) add(suite, path);
				continue;
			}
		}
		for (const suite of known) add(suite, path);
	}
	return { suites: known.filter((suite) => picked.has(suite)), reasons: picked, base, count: changed.length };
}

function changedFiles(repo) {
	const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).split("\n").filter(Boolean);
	return [
		...new Set([...git(repo, "diff", "--name-only", process.env.PLUME_SMOKE_BASE || "HEAD"), ...git(repo, "ls-files", "--others", "--exclude-standard")]),
	];
}

/** 每段用到的冒烟文件。 */
function suiteUsage(repo, entry, known) {
	const source = readFileSync(join(repo, entry), "utf8");
	const lines = source.split("\n");
	const imports = new Map();
	for (const match of source.matchAll(/^import \{([^}]+)\} from "\.\/(smoke-[^"]+\.ts)";$/gm))
		for (const name of match[1].split(",")) imports.set(name.trim().replace(/^type /, ""), match[2]);
	const describe = (text) => ({ files: new Set([...imports].filter(([name]) => new RegExp(`\\b${name}\\(`).test(text)).map(([, file]) => file)) });
	/** `\t\tif (…) {` 到同一缩进的 `\t\t}`。 */
	const block = (start) => {
		const end = lines.findIndex((line, index) => index > start && line === "\t\t}");
		return lines.slice(start, end + 1).join("\n");
	};
	const usage = new Map();
	for (const suite of known) {
		if (suite === "main") continue;
		const literal = `PLUME_SMOKE_ONLY === "${suite}"`;
		let start = lines.findIndex((line) => line.startsWith("\t\tif (") && line.includes(literal));
		if (start < 0) {
			// 段名先存进变量（`const sessionMenuOnly = … === "session-menu"`），再在 if 里用变量。
			const variable = /const (\w+) = /.exec(lines.find((line) => line.includes(literal)) ?? "")?.[1];
			if (variable) start = lines.findIndex((line) => line.startsWith("\t\tif (") && new RegExp(`\\b${variable}\\b`).test(line));
		}
		if (start >= 0) usage.set(suite, describe(block(start)));
	}
	const guard = lines.findIndex((line) => line.includes("if (process.env.PLUME_SMOKE_ONLY) throw"));
	usage.set("main", describe(lines.slice(guard).join("\n")));
	return usage;
}
