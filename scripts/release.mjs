#!/usr/bin/env node
/**
 * 发一个版本，一条命令：改版本号、生成 CHANGELOG、提交、打 tag、推送。
 *
 * 这几步每一步都简单，写成清单就总有一步被忘掉（版本号漏改一份最常见），所以合成一个脚本。
 *
 *   pnpm release patch                 补丁位 +1
 *   pnpm release minor|major
 *   pnpm release 0.2.0                 指定版本
 *   pnpm release patch --no-push       改完、提交、打好 tag，不推：本地看一眼、改好发版文案再推
 *
 * 推 `v*` tag 会触发 CI 打安装包（`.github/workflows/package.yml`）。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { MANIFESTS, ROOT, SOURCE, readVersion, writeVersion } from "./versions.mjs";

const run = promisify(execFile);
const CHANGELOG = "CHANGELOG.md";

/** 跑一条命令，失败就带着它的输出停下：这里没有哪一步值得失败了还往下走。 */
async function must(file, args) {
	try {
		const { stdout } = await run(file, args, { cwd: ROOT, shell: process.platform === "win32" });
		return stdout.trim();
	} catch (error) {
		fail(`${file} ${args.join(" ")} 失败\n${error.stderr || error.stdout || error.message}`);
	}
}

/** 跑一条命令，失败了答 null：用在「没有就算了」的查询上（还没打过 tag、没有远端）。 */
async function maybe(file, args) {
	try {
		return (await run(file, args, { cwd: ROOT })).stdout.trim();
	} catch {
		return null;
	}
}

function fail(message) {
	console.error(`\n✖ ${message}\n`);
	process.exit(1);
}

function note(message) {
	console.log(`  ${message}`);
}

/** 下一个版本：按 patch / minor / major 算，或者直接给的 x.y.z。 */
function nextVersion(current, request) {
	if (/^\d+\.\d+\.\d+$/.test(request)) {
		const [a, b] = [request, current].map((v) => v.split(".").map(Number));
		const bigger = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
		if (!bigger) fail(`${request} 不比当前的 ${current} 大`);
		return request;
	}
	const [major, minor, patch] = current.split(".").map(Number);
	if (request === "major") return `${major + 1}.0.0`;
	if (request === "minor") return `${major}.${minor + 1}.0`;
	if (request === "patch") return `${major}.${minor}.${patch + 1}`;
	fail(`不认识的版本参数：${request}。用 patch / minor / major 或 x.y.z`);
}

/**
 * 打 tag 之前必须成立的事。
 *
 * 一开始就全查完，不边做边查：查到一半失败时工作区还是原样，不会留下改了一半的版本号。
 */
async function preflight(current, push) {
	const dirty = await must("git", ["status", "--porcelain"]);
	if (dirty) fail(`工作区不干净，先提交或收起这些改动：\n${dirty}`);

	const drifted = [];
	for (const relative of MANIFESTS) {
		const version = await readVersion(relative);
		if (version !== current) drifted.push(`${relative}：${version}`);
	}
	if (drifted.length > 0) fail(`这几份的版本号和 ${SOURCE}（${current}）对不上，先改齐：\n${drifted.join("\n")}`);

	if (!push) return;
	// 只往远端的默认分支上发：从功能分支打出去的 tag，指着一个之后不会合进去的提交。
	const head = await maybe("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (!head) fail("没有远端 origin（或不知道它的默认分支）。先配好远端，或者加 --no-push。");
	const main = head.replace(/^origin\//, "");
	const branch = await must("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch !== main) fail(`发版要在 ${main} 上，当前是 ${branch}`);
	await must("git", ["fetch", "--quiet", "origin", main]);
	const ahead = await must("git", ["rev-list", "--count", `origin/${main}..HEAD`]);
	const behind = await must("git", ["rev-list", "--count", `HEAD..origin/${main}`]);
	if (ahead !== "0" || behind !== "0") fail(`本地与 origin/${main} 不一致（领先 ${ahead}，落后 ${behind}）。先推或先拉。`);
	return main;
}

async function main() {
	const args = process.argv.slice(2);
	const request = args[0];
	if (!request || request.startsWith("-")) fail("用法：pnpm release <patch|minor|major|x.y.z> [--no-push]");
	const push = !args.includes("--no-push");

	const current = await readVersion(SOURCE);
	const version = nextVersion(current, request);
	const tag = `v${version}`;
	console.log(`\n${current} → ${version}\n`);

	const branch = await preflight(current, push);
	if (await maybe("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])) fail(`${tag} 已经存在`);

	note(`写版本号（${MANIFESTS.length} 处）`);
	for (const relative of MANIFESTS) await writeVersion(relative, version);

	note("生成 CHANGELOG");
	// 还没打过 tag 时从头算起。
	const previous = await maybe("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]);
	const section = await must("pnpm", ["exec", "git-cliff", ...(previous ? [`${previous}..HEAD`] : []), "--tag", tag, "--unreleased", "--strip", "header"]);
	const changelogPath = join(ROOT, CHANGELOG);
	const existing = existsSync(changelogPath) ? await readFile(changelogPath, "utf8") : "";
	/*
	 * 插在开头那段说明下面、最新一个版本上面，而不是文件最顶上：说明这个文件是什么的那段一直在最前面。
	 * 文件还没有时，开头那段取 cliff.toml 的 header。
	 */
	const firstVersion = existing.indexOf("\n## [");
	const head = existing ? (firstVersion === -1 ? existing.trimEnd() : existing.slice(0, firstVersion)) : await cliffHeader();
	const rest = firstVersion === -1 ? "" : existing.slice(firstVersion + 1);
	const added = section.slice(section.indexOf("## ["));
	if (!added.startsWith("## [")) fail(`git-cliff 没生成 ${tag} 这一节：从上个版本到现在没有会进 CHANGELOG 的提交（feat、fix、perf、refactor、docs、revert）。`);
	await writeFile(changelogPath, `${`${head.trimEnd()}\n\n${added.trim()}\n\n${rest}`.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`);

	note("提交");
	await must("git", ["add", "--", ...MANIFESTS, CHANGELOG]);
	await must("git", ["commit", "-m", `chore(release): ${tag}`]);

	note("打 tag");
	const message = await must("node", ["scripts/changelog-section.mjs", tag]);
	await must("git", ["tag", "-a", tag, "-m", message]);

	if (!push) {
		console.log(
			[
				"",
				"没有推送。CHANGELOG 里生成的是提交列表，发版文案要手写（见 AGENTS.md 的 pnpm release 一行）；改完重新提交、重打 tag：",
				`  git commit --amend --no-edit -- ${CHANGELOG} && git tag -f -a ${tag} -m "$(node scripts/changelog-section.mjs ${tag})"`,
				"推送：",
				`  git push origin HEAD && git push origin ${tag}`,
				"撤销：",
				`  git reset --hard HEAD~1 && git tag -d ${tag}`,
				"",
			].join("\n"),
		);
		return;
	}

	note("推送");
	await must("git", ["push", "origin", branch]);
	await must("git", ["push", "origin", tag]);
	console.log(`\n✓ ${tag} 已推送。\n`);
}

/** cliff.toml 里 `header = """…"""` 那一段。 */
async function cliffHeader() {
	const config = await readFile(join(ROOT, "cliff.toml"), "utf8");
	const match = /^header = """\n([\s\S]*?)"""/m.exec(config);
	if (!match) fail("cliff.toml 里找不到 header");
	return match[1];
}

await main();
