/**
 * `PLUME_SMOKE_ONLY=changed`：按改了哪些文件挑要跑的段，改动小时不用整轮都跑。
 *
 * 改动是相对 PLUME_SMOKE_BASE（缺省 HEAD，即还没提交的改动；在分支上可设成 main）的差异，加上没跟踪的新文件。挑法：
 * - 文档、spec、单元测试、检查脚本：不用跑冒烟；
 * - 某一段自己的冒烟文件（`smoke-<x>.ts`）：用到它、或用到间接引用它的冒烟文件的那几段；smoke.ts 在各段之前的公共开头里
 *   用到的（每段都靠它），全跑；
 * - 只给某一段用的测试插件（`packages/testing/<目录>`，见 `TESTING`）：那一段；
 * - 其余（界面、主进程、本体、内置插件、共用的包、smoke.ts 本身……）：哪段都可能受影响，全跑。
 * 段用到哪些冒烟文件从 smoke.ts 里读：每段是一个 `if (process.env.PLUME_SMOKE_ONLY === "<段名>") { … }`，主流程是最后那一长串，
 * 第一段之前是公共开头。冒烟文件之间互相引用（`smoke-kit.ts` 几乎人人用），所以按引用关系把改动传开，不只看 smoke.ts 直接用的。
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** packages/testing/ 下的测试插件只有这几段装：目录名 → 段名。 */
const TESTING = { "steward-probe": "steward" };

const SKIP = [/\.md$/, /^spec\//, /^docs\//, /(^|\/)test\//, /\.test\.[cm]?[jt]sx?$/, /^scripts\/check-[^/]+\.mjs$/, /^\.github\//];

/** 返回要跑的段名和每段为什么要跑；`known` 是能跑的全部段（含 main）。 */
export function changedSuites(repo, entry, known, changed = changedFiles(repo)) {
	const base = process.env.PLUME_SMOKE_BASE || "HEAD";
	const { usage, shared } = suiteUsage(repo, entry, known);
	const importers = smokeImporters(join(repo, entry, ".."));
	const picked = new Map();
	const add = (suite, why) => {
		if (!picked.has(suite)) picked.set(suite, why);
	};
	for (const path of changed) {
		if (SKIP.some((pattern) => pattern.test(path))) continue;
		const probe = TESTING[/^packages\/testing\/([^/]+)\//.exec(path)?.[1]];
		if (probe && known.includes(probe)) {
			add(probe, path);
			continue;
		}
		const own = /^apps\/desktop\/src\/main\/(smoke-[^/]+\.ts)$/.exec(path);
		if (own) {
			const touched = affected(own[1], importers);
			const users = [...touched].some((file) => shared.has(file))
				? known
				: known.filter((suite) => [...touched].some((file) => usage.get(suite)?.files.has(file)));
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

/** 冒烟文件之间的引用：键是一个冒烟文件，值是直接引用它的那些。 */
function smokeImporters(dir) {
	const importers = new Map();
	for (const name of readdirSync(dir).filter((file) => /^smoke-[^/]+\.ts$/.test(file))) {
		for (const match of readFileSync(join(dir, name), "utf8").matchAll(/from "\.\/(smoke-[^"]+\.ts)"/g)) {
			if (!importers.has(match[1])) importers.set(match[1], new Set());
			importers.get(match[1]).add(name);
		}
	}
	return importers;
}

/** 改了 file 会波及的冒烟文件：它自己，和直接、间接引用它的。 */
function affected(file, importers) {
	const seen = new Set([file]);
	const queue = [file];
	while (queue.length > 0) {
		for (const next of importers.get(queue.shift()) ?? []) {
			if (seen.has(next)) continue;
			seen.add(next);
			queue.push(next);
		}
	}
	return seen;
}

/** 每段用到的冒烟文件，和第一段之前的公共开头用到的（`shared`）。 */
function suiteUsage(repo, entry, known) {
	const source = readFileSync(join(repo, entry), "utf8");
	const imports = new Map();
	for (const match of source.matchAll(/^import \{([^}]+)\} from "\.\/(smoke-[^"]+\.ts)";$/gm))
		for (const name of match[1].split(",")) imports.set(name.trim().replace(/^type /, ""), match[2]);
	// 引用语句本身点了每个名字，先拿掉；剩下的提到名字就算用到（调用、当值传、读常量都算）。
	const lines = source.replace(/^import [\s\S]*? from "[^"]+";$/gm, "").split("\n");
	const describe = (text) => ({ files: new Set([...imports].filter(([name]) => new RegExp(`\\b${name}\\b`).test(text)).map(([, file]) => file)) });
	/** `\t\tif (…) {` 到同一缩进的 `\t\t}`。 */
	const block = (start) => {
		const end = lines.findIndex((line, index) => index > start && line === "\t\t}");
		return lines.slice(start, end + 1).join("\n");
	};
	const usage = new Map();
	const starts = [];
	for (const suite of known) {
		if (suite === "main") continue;
		const literal = `PLUME_SMOKE_ONLY === "${suite}"`;
		let start = lines.findIndex((line) => line.startsWith("\t\tif (") && line.includes(literal));
		if (start < 0) {
			// 段名先存进变量（`const sessionMenuOnly = … === "session-menu"`），再在 if 里用变量。
			const variable = /const (\w+) = /.exec(lines.find((line) => line.includes(literal)) ?? "")?.[1];
			if (variable) start = lines.findIndex((line) => line.startsWith("\t\tif (") && new RegExp(`\\b${variable}\\b`).test(line));
		}
		if (start >= 0) {
			usage.set(suite, describe(block(start)));
			starts.push(start);
		}
	}
	const guard = lines.findIndex((line) => line.includes("if (process.env.PLUME_SMOKE_ONLY) throw"));
	usage.set("main", describe(lines.slice(guard).join("\n")));
	const first = Math.min(...starts, guard);
	return { usage, shared: describe(lines.slice(0, first).join("\n")).files };
}
