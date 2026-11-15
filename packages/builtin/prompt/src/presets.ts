/**
 * 人能换的那一块：身份和准则。内置两套（`BUILTIN_PERSONAS`），人可以复制一份改成自己的；选中的那套给之后新开的会话用。
 *
 * 只认本机：内置的，加上插件数据目录 `presets/<id>.json` 里人在设置页建的。不读仓库里的任何文件——仓库内容不能替换系统提示词，
 * 项目自己的要求写进 AGENTS.md。选中的是哪套记在 `selected.json`。
 *
 * 会话里固定：一个会话第一次带着消息请求时，把那时用的那套连同全文记进 `personas/<会话 id>.json`，之后一直交出这份全文。
 * 本体看到的身份段、准则段一个字都不变，就不补增量，开着的会话前缀照样命中缓存；那套后来被改、被删都不影响它，压缩、撤回以后
 * 本体重新冻结时交出的也还是这份。子会话和分叉第一次请求时用父会话、来源会话记下的那份：子智能体和主会话按同一套准则做事，
 * 分叉和来处说的是同一段对话。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locale, ModelContext, PluginContext } from "@plume/contract";
import { BUILTIN_IDS, type BuiltinId, LIMITS, type PresetDraft, type PresetProblem, type PresetsView, type PresetView } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { BUILTIN_PERSONAS, fixedGuidelines, type Persona } from "./system.ts";

/** id 当文件名用：只认这几种字符，别的不落盘、不读。 */
const SAFE_ID = /^[\w-]+$/;

const isBuiltin = (id: string): id is BuiltinId => (BUILTIN_IDS as readonly string[]).includes(id);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

type StoredPreset = PresetDraft;

/** 会话记下的那一套：哪一套（只给人看日志用）和全文。 */
interface SessionPersona extends Persona {
	presetId: string;
}

/** 存下的一套像不像样：字段都在、没超限、身份不空。读出来不合格的按坏了处理。 */
function wellFormed(value: unknown): value is StoredPreset {
	const preset = value as Partial<StoredPreset> | null;
	return (
		typeof preset?.name === "string" &&
		typeof preset.identity === "string" &&
		typeof preset.guidelines === "string" &&
		preset.name.trim() !== "" &&
		preset.identity.trim() !== "" &&
		bytes(preset.identity) <= LIMITS.identity &&
		bytes(preset.guidelines) <= LIMITS.guidelines
	);
}

async function readJson(file: string): Promise<{ found: false } | { found: true; value: unknown }> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return { found: false };
	}
	try {
		return { found: true, value: JSON.parse(raw) };
	} catch {
		return { found: true, value: undefined };
	}
}

/** 先写到旁边再换过去：写到一半退出的不留半截 JSON。 */
async function writeJson(file: string, value: unknown): Promise<void> {
	await writeFile(`${file}.partial`, `${JSON.stringify(value, null, 2)}\n`);
	await rename(`${file}.partial`, file);
}

export function createPresets(ctx: Pick<PluginContext, "dataDir" | "log" | "locale" | "trash" | "sessions">) {
	const presetsDir = join(ctx.dataDir, "presets");
	const personasDir = join(ctx.dataDir, "personas");
	const selectedFile = join(ctx.dataDir, "selected.json");
	const presetFile = (id: string) => join(presetsDir, `${id}.json`);
	const personaFile = (sessionId: string) => join(personasDir, `${sessionId}.json`);
	const text = () => MESSAGES[ctx.locale() as Locale];
	const held = new Map<string, SessionPersona>();
	/** 上一次记过日志的那个问题：每次请求都会读到同一个坏文件，不每次都记一条。 */
	let warned: string | undefined;

	async function custom(): Promise<Array<PresetView & { name: string }>> {
		const names = await readdir(presetsDir).catch(() => [] as string[]);
		const presets: Array<PresetView & { name: string }> = [];
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const id = name.slice(0, -".json".length);
			if (!SAFE_ID.test(id) || isBuiltin(id)) continue;
			const read = await readJson(presetFile(id));
			if (read.found && wellFormed(read.value)) presets.push({ id, builtin: false, ...read.value });
		}
		return presets;
	}

	async function selectedId(): Promise<string> {
		const read = await readJson(selectedFile);
		const id = read.found ? (read.value as { id?: unknown } | undefined)?.id : undefined;
		return typeof id === "string" && SAFE_ID.test(id) ? id : "general";
	}

	/** 选中的那套，用不了时退回「通用」并说出原因。 */
	async function resolve(): Promise<{ id: string; persona: Persona; problem: PresetProblem | null }> {
		const id = await selectedId();
		if (isBuiltin(id)) return { id, persona: BUILTIN_PERSONAS[id], problem: null };
		const read = await readJson(presetFile(id));
		if (read.found && wellFormed(read.value)) return { id, persona: { identity: read.value.identity, guidelines: read.value.guidelines }, problem: null };
		const problem: PresetProblem = { id, reason: read.found ? "invalid" : "missing" };
		const key = `${problem.id}:${problem.reason}`;
		if (warned !== key) {
			warned = key;
			// i18n-exempt：写给调试的人看的日志。
			ctx.log.warn(`选中的身份与准则「${id}」${problem.reason === "missing" ? "找不到" : "读不出或不合格"}，新会话先用内置的「通用」`);
		}
		return { id: "general", persona: BUILTIN_PERSONAS.general, problem };
	}

	async function view(): Promise<PresetsView> {
		const { id, problem } = await resolve();
		const builtins: PresetView[] = BUILTIN_IDS.map((builtinId) => ({ id: builtinId, builtin: true, ...BUILTIN_PERSONAS[builtinId] }));
		// 固定的几条里有两条跟着权限模式、工作区说，这里按最常见的那种（请求批准、在 git 仓库里）列。
		const fixed = fixedGuidelines({ permissionMode: "auto", isGitRepo: true });
		return { presets: [...builtins, ...(await custom())], selected: id, problem, fixed };
	}

	/** 交上来的一套合不合格：不合格的抛出按界面语言写的原因。`except` 是正在改的那一套自己，不和自己比重名。 */
	async function check(draft: PresetDraft, except: string | undefined): Promise<StoredPreset> {
		const t = text();
		const name = typeof draft?.name === "string" ? draft.name.trim() : "";
		const identity = typeof draft?.identity === "string" ? draft.identity.trim() : "";
		const guidelines = typeof draft?.guidelines === "string" ? draft.guidelines.trim() : "";
		if (name === "") throw new Error(t.nameEmpty);
		if ([...name].length > LIMITS.name) throw new Error(t.nameTooLong(LIMITS.name));
		if (identity === "") throw new Error(t.identityEmpty);
		if (bytes(identity) > LIMITS.identity) throw new Error(t.tooLarge(t.identityLabel, LIMITS.identity / 1024));
		if (bytes(guidelines) > LIMITS.guidelines) throw new Error(t.tooLarge(t.guidelinesLabel, LIMITS.guidelines / 1024));
		// 内置的名字两种语言都算：换了界面语言，同一份列表里不该出现两个「编程」。
		const builtinNames = Object.values(MESSAGES).flatMap((messages) => [messages.general, messages.coding]);
		const taken = [...builtinNames, ...(await custom()).filter((preset) => preset.id !== except).map((preset) => preset.name)];
		if (taken.some((other) => other.trim().toLowerCase() === name.toLowerCase())) throw new Error(t.nameTaken(name));
		return { name, identity, guidelines };
	}

	return {
		view,

		async save(id: string | undefined, draft: PresetDraft): Promise<PresetsView> {
			const t = text();
			if (id !== undefined) {
				if (isBuiltin(id)) throw new Error(t.builtinReadOnly);
				if (!SAFE_ID.test(id) || !(await readJson(presetFile(id))).found) throw new Error(t.notFound);
			}
			const preset = await check(draft, id);
			await mkdir(presetsDir, { recursive: true });
			await writeJson(presetFile(id ?? `custom-${randomUUID().slice(0, 8)}`), preset);
			return view();
		},

		async remove(id: string): Promise<PresetsView> {
			const t = text();
			if (isBuiltin(id)) throw new Error(t.builtinReadOnly);
			if (!SAFE_ID.test(id) || !(await readJson(presetFile(id))).found) throw new Error(t.notFound);
			// 先换掉选中的再删：删到一半出错时，新会话不会指向一个已经没了的文件。
			if ((await selectedId()) === id) await writeJson(selectedFile, { id: "general" });
			await ctx.trash(presetFile(id));
			return view();
		},

		async select(id: string): Promise<PresetsView> {
			if (!isBuiltin(id) && (!SAFE_ID.test(id) || !(await readJson(presetFile(id))).found)) throw new Error(text().notFound);
			await mkdir(ctx.dataDir, { recursive: true });
			await writeJson(selectedFile, { id });
			warned = undefined;
			return view();
		},

		/**
		 * 这次请求用哪一套。会话还没有消息时（不是一次真的请求）照选中的给、不记下：定下的时刻是人发第一句话。
		 */
		async forRequest(input: Pick<ModelContext, "sessionId" | "session" | "messages">): Promise<Persona> {
			const sessionId = input.sessionId;
			const own = await recorded(sessionId);
			if (own) return own;
			const source = input.session.parentId ?? (await ctx.sessions.get(sessionId))?.forkedFrom?.sessionId;
			const inherited = source === undefined ? undefined : await recorded(source);
			const chosen: SessionPersona = inherited ?? (await resolve().then(({ id, persona }) => ({ presetId: id, ...persona })));
			if (input.messages.length === 0 || !SAFE_ID.test(sessionId)) return chosen;
			held.set(sessionId, chosen);
			await mkdir(personasDir, { recursive: true });
			await writeJson(personaFile(sessionId), chosen).catch((error: unknown) =>
				// i18n-exempt：写给调试的人看的日志。
				ctx.log.warn(`会话 ${sessionId} 用的身份与准则没存上，重开应用后会按那时选中的重新定：${error instanceof Error ? error.message : String(error)}`),
			);
			return chosen;
		},

		/** 会话删掉了：它记下的那份不要了。 */
		forget(sessionId: string): void {
			held.delete(sessionId);
			if (SAFE_ID.test(sessionId)) void rm(personaFile(sessionId), { force: true });
		},
	};

	async function recorded(sessionId: string): Promise<SessionPersona | undefined> {
		const cached = held.get(sessionId);
		if (cached || !SAFE_ID.test(sessionId)) return cached;
		const read = await readJson(personaFile(sessionId));
		const value = read.found ? (read.value as Partial<SessionPersona> | undefined) : undefined;
		if (typeof value?.identity !== "string" || typeof value.guidelines !== "string" || typeof value.presetId !== "string") return undefined;
		const persona: SessionPersona = { presetId: value.presetId, identity: value.identity, guidelines: value.guidelines };
		held.set(sessionId, persona);
		return persona;
	}
}
