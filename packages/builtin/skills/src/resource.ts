/**
 * `skill://<名字>` 是技能正文本身；`skill://<名字>/` 列出它的目录；`skill://<名字>/<路径>` 是目录里的一个文件。经 `ctx.resources` 登记。
 *
 * 只读。读一个技能和用一个技能是两件事：`skill` 工具把正文当作模型接下来要照做的指示交回去，这里交回的是它在看的一段字。
 * 「查一下」和「照着做」不是同一个要求，所以两样都留着。
 */

import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Resource, ResourceAddress, ResourceEntry, ResourceHandler, ResourceScope } from "@plume/contract";
import { expandSkillPaths, type Skill } from "./loader.ts";

/** 解析地址时按工作目录现读技能：和 `skill` 工具看到的是同一份（关掉的不算）。 */
export type SkillsFor = (cwd: string) => Promise<Skill[]>;

export function skillResource(skillsFor: SkillsFor): ResourceHandler {
	return {
		scheme: "skill",
		/*
		 * 三种写法，各配上它是干什么的。先点名光秃秃的那一种：只说「技能正文」再列写法的话，弱一点的模型会读成「技能是个目录」，
		 * 去找没人提过的 `skill://pdf-extract/README.md`，再回到磁盘上猜文件名。
		 */
		// i18n-exempt：写进系统提示词、给模型看的。
		describe:
			"`skill://<名字>` 是技能正文本身；`skill://<名字>/` 列出它的目录里有什么（子目录同样以 `/` 结尾，如 `skill://<名字>/references/`）；`skill://<名字>/<文件名>` 读目录里的某个文件",

		async resolve(url, scope): Promise<Resource> {
			const { skill, rest, target } = await skillTarget(url, scope, skillsFor);
			const where = rest.join("/");

			// 末尾带 `/` 是问目录里有什么，不管第几层：只能读不能列的话，「这个技能有哪些文件」没有答案，模型只好去走文件系统。
			if (url.path.endsWith("/")) {
				const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
				// i18n-exempt：交给模型的工具结果。
				if (!entries) throw new Error(`技能“${skill.name}”里没有 ${where}/ 这个目录。`);
				const prefix = `skill://${[skill.name, ...rest].join("/")}/`;
				const listing = entries.map((entry) => `- ${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n");
				// i18n-exempt：交给模型的工具结果。
				const empty = rest.length === 0 ? `（技能“${skill.name}”的目录里没有别的文件）` : `（技能“${skill.name}”的 ${where}/ 是空的）`;
				return {
					url: url.raw,
					content: listing || empty,
					contentType: "text/markdown",
					// i18n-exempt：交给模型的工具结果。
					label: rest.length === 0 ? `技能“${skill.name}”目录里的全部文件` : `技能“${skill.name}”的 ${where}/ 里的全部文件`,
					meta: { name: skill.name, dir: target },
				};
			}

			if (rest.length === 0) {
				return {
					url: url.raw,
					// 和 `skill` 工具交给模型的那份一样，路径变量已经换好。
					content: expandSkillPaths(skill),
					contentType: "text/markdown",
					// i18n-exempt：交给模型的工具结果。
					label: `技能“${skill.name}”的完整正文`,
					meta: { name: skill.name, dir: skill.dir, scope: skill.scope },
				};
			}

			const content = await readFile(target, "utf8").catch(() => null);
			// i18n-exempt：交给模型的工具结果。
			if (content === null) throw new Error(`技能“${skill.name}”里没有 ${where}。`);
			return {
				url: url.raw,
				content,
				contentType: "text/plain",
				// i18n-exempt：交给模型的工具结果。
				label: `技能“${skill.name}”目录里 ${where} 的完整内容`,
				meta: { name: skill.name, file: target },
			};
		},

		async list(scope): Promise<ResourceEntry[]> {
			// 只给人点的技能不列：列出来就是让模型自己挑。
			return (await skillsFor(scope.cwd)).filter((s) => !s.manualOnly).map((s) => ({ value: `skill://${s.name}`, description: s.description }));
		},

		// `ls skill://x/references` 和 `read skill://x/references/` 指同一处、守同一道边界。光秃秃的 `skill://` 是技能的目录，不在磁盘上。
		async locate(url, scope) {
			if (url.segments.length === 0) return null;
			return (await skillTarget(url, scope, skillsFor)).target;
		},
	};
}

/** 技能目录里的一条路径，字面和真实落点都得在目录里。`skill://<名字>` 本身落在技能目录上。 */
async function skillTarget(url: ResourceAddress, scope: ResourceScope, skillsFor: SkillsFor): Promise<{ skill: Skill; rest: string[]; target: string }> {
	const skills = await skillsFor(scope.cwd);
	const [name, ...rest] = url.segments;
	const skill = skills.find((s) => s.name === name);
	if (!skill) {
		// i18n-exempt：交给模型的工具结果。
		const available = skills.map((s) => s.name).join("、");
		throw new Error(`没有叫“${name}”的技能。现有的是：${available || "（一个都没有）"}`);
	}
	const child = rest.join("/");
	const target = isAbsolute(child) ? null : resolve(skill.dir, child);
	// i18n-exempt：交给模型的工具结果。
	if (!target || !inside(resolve(skill.dir), target)) throw new Error(`\`${url.raw}\` 指到了技能目录外面。`);
	// 顺着软链再查一遍：技能目录里一条指向外面的软链，字面路径没出去，读却出去了。
	const [realRoot, realTarget] = await Promise.all([realpath(skill.dir).catch(() => skill.dir), realpath(target).catch(() => null)]);
	// i18n-exempt：交给模型的工具结果。
	if (realTarget !== null && !inside(realRoot, realTarget)) throw new Error(`\`${url.raw}\` 经过软链后指到了技能目录外面。`);
	return { skill, rest, target };
}

/** `target` 是 `root` 自己或在它下面。 */
function inside(root: string, target: string): boolean {
	const step = relative(root, target);
	return step === "" || (step !== ".." && !step.startsWith(`..${sep}`) && !isAbsolute(step));
}
