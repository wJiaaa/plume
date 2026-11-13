/**
 * 插件界面入口：加载、按工具名登记卡片、画进对话；登记面板，画进面板区；登记页面，排进侧栏的去处；
 * 登记输入框底下的一格、上方项目签那一行的一格、侧栏会话行首的记号、删除确认框里补的话和设置分区；登记截图浮层、钉图窗口的组件（截屏窗口里只画它们，见 screen.tsx）。
 *
 * 规则（见 agent-extension.md 第 5 节）：
 * - 登记撞上时一律后注册的生效，它撤下后前一个恢复：同一工具同一 order 的卡片、皮肤、截图浮层、钉图窗口、面板的快捷键
 *   （Plume 自己的快捷键除外，插件拿不走）；
 *   同一插件同一 id 的面板、页面、格子、设置分区，后一次替换前一次。
 * - 同一工具 order 小的生效，order 相同时后注册的在前。
 * - 每张插件卡片包一层错误边界，渲染出错就让给同一工具的下一个注册者，都不行用产品的通用卡片。
 * - 界面入口只加载 agent 进程报告为 active 的插件，加载失败只记日志。
 * - 插件在运行中装上、更新、停用、卸下时（agent 进程推来 plugins 事件），按新状态重新对一遍：不再 active 的撤下它登记的
 *   卡片、面板和皮肤，新 active 的加载；界面入口地址变了（更新过）的先撤再装。画这些东西的组件经 usePluginUis 跟着重画。
 * - 皮肤同一时间只有一个，后注册的生效；只能改 theme.css 里已有的 token。
 * - 面板之间是并列的，不互相让位：一个面板渲染出错只在它自己那一格里提示。页面、输入框的格子、设置分区同理。
 * - 截图浮层、钉图窗口的组件同一时间各只有一个，后注册的生效。插件停用时连同它的全局快捷键一起撤掉。
 */

import type { AgentService, Locale, OutgoingMessage, PluginStatus, RegisteredToolInfo, SessionView } from "@plume/contract";
import type {
	ApprovalCardProps,
	CodeBlockProps,
	ComposerAboveProps,
	ComposerChipProps,
	ComposerItemProps,
	ComposerMention,
	AgentDeliveryProps,
	ConversationCardProps,
	EnvironmentAttentionProps,
	EnvironmentSectionEntry,
	EnvironmentSectionProps,
	ExtensionsSectionProps,
	ConversationDraft,
	ConversationProps,
	LinkOpener,
	LocalizedText,
	ModelControlsProps,
	ModelDefaults,
	ModelSelectProps,
	NotifyLevel,
	PageOptions,
	PageProps,
	PanelOptions,
	PanelProps,
	PinnedShotProps,
	ProjectInfo,
	QueueAction,
	RequestCardProps,
	QuoteAction,
	DraftQuote,
	Remote,
	ScreenCapture,
	ScreenOverlayProps,
	SectionAction,
	SessionDraft,
	SessionMarkProps,
	SettingsSectionOptions,
	ToolCardProps,
	ToolLine,
	TurnFooterProps,
	ReplyActionProps,
	UiContext,
	UiPlugin,
	UiServices,
	WelcomeLine,
} from "@plume/contract/ui";
import { text } from "@plume/styles";
import { MenuItem, MenuSeparator, translate, useI18n } from "@plume/ui";
import { Component, type ComponentType, type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { EffortTrigger, ModelTrigger } from "./models/index.ts";
import { ModelSelect } from "./models/ModelSelect.tsx";
import { modelsAgent, refreshModels, settingsView, subscribeModels, useModels } from "./models/store.ts";
import { useLiveSession } from "./session-live.ts";
import { useSessionActivity } from "./sidebar/activity.ts";
import { notify } from "./toast/index.ts";
import { DiffView } from "./conversation/detail/DiffView.tsx";
import { DocumentPreview, registerDocumentViewer } from "./files/document-viewers.tsx";
import { PluginFilePreview } from "./files/PluginFilePreview.tsx";
import { ProjectOpener } from "./files/ProjectOpener.tsx";
import { findFile, openFile } from "./files/open-file.ts";
import { droppedPaths } from "./files/paths.ts";
import { usePathMenu } from "./markdown/PathMenu.tsx";
import { PluginMarkdown } from "./markdown/PluginMarkdown.tsx";
import { addToolLine, removeToolLines, setToolTable } from "./conversation/tool-lines.ts";
import { externalWebUrl } from "./plugin-navigation.ts";
import { openViewer } from "./image/index.ts";
import { copyImage, saveImage } from "./image/image-out.ts";
import { captureWindow } from "./image/capture-window.ts";
import { requestReveal } from "./conversation/reveal.ts";
import { setManagedSkin, updateAppearance, useAppearance } from "./appearance-settings.ts";
import { uiLifetime } from "./ui-lifetime.ts";
import { provideUiService, removeUiServices, uiService } from "./ui-services.ts";
import { skinRegistry } from "./skins.ts";
import { PluginChatBackgroundSettings } from "./plugin-background.tsx";
import { matchingToolCards } from "./tool-card-matching.ts";
import { ComposerSend } from "./composer/ComposerShell.tsx";
import { menuCommands, productCommands } from "./composer/commands.ts";
import { registerTerminalOpener, registerTerminalRunner } from "./files/open-terminal.ts";
import { subscribeSessionChanges } from "./plugin-session-changes.ts";
import { openMediaFile, revealMediaFile, revealMediaLabel } from "./media-files.ts";

interface Entry<P> {
	plugin: string;
	order: number;
	/** 注册先后：order 相同时后注册的在前。 */
	seq: number;
	component: ComponentType<P>;
}

/** 注册先后的计数，卡片、面板快捷键、皮肤、截图组件共用。 */
let registered = 0;

const codeBlocks = new Map<string, Entry<CodeBlockProps>[]>();
const codeCopies = new WeakMap<Entry<CodeBlockProps>, NonNullable<NonNullable<Parameters<UiContext["codeBlock"]>[2]>["copyText"]>>();
const toolCards = new Map<string, Entry<ToolCardProps>[]>();
const toolPrefixes = new Map<string, Entry<ToolCardProps>[]>();
/** `ui.toolCard(…, { inline })`：只在通用卡片上补东西的卡片，调用照常并进一段活；给的是函数时逐次调用问它。 */
const inlineCards = new WeakMap<Entry<ToolCardProps>, true | ((args: Record<string, unknown>, argumentsText: string | undefined) => boolean)>();
const approvalCards = new Map<string, Entry<ApprovalCardProps>[]>();
/** `ui.requestCard`：按 `HumanRequest.kind` 认的、`run.request` 的卡。 */
const requestCards = new Map<string, Entry<RequestCardProps>[]>();

function register<P>(table: Map<string, Entry<P>[]>, kind: string, plugin: string, tool: unknown, component: unknown, options?: { order?: number }): Entry<P> {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof tool !== "string" || tool === "") throw new Error(`${kind}需要工具名`);
	if (typeof component !== "function") throw new Error(`${kind} ${tool} 需要一个组件`);
	const order = options?.order ?? 0;
	if (!Number.isFinite(order)) throw new Error("order 必须是数字");
	const list = table.get(tool) ?? [];
	const taken = list.find((entry) => entry.order === order);
	if (taken) console.info(`[${plugin}] ${kind} ${tool} 的 order ${order} 覆盖了 ${taken.plugin} 的`);
	// order 小的在前，相同时后注册的在前；前面的渲染出错就让给后面的。
	const entry = { plugin, order, seq: registered++, component: component as ComponentType<P> };
	table.set(
		tool,
		[...list, entry].sort((a, b) => a.order - b.order || b.seq - a.seq),
	);
	return entry;
}

/** 复制和渲染使用同一个注册者，停用、替换或回调失败时由调用方保留源码。 */
export function copyCodeBlock(language: string, code: string, sessionId: string): string | undefined {
	const entry = codeBlocks.get(language.toLowerCase())?.[0];
	try {
		const value = entry && codeCopies.get(entry)?.({ code, sessionId });
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** `ui.draftInSession` 收的图：模型认得的几种。 */
const COMPOSER_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** 会话媒体目录里的名字，和 `plume-media://` 认的一样。 */
const MEDIA_NAME = /^[0-9a-f]{40}\.(png|jpg|webp|gif|bmp)$/;

/** 插件给的图：base64、模型认得的类型；`from` 只认媒体目录里的名字。 */
function composerImages(images: unknown): { data: string; mimeType: string; name?: string; from?: string }[] {
	if (!Array.isArray(images)) return [];
	return images.flatMap((image: { data?: unknown; mimeType?: unknown; name?: unknown; from?: unknown } | null) =>
		typeof image?.data === "string" && image.data !== "" && !image.data.startsWith("data:") && COMPOSER_IMAGES.has(String(image.mimeType))
			? [
					{
						data: image.data,
						mimeType: String(image.mimeType),
						...(typeof image.name === "string" && image.name.trim() ? { name: image.name.trim() } : {}),
						...(typeof image.from === "string" && MEDIA_NAME.test(image.from) ? { from: image.from } : {}),
					},
				]
			: [],
	);
}

/** `ui.toolLine`：先校验，坏的登记在注册时报错，不等到转录里画出来才出问题。 */
function registerToolLine(plugin: string, tool: unknown, line: unknown, options: unknown): void {
	const candidate = (line ?? {}) as Partial<ToolLine>;
	const match = (options as { match?: unknown } | undefined)?.match;
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof tool !== "string" || tool === "") throw new Error("工具说法需要工具名");
	if (match !== undefined && match !== "tool" && match !== "prefix") throw new Error(`工具说法 ${tool} 的 match 只能是 tool 或 prefix`);
	if (candidate.verb !== undefined && !validTitle(candidate.verb)) throw new Error(`工具说法 ${tool} 的 verb 必须是文字或按语言取文字的函数`);
	if (candidate.subject !== undefined && typeof candidate.subject !== "function") throw new Error(`工具说法 ${tool} 的 subject 必须是函数`);
	for (const key of ["file", "note", "command", "job"] as const) {
		if (candidate[key] !== undefined && typeof candidate[key] !== "function") throw new Error(`工具说法 ${tool} 的 ${key} 必须是函数`);
	}
	if (candidate.group !== undefined && (typeof candidate.group !== "string" || candidate.group === ""))
		throw new Error(`工具说法 ${tool} 的 group 必须是非空字符串`);
	if (candidate.times !== undefined && candidate.times !== true) throw new Error(`工具说法 ${tool} 的 times 只能是 true`);
	if (candidate.callOnly !== undefined && candidate.callOnly !== true) throw new Error(`工具说法 ${tool} 的 callOnly 只能是 true`);
	if (candidate.apart !== undefined && (candidate.apart !== true || candidate.group === undefined))
		throw new Error(`工具说法 ${tool} 的 apart 只能是 true，且要给 group`);
	if (candidate.icon !== undefined && typeof candidate.icon !== "function" && typeof candidate.icon !== "object")
		throw new Error(`工具说法 ${tool} 的 icon 必须是组件`);
	addToolLine(plugin, tool, candidate as ToolLine, match === "prefix" ? "prefix" : "tool");
}

export interface PanelEntry {
	/** `插件名/id`，面板区按它认出现在看的是哪一个。 */
	key: string;
	plugin: string;
	title: LocalizedText;
	description?: LocalizedText;
	icon?: PanelOptions["icon"];
	shortcut?: string;
	order: number;
	multiple: boolean;
	restore: boolean;
	detachable: boolean;
	/** 见 `PanelOptions.keepAlive`。 */
	keepAlive: boolean;
	/** 在开始页上列不列出来。本体的文件面板不列：它由点文件打开，空着开出来没有东西可看。 */
	listed: boolean;
	/** 见 `PanelOptions.available`；没有就一直能用。 */
	available?: PanelOptions["available"];
	component: ComponentType<PanelProps>;
}

/** 插件给的字：是函数就按当前语言调用。函数在产品渲染里跑，出错或不返回字符串时显示空，不让一个插件弄坏整个面板区。 */
export function localized(value: LocalizedText, locale: Locale): string {
	if (typeof value === "string") return value;
	try {
		const text = value(locale);
		return typeof text === "string" ? text : "";
	} catch (error) {
		console.error("插件给的文字取不出来：", error);
		return "";
	}
}

const validTitle = (title: unknown): title is LocalizedText => (typeof title === "string" ? title.trim() !== "" : typeof title === "function");

/** 一个快捷键拆开：四个修饰键各按没按，加上那个键（小写）。写法不认识时为空。 */
interface Shortcut {
	ctrl: boolean;
	meta: boolean;
	alt: boolean;
	shift: boolean;
	key: string;
}

const MAC = /Mac/i.test(navigator.platform);

/** 按 Electron accelerator 的写法拆：`CommandOrControl` 在 Mac 上是 ⌘，别处是 Ctrl。 */
function parseShortcut(text: string): Shortcut | undefined {
	const parts = text.split("+").map((part) => part.trim());
	const key = parts.pop()?.toLowerCase();
	if (!key) return undefined;
	const combo: Shortcut = { ctrl: false, meta: false, alt: false, shift: false, key };
	for (const part of parts.map((part) => part.toLowerCase())) {
		if (part === "commandorcontrol" || part === "cmdorctrl") combo[MAC ? "meta" : "ctrl"] = true;
		else if (part === "command" || part === "cmd" || part === "meta" || part === "super") combo.meta = true;
		else if (part === "control" || part === "ctrl") combo.ctrl = true;
		else if (part === "alt" || part === "option") combo.alt = true;
		else if (part === "shift") combo.shift = true;
		else return undefined;
	}
	return combo;
}

function sameShortcut(a: string, b: string): boolean {
	return JSON.stringify(parseShortcut(a)) === JSON.stringify(parseShortcut(b));
}

/**
 * Plume 自己在 app.tsx 里接的快捷键：⌘B / Ctrl+B 开合侧栏，后退前进，Esc 收起，⌘P / ⌥⌘P 开文件树、文件面板。面板快捷键在捕获阶段先拦，
 * 插件要了同一个就会把它们抢走，所以插件面板拿不到这些。app.tsx 那边改了要同步这里。
 */
const HOST_SHORTCUTS = [
	"Command+B",
	"Control+B",
	"Escape",
	// 本体的文件树和文件面板（app.tsx 的 registerHostPanel）。
	"CommandOrControl+P",
	"CommandOrControl+Alt+P",
	...(MAC ? ["Command+[", "Command+]"] : ["Alt+Left", "Alt+Right", "Alt+ArrowLeft", "Alt+ArrowRight"]),
];

/** 这次按键是不是这个快捷键。字母用 code 兜底：Option 和非拉丁键盘下 key 不是键帽上的字母。 */
export function matchesShortcut(event: KeyboardEvent, text: string): boolean {
	const combo = parseShortcut(text);
	if (!combo) return false;
	if (event.ctrlKey !== combo.ctrl || event.metaKey !== combo.meta || event.altKey !== combo.alt || event.shiftKey !== combo.shift) return false;
	if (event.key.toLowerCase() === combo.key) return true;
	return /^[a-z]$/.test(combo.key) && event.code === `Key${combo.key.toUpperCase()}`;
}

let panels: PanelEntry[] = [];

function registerPanel(plugin: string, id: unknown, component: unknown, options: unknown, listed = true): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof id !== "string" || id === "") throw new Error("面板需要 id");
	if (typeof component !== "function") throw new Error(`面板 ${id} 需要一个组件`);
	const {
		title,
		description,
		icon,
		shortcut,
		order = 0,
		multiple = false,
		restore = false,
		detachable = false,
		keepAlive = false,
		available,
		listed: showInStart = true,
	} = (options ?? {}) as Record<string, unknown>;
	if (!validTitle(title)) throw new Error(`面板 ${id} 需要标题`);
	if (description !== undefined && !validTitle(description)) throw new Error(`面板 ${id} 的说明需要是字符串或按语言返回字符串的函数`);
	// forwardRef、memo 包出来的组件（lucide 的图标就是）是对象，不是函数。
	if (icon !== undefined && typeof icon !== "function" && (typeof icon !== "object" || icon === null)) throw new Error(`面板 ${id} 的图标需要是组件`);
	if (shortcut !== undefined && (typeof shortcut !== "string" || !parseShortcut(shortcut))) throw new Error(`面板 ${id} 的快捷键写法不对：${String(shortcut)}`);
	if (typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必须是数字");
	if (typeof multiple !== "boolean") throw new Error(`面板 ${id} 的 multiple 需要是布尔值`);
	if (typeof restore !== "boolean" || typeof detachable !== "boolean" || typeof keepAlive !== "boolean")
		throw new Error(`面板 ${id} 的 restore、detachable、keepAlive 需要是布尔值`);
	if (typeof showInStart !== "boolean") throw new Error(`面板 ${id} 的 listed 需要是布尔值`);
	if (available !== undefined && typeof available !== "function") throw new Error(`面板 ${id} 的 available 需要是函数`);
	const key = `${plugin}/${id}`;
	if (panels.some((panel) => panel.key === key)) console.info(`[${plugin}] 面板 ${id} 重新注册，替换上一次的`);
	let keys = shortcut as string | undefined;
	const host = plugin === "plume";
	if (keys && !host && HOST_SHORTCUTS.some((reserved) => sameShortcut(reserved, keys as string))) {
		console.error(`[${plugin}] 面板 ${id} 的快捷键 ${keys} 是 Plume 自己的，忽略这个快捷键`);
		keys = undefined;
	}
	if (keys === undefined) wantedShortcuts.delete(key);
	else wantedShortcuts.set(key, { keys, seq: registered++, host });
	const entry: PanelEntry = {
		key,
		plugin,
		title,
		...(description === undefined ? {} : { description: description as LocalizedText }),
		...(icon === undefined ? {} : { icon: icon as PanelEntry["icon"] }),
		order,
		multiple,
		restore,
		detachable,
		keepAlive,
		listed: listed && showInStart,
		...(available === undefined ? {} : { available: available as PanelEntry["available"] }),
		component: component as ComponentType<PanelProps>,
	};
	// 稳定排序：order 相同的保持注册先后。
	panels = assignShortcuts([...panels.filter((panel) => panel.key !== key), entry].sort((a, b) => a.order - b.order));
}

/**
 * 面板 → 它要的快捷键和注册先后。几个面板要同一个快捷键时归后注册的，它撤下后还给前一个；
 * Plume 自己的面板（`host`）例外，插件面板抢不走它的快捷键。
 */
const wantedShortcuts = new Map<string, { keys: string; seq: number; host: boolean }>();

function assignShortcuts(list: PanelEntry[]): PanelEntry[] {
	const wanted = [...wantedShortcuts].filter(([key]) => list.some((panel) => panel.key === key));
	return list.map((panel) => {
		const mine = wantedShortcuts.get(panel.key);
		const outranks = (other: { seq: number; host: boolean }) => (other.host === mine?.host ? other.seq > mine.seq : other.host);
		const owns = mine !== undefined && !wanted.some(([key, other]) => key !== panel.key && outranks(other) && sameShortcut(other.keys, mine.keys));
		if (owns && panel.shortcut === mine.keys) return panel;
		if (!owns && panel.shortcut === undefined) return panel;
		const { shortcut: _dropped, ...rest } = panel;
		return owns ? { ...rest, shortcut: mine.keys } : rest;
	});
}

/** 本体自己的面板，键是 `plume/<id>`。默认只由本体打开；文件树显式列在开始页。 */
export function registerHostPanel(id: string, component: ComponentType<PanelProps>, options: PanelOptions, listed = false): void {
	registerPanel("plume", id, component, options, listed);
}

/**
 * 现在能用的面板，按 order 排好。启动时的插件画界面之前就齐了；之后的变化（插件装卸、`available` 的答案变了）经 usePluginUis 通知。
 * 给了 `available` 的，只有对指定目录和会话状态答过 true 才算；不传 scope 时返回所有注册项，供已有标签和后台面板继续挂着。
 */
/** 查注册项而不受当前目录可用性影响，用于恢复其他会话的标签。 */
export function panelEntry(key: string): PanelEntry | undefined {
	return panels.find((panel) => panel.key === key);
}

export function listPanels(cwd?: string, session?: boolean): readonly PanelEntry[] {
	if (arguments.length === 0) return panels;
	const hasSession = session === true;
	return panels.filter((panel) => !panel.available || availability.get(availabilityKey(panel.key, cwd, hasSession)) === true);
}

type PanelScope = { cwd: string | undefined; session: boolean };

/** 已登记过的目录和会话状态；全量刷新只重问这些 scope，不再依赖一个全局当前 scope。 */
const panelScopes = new Map<string, PanelScope>();
/** `面板键\0目录\0有没有会话` → 上次的答案。按这两样记：换回去时直接用，不先藏起来再出现。 */
const availability = new Map<string, boolean>();
const scopeKey = (cwd: string | undefined, session: boolean) => `${cwd ?? ""}\0${session ? 1 : 0}`;
const availabilityKey = (panel: string, cwd: string | undefined, session: boolean) => `${panel}\0${scopeKey(cwd, session)}`;

/** 正文告诉这里一个目录和会话状态，登记并触发这个 scope 的检查，不影响其他 scope。 */
export function setPanelScope(cwd: string | undefined, session: boolean): void {
	panelScopes.set(scopeKey(cwd, session), { cwd, session });
	void checkPanels(cwd, session);
}

/** 重问已知 scope；传入目录和会话状态时只定向刷新该 scope。答案变了才通知。 */
export async function checkPanels(cwd?: string, session?: boolean): Promise<void> {
	const scopes = arguments.length === 0 ? [...panelScopes.values()] : [{ cwd, session: session === true }];
	for (const scope of scopes) panelScopes.set(scopeKey(scope.cwd, scope.session), scope);
	const asked = panels.filter((panel) => panel.available);
	let dirty = false;
	await Promise.all(
		scopes.map(async (scope) => {
			const answers = await Promise.all(
				asked.map(async (panel) => {
					try {
						return (await panel.available!(scope.cwd === undefined ? { session: scope.session } : { cwd: scope.cwd, session: scope.session })) === true;
					} catch (error) {
						console.error(`[${panel.plugin}] 面板 ${panel.key} 的 available 出错：`, error);
						return false;
					}
				}),
			);
			asked.forEach((panel, index) => {
				const key = availabilityKey(panel.key, scope.cwd, scope.session);
				if (availability.get(key) === answers[index]) return;
				availability.set(key, answers[index]!);
				dirty = true;
			});
		}),
	);
	if (dirty) notifyPluginSignals();
}

export interface PageEntry {
	/** `插件名/id`，导航按它认出现在在哪个页面。 */
	key: string;
	plugin: string;
	title: LocalizedText;
	icon?: PageOptions["icon"];
	order: number;
	/** 页面自己画顶行，见 PageOptions.topRow。 */
	topRow: boolean;
	component: ComponentType<PageProps>;
}

let pages: PageEntry[] = [];

function registerPage(plugin: string, id: unknown, component: unknown, options: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof id !== "string" || id === "") throw new Error("页面需要 id");
	if (typeof component !== "function") throw new Error(`页面 ${id} 需要一个组件`);
	const { title, icon, order = 0, topRow = false } = (options ?? {}) as Record<string, unknown>;
	if (!validTitle(title)) throw new Error(`页面 ${id} 需要标题`);
	if (typeof topRow !== "boolean") throw new Error(`页面 ${id} 的 topRow 需要是布尔值`);
	if (icon !== undefined && typeof icon !== "function" && (typeof icon !== "object" || icon === null)) throw new Error(`页面 ${id} 的图标需要是组件`);
	if (typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必须是数字");
	const key = `${plugin}/${id}`;
	if (pages.some((page) => page.key === key)) console.info(`[${plugin}] 页面 ${id} 重新注册，替换上一次的`);
	const entry: PageEntry = {
		key,
		plugin,
		title,
		...(icon === undefined ? {} : { icon: icon as PageEntry["icon"] }),
		order,
		topRow,
		component: component as ComponentType<PageProps>,
	};
	// 稳定排序：order 相同的保持注册先后。
	pages = [...pages.filter((page) => page.key !== key), entry].sort((a, b) => a.order - b.order);
}

/** 所有页面，按 order 排好。变化经 usePluginUis 通知。 */
export function listPages(): readonly PageEntry[] {
	return pages;
}

/** 插件经 `ui.pageBadge` 挂在页面那一行上的数，按页面的 key。 */
const pageBadges = new Map<string, { count: number; label: LocalizedText; attention?: boolean }>();

function setPageBadge(plugin: string, id: unknown, badge: unknown): void {
	const key = `${plugin}/${String(id)}`;
	// i18n-exempt：给插件作者的报错，界面上不显示。
	if (!pages.some((page) => page.key === key)) throw new Error(`页面 ${String(id)} 没有注册`);
	const { count, label, attention } = (badge ?? {}) as Record<string, unknown>;
	const previous = pageBadges.get(key);
	if (badge === null || count === 0) {
		if (!previous) return;
		pageBadges.delete(key);
	} else {
		if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new Error("页面角标的 count 要是非负整数");
		if (!validTitle(label)) throw new Error("页面角标需要 label");
		// 插件常按轮询原样再推一遍：没变就不叫人重画。
		if (previous && previous.count === count && previous.attention === (attention === true) && previous.label === label) return;
		pageBadges.set(key, { count, label, attention: attention === true });
	}
	notifyPluginSignals();
}

/** 页面那一行右端的数；没有时为空。变化经 usePluginUis 通知。 */
export function pageBadge(key: string): { count: number; label: LocalizedText; attention?: boolean } | undefined {
	return pageBadges.get(key);
}

interface ComposerItemEntry {
	key: string;
	plugin: string;
	side: "start" | "end";
	order: number;
	component: ComponentType<ComposerItemProps>;
}

let composerItems: ComposerItemEntry[] = [];

function registerComposerItem(plugin: string, id: unknown, component: unknown, options: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof id !== "string" || id === "") throw new Error("输入框控件需要 id");
	if (typeof component !== "function" && (typeof component !== "object" || component === null)) throw new Error(`输入框控件 ${id} 需要一个组件`);
	const { side = "start", order = 0 } = (options ?? {}) as Record<string, unknown>;
	if (side !== "start" && side !== "end") throw new Error(`输入框控件 ${id} 的 side 只能是 start 或 end`);
	if (typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必须是数字");
	const key = `${plugin}/${id}`;
	if (composerItems.some((item) => item.key === key)) console.info(`[${plugin}] 输入框控件 ${id} 重新注册，替换上一次的`);
	composerItems = [
		...composerItems.filter((item) => item.key !== key),
		{ key, plugin, side: side as ComposerItemEntry["side"], order, component: component as ComponentType<ComposerItemProps> },
	].sort((a, b) => a.order - b.order);
}

/** 插件加在输入框工具栏左边（`start`）或右边模型选择前面（`end`）的那几格。每格包一层错误边界：一个插件画坏了只丢它自己那一格，输入框照常能用。 */
export function ComposerItems({ side, ...props }: ComposerItemProps & { side: "start" | "end" }) {
	usePluginUis();
	return (
		<>
			{composerItems
				.filter((item) => item.side === side)
				.map((item) => (
					<Isolated key={item.key} plugin={item.plugin}>
						<item.component {...props} />
					</Isolated>
				))}
		</>
	);
}

interface ComposerChipEntry {
	key: string;
	plugin: string;
	side: "start" | "end";
	order: number;
	component: ComponentType<ComposerChipProps>;
}

let composerChips: ComposerChipEntry[] = [];

function registerComposerChip(plugin: string, id: unknown, component: unknown, options: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof id !== "string" || id === "") throw new Error("输入框上方的格子需要 id");
	if (typeof component !== "function" && (typeof component !== "object" || component === null)) throw new Error(`输入框上方的格子 ${id} 需要一个组件`);
	const { side = "start", order = 0 } = (options ?? {}) as Record<string, unknown>;
	if (side !== "start" && side !== "end") throw new Error(`输入框上方的格子 ${id} 的 side 只能是 start 或 end`);
	if (typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必须是数字");
	const key = `${plugin}/${id}`;
	if (composerChips.some((chip) => chip.key === key)) console.info(`[${plugin}] 输入框上方的格子 ${id} 重新注册，替换上一次的`);
	composerChips = [
		...composerChips.filter((chip) => chip.key !== key),
		{ key, plugin, side: side as ComposerChipEntry["side"], order, component: component as ComponentType<ComposerChipProps> },
	].sort((a, b) => a.order - b.order);
}

/** 插件加在项目签那一行的格子，`side` 那一侧的。和输入框底下的格子一样，每格包一层错误边界。 */
export function ComposerChips({ side, ...props }: ComposerChipProps & { side: "start" | "end" }) {
	usePluginUis();
	return (
		<>
			{composerChips
				.filter((chip) => chip.side === side)
				.map((chip) => (
					<Isolated key={chip.key} plugin={chip.plugin}>
						<chip.component {...props} />
					</Isolated>
				))}
		</>
	);
}

let composerAbove: Array<{ key: string; plugin: string; order: number; component: ComponentType<ComposerAboveProps> }> = [];

function registerComposerAbove(plugin: string, id: unknown, component: unknown, options: unknown): void {
	// i18n-exempt：插件作者的接口错误，只写入加载日志。
	if (typeof id !== "string" || id === "") throw new Error("输入框上方的行需要 id");
	if (typeof component !== "function" && (typeof component !== "object" || component === null)) throw new Error(`输入框上方的行 ${id} 需要一个组件`);
	const { order = 0 } = (options ?? {}) as Record<string, unknown>;
	if (typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必须是数字");
	const key = `${plugin}/${id}`;
	composerAbove = [
		...composerAbove.filter((entry) => entry.key !== key),
		{ key, plugin, order, component: component as ComponentType<ComposerAboveProps> },
	].sort((a, b) => a.order - b.order);
}

/** 输入框上方独占一行的扩展；不加外框，组件返回空时不会留下高度。 */
export function ComposerAbove(props: ComposerAboveProps) {
	usePluginUis();
	return (
		<>
			{composerAbove.map((entry) => (
				<Isolated key={`${entry.key}:${props.session.summary.id}`} plugin={entry.plugin}>
					<entry.component {...props} />
				</Isolated>
			))}
		</>
	);
}

interface ConversationCardEntry {
	key: string;
	plugin: string;
	order: number;
	/** 占右边那一列（见 `UiContext.conversationCard` 的 `lane`）。 */
	lane: boolean;
	component: ComponentType<ConversationCardProps>;
}

let conversationCards: ConversationCardEntry[] = [];

const sessionToolbar = new Map<string, Entry<{ session: SessionView }>[]>();
let sessionMenuItems: Array<{ key: string; plugin: string; item: Parameters<UiContext["sessionMenuItem"]>[1] }> = [];
let agentDeliveries: Array<{ plugin: string; component: ComponentType<AgentDeliveryProps> }> = [];

export function SessionToolbar({ session }: { session: SessionView }) {
	usePluginUis();
	return (
		<>
			{[...sessionToolbar.values()]
				.map((entries) => entries[0]!)
				.map((entry) => (
					<Isolated key={`${entry.plugin}:${entry.seq}`} plugin={entry.plugin}>
						<entry.component session={session} />
					</Isolated>
				))}
		</>
	);
}

export function SessionMenuItems({ session, onClose }: { session: SessionView["summary"]; onClose(): void }) {
	usePluginUis();
	const { resolvedLocale } = useI18n();
	if (!sessionMenuItems.length) return null;
	return (
		<>
			<MenuSeparator />
			{sessionMenuItems.map(({ key, item }) => (
				<MenuItem
					key={key}
					icon={item.icon ? <item.icon size={13} /> : undefined}
					onClick={() => {
						onClose();
						void Promise.resolve()
							.then(() => item.run(session))
							.catch((error: unknown) => notify(String(error), "error"));
					}}
				>
					{typeof item.label === "function" ? item.label(resolvedLocale) : item.label}
				</MenuItem>
			))}
		</>
	);
}

/** 一项界面侧服务现在生效的实现（`ui.useService`）；提供方换了、撤了，登记的修订号跟着变，用它的组件重画。 */
function useUiService<K extends keyof UiServices>(name: K): UiServices[K] | undefined {
	usePluginUis();
	return uiService(name) as UiServices[K] | undefined;
}

/**
 * 交给插件画的那几份（`ui.agentDelivery`）：按交它的插件（`DeliveredReport.plugin`）分开，各交给那个插件登记的组件。
 * 插件的组件出错时不画，不拖垮整段转录。
 */
export function AgentDeliverySlot({ sessionId, reports, plugin }: AgentDeliveryProps & { plugin: string }) {
	const version = usePluginRegistrations();
	const entry = agentDeliveries.find((each) => each.plugin === plugin);
	if (!entry) return null;
	return (
		<Isolated key={`${version}:${plugin}`} plugin={plugin}>
			<entry.component sessionId={sessionId} reports={reports} />
		</Isolated>
	);
}

/** 这个插件登记了自己的送达行（`ui.agentDelivery`）；没登记、停用了的，送达画成宿主默认的一行。 */
export function useDeliveryPlugins(): ReadonlySet<string> {
	usePluginRegistrations();
	return new Set(agentDeliveries.map((entry) => entry.plugin));
}

function registerConversationCard(plugin: string, id: unknown, component: unknown, options: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof id !== "string" || id === "") throw new Error("跟着会话的卡片需要 id");
	if (typeof component !== "function" && (typeof component !== "object" || component === null)) throw new Error(`跟着会话的卡片 ${id} 需要一个组件`);
	const { order = 0, lane = false } = (options ?? {}) as Record<string, unknown>;
	if (typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必须是数字");
	if (typeof lane !== "boolean") throw new Error("lane 必须是布尔值");
	const key = `${plugin}/${id}`;
	if (conversationCards.some((card) => card.key === key)) console.info(`[${plugin}] 跟着会话的卡片 ${id} 重新注册，替换上一次的`);
	conversationCards = [
		...conversationCards.filter((card) => card.key !== key),
		{ key, plugin, order, lane, component: component as ComponentType<ConversationCardProps> },
	].sort((a, b) => a.order - b.order);
}

/**
 * 插件加的、跟着会话的卡片，按 `placement` 画在转录右上角或输入框上方。每张包一层错误边界，不加 DOM：
 * 卡片的根元素直接是容器的子元素，外面的 `empty:hidden` 和右边那一列的高度约束才对得上。`lane` 选画哪一种。
 */
export function ConversationCards({ lane, ...props }: ConversationCardProps & { lane: boolean }) {
	usePluginUis();
	return (
		<>
			{conversationCards
				.filter((card) => card.lane === lane)
				.map((card) => (
					<Isolated key={card.key} plugin={card.plugin}>
						<card.component {...props} />
					</Isolated>
				))}
		</>
	);
}

let environmentSections: EnvironmentSectionEntry[] = [];

function registerEnvironmentSection(plugin: string, id: unknown, component: unknown, options: unknown): void {
	// i18n-exempt：插件作者的接口错误，只写入加载日志。
	if (typeof id !== "string" || id === "") throw new Error("环境卡片的一节需要 id");
	if (typeof component !== "function" && (typeof component !== "object" || component === null)) throw new Error(`环境卡片的一节 ${id} 需要一个组件`);
	const { label, order = 0, attention } = (options ?? {}) as Record<string, unknown>;
	if (!validTitle(label)) throw new Error(`环境卡片的一节 ${id} 需要 label`);
	if (typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必须是数字");
	if (attention !== undefined && typeof attention !== "function") throw new Error(`环境卡片的一节 ${id} 的 attention 要是一个 hook`);
	const key = `${plugin}/${id}`;
	const Section = component as ComponentType<EnvironmentSectionProps>;
	// 画卡片的是另一个插件：错误边界在这里包好，一节出错不连累整张卡片和别的插件。
	const Wrapped = (props: EnvironmentSectionProps) => (
		<Isolated plugin={plugin}>
			<Section {...props} />
		</Isolated>
	);
	environmentSections = [
		...environmentSections.filter((entry) => entry.key !== key),
		{
			key,
			label: label as EnvironmentSectionEntry["label"],
			order,
			component: Wrapped,
			...(attention ? { attention: attentionProbe(plugin, attention as (session: SessionView) => string | undefined) } : {}),
		},
	].sort((a, b) => a.order - b.order);
}

/** 把插件的 `attention` hook 包成一个什么都不画的组件：画卡片的插件挂上它，那句话变了经 `onChange` 告诉它；出错时当作没有。 */
function attentionProbe(plugin: string, use: (session: SessionView) => string | undefined): ComponentType<EnvironmentAttentionProps> {
	function Probe({ session, onChange }: EnvironmentAttentionProps) {
		const text = use(session);
		useEffect(() => onChange(typeof text === "string" && text.trim() ? text : undefined), [text, onChange]);
		useEffect(() => () => onChange(undefined), [onChange]);
		return null;
	}
	return (props: EnvironmentAttentionProps) => (
		<Isolated plugin={plugin} fallback={null}>
			<Probe {...props} />
		</Isolated>
	);
}

function useEnvironmentSections(): readonly EnvironmentSectionEntry[] {
	usePluginUis();
	return environmentSections;
}

let turnFooters: Array<{ key: string; plugin: string; order: number; component: ComponentType<TurnFooterProps> }> = [];

function registerTurnFooter(plugin: string, id: unknown, component: unknown, options: unknown): void {
	// i18n-exempt：插件作者的接口错误，只写入加载日志。
	if (typeof id !== "string" || id === "") throw new Error("回复页脚需要 id");
	if (typeof component !== "function" && (typeof component !== "object" || component === null)) throw new Error(`回复页脚 ${id} 需要一个组件`);
	const { order = 0 } = (options ?? {}) as Record<string, unknown>;
	if (typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必须是数字");
	const key = `${plugin}/${id}`;
	turnFooters = [...turnFooters.filter((entry) => entry.key !== key), { key, plugin, order, component: component as ComponentType<TurnFooterProps> }].sort(
		(a, b) => a.order - b.order,
	);
}

/** 跟着最新回复滚动；空组件不留槽位，错误只影响该插件。 */
export function TurnFooters(props: TurnFooterProps) {
	const version = usePluginRegistrations();
	return (
		<>
			{turnFooters.map((entry) => (
				<Isolated key={`${version}:${entry.key}:${props.session.summary.id}:${props.timestamp}`} plugin={entry.plugin}>
					<entry.component {...props} />
				</Isolated>
			))}
		</>
	);
}

let replyActions: Array<{ key: string; plugin: string; order: number; component: ComponentType<ReplyActionProps> }> = [];

function registerReplyAction(plugin: string, id: unknown, component: unknown, options: unknown): void {
	// i18n-exempt：插件作者的接口错误，只写入加载日志。
	if (typeof id !== "string" || id === "") throw new Error("回复操作需要 id");
	if (typeof component !== "function" && (typeof component !== "object" || component === null)) throw new Error(`回复操作 ${id} 需要一个组件`);
	const { order = 0 } = (options ?? {}) as Record<string, unknown>;
	if (typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必须是数字");
	const key = `${plugin}/${id}`;
	replyActions = [...replyActions.filter((entry) => entry.key !== key), { key, plugin, order, component: component as ComponentType<ReplyActionProps> }].sort(
		(a, b) => a.order - b.order,
	);
}

/** 回复底下那一排里插件的按钮；返回 null 的不占位，错误只影响该插件。 */
export function ReplyActions(props: ReplyActionProps) {
	const version = usePluginRegistrations();
	return (
		<>
			{replyActions.map((entry) => (
				<Isolated key={`${version}:${entry.key}`} plugin={entry.plugin}>
					<entry.component {...props} />
				</Isolated>
			))}
		</>
	);
}

const mentionProviders = new Map<string, Parameters<UiContext["mentions"]>[0]>();

/** 已发送消息里的会话引用沿用产品的会话跳转。 */
export async function openReferencedSession(id: string): Promise<void> {
	await host?.openSession(id);
}

/** 迟到的已停用插件不能重新把条目放回菜单。 */
export async function listMentions(context: { cwd?: string; sessionId?: string }): Promise<ComposerMention[]> {
	const results = await Promise.all(
		[...mentionProviders].map(async ([plugin, provider]) => {
			const entries = await provider(context);
			if (mentionProviders.get(plugin) !== provider) return [];
			return entries
				.filter(
					(entry) =>
						typeof entry.id === "string" &&
						typeof entry.title === "string" &&
						typeof entry.token === "string" &&
						(entry.kind === "subagent" || entry.kind === "plugin"),
				)
				.map((entry) => ({ ...entry, id: `${plugin}/${entry.id}` }));
		}),
	);
	return results.flat();
}

/** 输入框的灰字建议（`ui.composerHint`）和回复正文的过滤（`ui.replyText`），每个插件一个，按注册先后。 */
let composerHints: Array<{ plugin: string; hint: (session: SessionView) => string | undefined }> = [];
let replyTransforms: Array<{ plugin: string; transform: (text: string) => string }> = [];

function registerComposerHint(plugin: string, hint: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof hint !== "function") throw new Error("composerHint 需要一个函数");
	composerHints = [...composerHints.filter((entry) => entry.plugin !== plugin), { plugin, hint: hint as (session: SessionView) => string | undefined }];
}

function registerReplyText(plugin: string, transform: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof transform !== "function") throw new Error("replyText 需要一个函数");
	replyTransforms = [...replyTransforms.filter((entry) => entry.plugin !== plugin), { plugin, transform: transform as (text: string) => string }];
}

/** 这个会话的输入框空着时显示的建议：第一个给出字的插件说了算。出错的插件跳过，只进日志。 */
export function composerHint(session: SessionView | undefined): string | undefined {
	if (!session) return undefined;
	for (const { plugin, hint } of composerHints) {
		try {
			const text = hint(session);
			if (typeof text === "string" && text.trim()) return text.trim();
		} catch (error) {
			console.error(`[${plugin}] 输入框建议出错：`, error);
		}
	}
	return undefined;
}

/** 欢迎页问候下面的那一行（`ui.welcomeLine`），每个插件一个，按注册先后；只问最后一个。 */
let welcomeLines: Array<{ plugin: string; line: (locale: Locale) => unknown }> = [];

function registerWelcomeLine(plugin: string, line: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof line !== "function") throw new Error("welcomeLine 需要一个函数");
	welcomeLines = [...welcomeLines.filter((entry) => entry.plugin !== plugin), { plugin, line: line as (locale: Locale) => unknown }];
}

/** 有没有插件要换欢迎页的那一行：有就等它的答复，不先显示产品默认的那一句再换掉。 */
export function hasWelcomeLine(): boolean {
	return welcomeLines.length > 0;
}

/** 欢迎页这次显示的那一行：最后注册的插件说了算，没给、给空、出错都是 undefined（出错进日志）。 */
export async function welcomeLine(locale: Locale): Promise<WelcomeLine | undefined> {
	const entry = welcomeLines.at(-1);
	if (!entry) return undefined;
	try {
		const value = (await entry.line(locale)) as Partial<WelcomeLine> | undefined;
		const text = typeof value?.text === "string" ? value.text.trim() : "";
		if (!text) return undefined;
		const source = typeof value?.source === "string" ? value.source.trim() : "";
		return source ? { text, source } : { text };
	} catch (error) {
		console.error(`[${entry.plugin}] 欢迎页那一行出错：`, error);
		return undefined;
	}
}

/** 回复正文画出来、复制出去之前过一遍插件的过滤。出错的那一个跳过，字照原样往下传。 */
export function replyText(text: string): string {
	let out = text;
	for (const { plugin, transform } of replyTransforms) {
		try {
			const next = transform(out);
			if (typeof next === "string") out = next;
		} catch (error) {
			console.error(`[${plugin}] 回复过滤出错：`, error);
		}
	}
	return out;
}

/** 侧栏会话行首的记号（`ui.sessionMark`），每个插件一个，按注册先后套起来，先注册的在外层。 */
let sessionMarks: Array<{ plugin: string; component: ComponentType<SessionMarkProps> }> = [];

function registerSessionMark(plugin: string, component: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof component !== "function" && (typeof component !== "object" || component === null)) throw new Error("sessionMark 需要一个组件");
	sessionMarks = [...sessionMarks.filter((entry) => entry.plugin !== plugin), { plugin, component: component as ComponentType<SessionMarkProps> }];
}

/** 会话行首空闲时那一格：各插件的记号一层套一层，最里层是 `fallback`（产品的空心圈）。渲染出错的那一层让给里面的。 */
export function SessionMarks({ session, fallback }: SessionMarkProps) {
	usePluginUis();
	return <MarkLayer index={0} session={session} fallback={fallback} />;
}

function MarkLayer({ index, session, fallback }: SessionMarkProps & { index: number }) {
	const entry = sessionMarks[index];
	if (!entry) return <>{fallback}</>;
	const inner = <MarkLayer index={index + 1} session={session} fallback={fallback} />;
	const Mark = entry.component;
	return (
		<Isolated key={entry.plugin} plugin={entry.plugin} fallback={inner}>
			<Mark session={session} fallback={inner} />
		</Isolated>
	);
}

/** 网址、文件签的别的打开方式（`ui.linkOpener`），每个插件一个，按注册先后。 */
let linkOpeners: Array<{ plugin: string; opener: LinkOpener }> = [];

function registerLinkOpener(plugin: string, opener: unknown): void {
	const value = opener as Partial<LinkOpener> | null;
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (!value || typeof value.open !== "function" || !validTitle(value.label)) throw new Error("linkOpener 需要 label 和 open");
	linkOpeners = [...linkOpeners.filter((entry) => entry.plugin !== plugin), { plugin, opener: value as LinkOpener }];
}

/** 一种打开方式，问它的几样都接住错：插件出错不该让回复画不出来、链接点不动。 */
export interface LinkChoice {
	key: string;
	label: (locale: Locale) => string;
	icon?: LinkOpener["icon"];
	open(target: { url: string } | { path: string }, sessionId: string | undefined): void;
}

function choiceOf({ plugin, opener }: { plugin: string; opener: LinkOpener }): LinkChoice {
	return {
		key: plugin,
		label: (locale) => localized(opener.label, locale),
		...(opener.icon ? { icon: opener.icon } : {}),
		open: (target, sessionId) => {
			void Promise.resolve()
				.then(() => opener.open(target, sessionId))
				.catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
		},
	};
}

function asks(plugin: string, question: () => boolean | undefined): boolean {
	try {
		return question() === true;
	} catch (error) {
		console.error(`[${plugin}] 打开方式出错：`, error);
		return false;
	}
}

/** 开得了网址的几种。 */
export function webOpeners(): LinkChoice[] {
	return linkOpeners.filter((entry) => entry.opener.web === true).map(choiceOf);
}

/** 点网址时接手的那一种；没有就交给系统浏览器。 */
export function clickOpener(): LinkChoice | undefined {
	const taken = linkOpeners.find((entry) => entry.opener.web === true && asks(entry.plugin, () => entry.opener.takesClicks?.()));
	return taken && choiceOf(taken);
}

/** 开得了这个本机文件的几种。 */
export function fileOpeners(path: string): LinkChoice[] {
	return linkOpeners.filter((entry) => asks(entry.plugin, () => entry.opener.file?.(path))).map(choiceOf);
}

/** 排队消息「更多」菜单里插件加的项（`ui.queueAction`），每个插件一个，按注册先后。 */
let queueActions: Array<{ plugin: string; action: QueueAction }> = [];
let quoteActions: Array<{ plugin: string; action: QuoteAction }> = [];

export function useQuoteActions(): readonly QuoteAction[] {
	usePluginUis();
	const entries = quoteActions;
	return useMemo(() => entries.map(({ action }) => action), [entries]);
}

function registerQueueAction(plugin: string, action: unknown): void {
	const value = action as Partial<QueueAction> | null;
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (!value || typeof value.run !== "function" || !validTitle(value.label)) throw new Error("queueAction 需要 label 和 run");
	queueActions = [...queueActions.filter((entry) => entry.plugin !== plugin), { plugin, action: value as QueueAction }];
}

/** 一项菜单，`run` 接住错：插件出错只弹提示。 */
export interface QueueChoice {
	key: string;
	label: (locale: Locale) => string;
	icon?: QueueAction["icon"];
	run(message: OutgoingMessage, sessionId: string): void;
}

/** React hook：插件加的排队菜单项，插件装上、停用时跟着变。 */
export function useQueueActions(): QueueChoice[] {
	usePluginUis();
	return queueActions.map(({ plugin, action }) => ({
		key: plugin,
		label: (locale: Locale) => localized(action.label, locale),
		...(action.icon ? { icon: action.icon } : {}),
		run: (message: OutgoingMessage, sessionId: string) => {
			void Promise.resolve()
				.then(() => action.run(message, sessionId))
				.catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
		},
	}));
}

/** 删除确认框里各插件补的话（`ui.deleteNote`），每个插件一个，按注册先后。 */
let deleteNoteEntries: Array<{ plugin: string; note: (sessionId: string, locale: Locale) => unknown }> = [];

function registerDeleteNote(plugin: string, note: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof note !== "function") throw new Error("deleteNote 需要一个函数");
	deleteNoteEntries = [
		...deleteNoteEntries.filter((entry) => entry.plugin !== plugin),
		{ plugin, note: note as (sessionId: string, locale: Locale) => unknown },
	];
}

/** 确认框是人点了删除才开的，等久了像没反应：答得慢的插件不等，它那句不写。 */
const DELETE_NOTE_WAIT = 600;

/** 删掉这个会话之前各插件要补的话，按注册先后。出错、超时、没话说的跳过，出错的只进日志。 */
export async function deleteNotes(sessionId: string, locale: Locale): Promise<string[]> {
	const answers = await Promise.all(
		deleteNoteEntries.map(async ({ plugin, note }) => {
			let timer: number | undefined;
			try {
				const answer = await Promise.race([
					Promise.resolve().then(() => note(sessionId, locale)),
					new Promise<undefined>((resolve) => {
						timer = window.setTimeout(resolve, DELETE_NOTE_WAIT);
					}),
				]);
				return typeof answer === "string" ? answer.trim() : "";
			} catch (error) {
				console.error(`[${plugin}] 删除说明出错：`, error);
				return "";
			} finally {
				window.clearTimeout(timer);
			}
		}),
	);
	return answers.filter(Boolean);
}

/**
 * 插件经 `ui` 用到的、由正文那边实现的几件事：开面板、写输入框。正文在启动时接上；接上之前调用什么都不做。
 * 不直接引用正文的模块：它反过来要引用这里的注册表。
 */
export interface PluginHost {
	openPanel(key: string, sessionId?: string, options?: { tab?: string; background?: boolean }): void;
	quoteInPanel(key: string, sessionId: string, quote: DraftQuote): void;
	closePanel(key: string, sessionId?: string, tab?: string): void;
	openConversationDraft(options: ConversationDraft): Promise<void>;
	/** `ui.draftInSession`：图片已校验过，`send` 已核对过是人刚点的。 */
	draftInSession(
		sessionId: string | undefined,
		draft: { text: string; images: { data: string; mimeType: string; name?: string; from?: string }[]; send: boolean; replace: boolean },
	): Promise<void>;
	/** `ui.revealToolCall`：打开会话，等它读完。滚过去由转录自己做（`conversation/reveal.ts`）。 */
	openSession(sessionId: string): Promise<void>;
	openSettings(key: string): void;
	/** `ui.openPage`：页面的 key（`插件名/id`），已经查过是注册了的。 */
	openPage(key: string): void;
	/** `ui.Conversation`：转录要的「去设置」「引用到输入框」在正文那边。 */
	Conversation: ComponentType<ConversationProps>;
	/** `ui.useProjects`：侧栏登记的项目。React hook。 */
	useProjects(): readonly ProjectInfo[];
	/** `ui.usePluginDisplayName`：市场目录在 market/store.ts，它引用这个文件，所以经 host 接进来。React hook。 */
	usePluginDisplayName(): (plugin: string) => string | undefined;
	/** 当前打开的会话选过的模型；没打开会话、没选过时为空。React hook。 */
	useSessionModel(): string | undefined;
	/** 模型菜单里「还没有模型」那一行：去设置 › 模型。 */
	openModelSettings(): void;
	/** `ToolCardProps.handToParent`：把一件事排进这个子会话的父会话（`AgentService.queueTask`）。 */
	queueTask(sessionId: string, instruction: string): Promise<void>;
}

/** `ui.Conversation`：引用不变，插件拿去当组件用；正文接上之前什么都不画。 */
function HostConversation(props: ConversationProps) {
	const Rendered = host?.Conversation;
	return Rendered ? <Rendered {...props} /> : null;
}

let host: PluginHost | undefined;

const NO_PROJECTS: readonly ProjectInfo[] = [];
const NO_DISPLAY_NAME = (): undefined => undefined;

/** `ui.ModelSelect`：产品的模型下拉，「还没有模型」那一行去设置 › 模型。 */
function PluginModelSelect(props: ModelSelectProps) {
	return <ModelSelect {...props} onOpenSettings={() => host?.openModelSettings()} />;
}

/**
 * `ui.ModelControls`：输入框右下角那两枚，接在一个还没发第一句的草稿会话上——没选时显示的默认模型、默认档位，
 * 选了以后的菜单和就近落档，都和新会话的输入框是同一套。选择只交给插件，不写到哪个会话上。
 */
function PluginModelControls({ model, thinking, onModelChange, onThinkingChange, disabled }: ModelControlsProps) {
	const session = {
		id: null,
		said: false,
		...(model ? { model } : {}),
		...(thinking ? { thinking } : {}),
		setModel: onModelChange,
		setThinking: onThinkingChange,
	};
	const onError = (message: string) => notify(message, "error");
	return (
		<div className="flex min-w-0 items-center gap-0.5">
			<ModelTrigger session={session} {...(disabled ? { disabled } : {})} onError={onError} onOpenSettings={() => host?.openModelSettings()} />
			<EffortTrigger session={session} {...(disabled ? { disabled } : {})} onError={onError} />
		</div>
	);
}

/** `ui.useModelDefaults`：跟随会落到的模型。会话没选过模型时跟着默认模型走，和输入框里显示的是同一个。 */
function useModelDefaults(): ModelDefaults {
	const models = useModels();
	const view = useSyncExternalStore(subscribeModels, settingsView);
	// host 在插件界面装上之前就接好了，这里每次渲染调的都是同一个 hook。
	const chosen = host?.useSessionModel();
	const defaultModel = models?.defaultModelId ?? undefined;
	return useMemo(
		() => ({
			...(defaultModel ? { defaultModel } : {}),
			...((chosen ?? defaultModel) ? { sessionModel: chosen ?? defaultModel } : {}),
			thinking: view?.thinking ?? "medium",
		}),
		[chosen, defaultModel, view?.thinking],
	);
}

export function connectPluginHost(next: PluginHost): void {
	host = next;
}

/** 子会话里的工具卡片「交给父会话」，见 `ToolCardProps.handToParent`。host 在插件界面装上之前就接好了，卡片画出来时一定在。 */
export async function queueTask(sessionId: string, instruction: string): Promise<void> {
	await host?.queueTask(sessionId, instruction);
}

export interface SettingsSectionEntry {
	/** `插件名/id`，设置页按 `plugin:<key>` 认出现在在哪一节。 */
	key: string;
	plugin: string;
	title: LocalizedText;
	/** 小标题或页头下面的介绍；`general`、`session-models` 是那一行名字下面的说明。 */
	detail?: LocalizedText;
	icon?: SettingsSectionOptions["icon"];
	order: number;
	/** 单独成页时排在导航的哪一组；没有时是「基本」组。 */
	group?: NonNullable<SettingsSectionOptions["group"]>;
	/** 画在哪：`nav` 单独占导航的一行，其余是产品的哪一页；没有时画进插件详情。 */
	page?: NonNullable<SettingsSectionOptions["page"]>;
	/** 放进「插件市场」那一类页顶「添加」菜单的条目，见 `SettingsSectionOptions.actions`。 */
	actions?: SectionAction[];
	component: ComponentType<ExtensionsSectionProps>;
}

let settingsSections: SettingsSectionEntry[] = [];
const SETTINGS_PAGES: ReadonlySet<string> = new Set([
	"nav",
	"general",
	"personalization",
	"agents",
	"session-models",
	"extensions-skills",
	"extensions-connectors",
] satisfies NonNullable<SettingsSectionOptions["page"]>[]);

const SECTION_GROUPS = new Set<string>(["agent", "data", "vcs"] satisfies NonNullable<SettingsSectionOptions["group"]>[]);

function validAction(action: unknown): boolean {
	if (typeof action !== "object" || action === null) return false;
	const { label, detail, run } = action as Record<string, unknown>;
	return validTitle(label) && (detail === undefined || validTitle(detail)) && typeof run === "function";
}

function registerSettingsSection(plugin: string, id: unknown, component: unknown, options: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof id !== "string" || id === "") throw new Error("设置分区需要 id");
	if (typeof component !== "function") throw new Error(`设置分区 ${id} 需要一个组件`);
	const { title, detail, icon, order = 0, page, group, actions } = (options ?? {}) as Record<string, unknown>;
	if (!validTitle(title)) throw new Error(`设置分区 ${id} 需要标题`);
	if (detail !== undefined && !validTitle(detail)) throw new Error(`设置分区 ${id} 的说明需要是文字`);
	if (icon !== undefined && typeof icon !== "function" && (typeof icon !== "object" || icon === null)) throw new Error(`设置分区 ${id} 的图标需要是组件`);
	if (typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必须是数字");
	if (page !== undefined && !SETTINGS_PAGES.has(page as string)) throw new Error(`设置分区 ${id} 的 page 只能是 ${[...SETTINGS_PAGES].join("、")}`);
	if (group !== undefined && !SECTION_GROUPS.has(group as string)) throw new Error(`设置分区 ${id} 的 group 只能是 ${[...SECTION_GROUPS].join("、")}`);
	if (group !== undefined && page !== "nav") throw new Error(`设置分区 ${id} 的 group 只在 page 是 nav 时有用`);
	if (actions !== undefined && page !== "extensions-skills" && page !== "extensions-connectors")
		throw new Error(`设置分区 ${id} 的 actions 只在 page 是 extensions-skills、extensions-connectors 时有用`);
	if (actions !== undefined && (!Array.isArray(actions) || !actions.every((action: unknown) => validAction(action))))
		throw new Error(`设置分区 ${id} 的 actions 每一项要有名字和 run`);
	const key = `${plugin}/${id}`;
	if (settingsSections.some((section) => section.key === key)) console.info(`[${plugin}] 设置分区 ${id} 重新注册，替换上一次的`);
	const entry: SettingsSectionEntry = {
		key,
		plugin,
		title,
		...(detail === undefined ? {} : { detail: detail as LocalizedText }),
		...(icon === undefined ? {} : { icon: icon as SettingsSectionEntry["icon"] }),
		order,
		...(page === undefined ? {} : { page: page as SettingsSectionEntry["page"] }),
		...(group === undefined ? {} : { group: group as SettingsSectionEntry["group"] }),
		...(actions === undefined ? {} : { actions: actions as SectionAction[] }),
		component: component as ComponentType<ExtensionsSectionProps>,
	};
	settingsSections = [...settingsSections.filter((section) => section.key !== key), entry].sort((a, b) => a.order - b.order);
}

/** 插件加的、单独占导航一行的设置分区，按 order 排好；在导航哪一组看 `group`。变化经 usePluginUis 通知。 */
export function listSettingsSections(): readonly SettingsSectionEntry[] {
	return settingsSections.filter((section) => section.page === "nav");
}

/** 一个插件加的全部设置分区，按 order 排好：插件详情画没给 `page` 的，给了的列成去那里的入口。变化经 usePluginUis 通知。 */
export function listPluginSettingsSections(plugin: string): readonly SettingsSectionEntry[] {
	return settingsSections.filter((section) => section.plugin === plugin);
}

/** 插件画进产品某一页的设置分区，按 order 排好。变化经 usePluginUis 通知。 */
export function listPageSettingsSections(page: Exclude<SettingsSectionOptions["page"], "nav" | undefined>): readonly SettingsSectionEntry[] {
	return settingsSections.filter((section) => section.page === page);
}

/** 截屏浮层、钉图窗口里画的组件：各只用一个，后注册的生效，它撤下后前一个恢复。 */
const singles: {
	screenOverlay: Array<{ plugin: string; component: ComponentType<ScreenOverlayProps> }>;
	pinnedShot: Array<{ plugin: string; component: ComponentType<PinnedShotProps> }>;
} = { screenOverlay: [], pinnedShot: [] };

function registerSingle(kind: "screenOverlay" | "pinnedShot", plugin: string, component: unknown): void {
	// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
	if (typeof component !== "function") throw new Error(`${kind} 需要一个组件`);
	const taken = singles[kind].at(-1);
	if (taken) console.info(`[${plugin}] ${kind} 覆盖了 ${taken.plugin} 的`);
	// 两种组件的 props 不同，按 kind 取的是联合类型，TypeScript 认不出两边是同一种。
	singles[kind] = [...singles[kind].filter((entry) => entry.plugin !== plugin), { plugin, component }] as never;
}

export function screenOverlayComponent(): ComponentType<ScreenOverlayProps> | undefined {
	return singles.screenOverlay.at(-1)?.component;
}

export function pinnedShotComponent(): ComponentType<PinnedShotProps> | undefined {
	return singles.pinnedShot.at(-1)?.component;
}

/** 截屏的宿主能力：都在主进程，经预加载脚本调。快捷键按插件记，插件停用时撤掉。 */
function screenFor(plugin: string): ScreenCapture {
	return {
		start: async () => {
			// i18n-exempt：给插件作者的报错。
			if (singles.screenOverlay.length === 0) throw new Error("还没有插件注册截屏浮层（ui.screenOverlay）");
			return window.plume.screen.start();
		},
		setShortcut: (accelerator) => window.plume.screen.setShortcut(plugin, accelerator),
		pickDirectory: (title) => window.plume.screen.pickDirectory(title),
		desktopDirectory: () => window.plume.screen.desktopDirectory(),
	};
}

/** 插件给的组件画在宿主的视图里（`ConversationProps.tasks`）：出错时只丢这一块。 */
export function PluginPart({ plugin, children }: { plugin: string; children: ReactNode }) {
	return <Isolated plugin={plugin}>{children}</Isolated>;
}

/** 插件画的一小块出错时只丢它自己：记日志，什么都不画。 */
class Isolated extends Component<{ plugin: string; children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}
	componentDidCatch(error: unknown): void {
		console.error(`[${this.props.plugin}] 渲染出错：`, error);
	}
	render(): ReactNode {
		return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
	}
}

/** 插件登记的界面每变一次加一；工具卡片、页脚这些拿它当 key 重挂，所以只在登记变了时加。 */
let revision = 0;
/** 不改登记的变化（页面角标、面板的 `available` 答案）每次加一：只叫画它们的组件重画，不动 revision，免得画着的卡片跟着重挂。 */
let signals = 0;
const subscribers = new Set<() => void>();
const subscribe = (listener: () => void) => {
	subscribers.add(listener);
	return () => {
		subscribers.delete(listener);
	};
};

/** 插件界面有任何变化（登记、页面角标、面板可用性）都重画。返回值只表示「变了」，要当 key、缓存依赖的用 `usePluginRegistrations`。 */
export function usePluginUis(): number {
	return useSyncExternalStore(subscribe, () => revision + signals);
}

/** 登记的修订号：只在插件登记的界面变了时变。卡片、页脚拿它当 key 重挂，转录拿它重新分组。 */
export function usePluginRegistrations(): number {
	return useSyncExternalStore(subscribe, () => revision);
}

const skins = skinRegistry(setManagedSkin);

/** 插件逻辑入口经 ctx.serve 开的对象：每个方法都转成 AgentService.callPlugin，只能调到自己那个插件。 */
function pluginRemote<T extends object>(agent: Remote<AgentService>, name: string): Remote<T> {
	return new Proxy(
		{},
		{
			// `then` 必须是 undefined，否则 `await` 这个代理会把它当成 Promise。
			get: (_target, method) => (typeof method !== "string" || method === "then" ? undefined : (...args: unknown[]) => agent.callPlugin(name, method, args)),
		},
	) as Remote<T>;
}

const lifetimes = new Map<string, ReturnType<typeof uiLifetime>>();
const stopEvents = new WeakSet<Event>();

function context(name: string, agent: Remote<AgentService>): UiContext {
	const lifetime = uiLifetime((error) => console.error(`[${name}] 界面入口清理失败：`, error));
	lifetimes.set(name, lifetime);
	const owned = (dispose: () => void) => {
		if (!lifetime.active) {
			dispose();
			return;
		}
		lifetime.effect(dispose);
	};
	// i18n-exempt：注册表的种类名只拼进给插件作者的报错和日志。
	return {
		name,
		openSession: async (sessionId) => {
			if (!host) throw new Error("The conversation interface is not ready.");
			await host.openSession(String(sessionId));
		},
		codeBlock: (language, component, options) => {
			if (options?.copyText !== undefined && typeof options.copyText !== "function") throw new Error("copyText must be a function");
			const entry = register(codeBlocks, "正文代码块", name, language.trim().toLowerCase(), component, options);
			if (options?.copyText) codeCopies.set(entry, options.copyText);
		},
		toolCard: (tool, component, options) => {
			const entry = register(options?.match === "prefix" ? toolPrefixes : toolCards, "工具卡片", name, tool, component, options);
			const inline = options?.inline;
			if (inline === true || typeof inline === "function") inlineCards.set(entry, inline);
		},
		toolLine: (tool, line, options) => registerToolLine(name, tool, line, options),
		approvalCard: (tool, component, options) => register(approvalCards, "审批卡", name, tool, component, options),
		requestCard: (kind, component, options) => register(requestCards, "等人卡片", name, kind, component, options),
		panel: (id, component, options) => registerPanel(name, id, component, options),
		page: (id, component, options) => registerPage(name, id, component, options),
		skin: (skin) => {
			if (lifetime.active) skins.set(name, skin);
		},
		useTheme: () => useAppearance().theme ?? "system",
		setTheme: (theme) => {
			if (theme !== "system" && theme !== "light" && theme !== "dark") throw new Error(`Invalid theme ${String(theme)}`);
			if (lifetime.active) updateAppearance({ theme });
		},
		effect: lifetime.effect,
		composerItem: (id, component, options) => registerComposerItem(name, id, component, options),
		composerChip: (id, component, options) => registerComposerChip(name, id, component, options),
		composerAbove: (id, component, options) => registerComposerAbove(name, id, component, options),
		conversationCard: (id, component, options) => registerConversationCard(name, id, component, options),
		environmentSection: (id, component, options) => registerEnvironmentSection(name, id, component, options),
		useEnvironmentSections,
		sessionToolbar: (id, component) => {
			sessionToolbar.delete(`${name}/${id}`);
			register(sessionToolbar, "sessionToolbar", name, `${name}/${id}`, component);
		},
		sessionMenuItem: (id, item) => {
			if (!id || !validTitle(item?.label) || typeof item?.run !== "function") throw new Error("Invalid sessionMenuItem");
			const key = `${name}/${id}`;
			sessionMenuItems = [...sessionMenuItems.filter((entry) => entry.key !== key), { key, plugin: name, item }];
		},
		provide: (service, implementation) => provideUiService(name, service, implementation),
		useService: useUiService,
		agentDelivery: (component) => {
			if (typeof component !== "function" && (typeof component !== "object" || component === null)) throw new Error("Invalid agentDelivery");
			agentDeliveries = [...agentDeliveries.filter((entry) => entry.plugin !== name), { plugin: name, component }];
		},
		ProjectOpener,
		mentions: (provider) => {
			// i18n-exempt：只给插件作者的接口错误。
			if (typeof provider !== "function") throw new Error("mentions 需要一个函数");
			mentionProviders.set(name, provider);
		},
		composerHint: (hint) => registerComposerHint(name, hint),
		welcomeLine: (line) => registerWelcomeLine(name, line),
		replyText: (transform) => registerReplyText(name, transform),
		sessionMark: (component) => registerSessionMark(name, component),
		deleteNote: (note) => registerDeleteNote(name, note),
		linkOpener: (opener) => registerLinkOpener(name, opener),
		queueAction: (action) => registerQueueAction(name, action),
		quoteAction: (action) => {
			if (!validTitle(action?.label) || typeof action?.run !== "function") throw new Error("quoteAction requires label and run");
			quoteActions = [...quoteActions.filter((entry) => entry.plugin !== name), { plugin: name, action }];
		},
		quoteInPanel: (id, sessionId, quote) => {
			const key = `${name}/${String(id)}`;
			if (!panels.some((panel) => panel.key === key)) throw new Error("The plugin panel is not registered.");
			if (!quote || typeof quote.id !== "string" || typeof quote.text !== "string" || !["user", "assistant"].includes(quote.from))
				throw new Error("Invalid quote");
			host?.quoteInPanel(key, String(sessionId), quote);
		},
		terminalOpener: (open) => owned(registerTerminalOpener(name, open)),
		terminalRunner: (run) => owned(registerTerminalRunner(name, run)),
		onSessionsChanged: (listener) => {
			const dispose = subscribeSessionChanges(listener);
			owned(dispose);
			return dispose;
		},
		stopSession: async (sessionId, event) => {
			const source = event?.nativeEvent;
			if (
				!lifetime.active ||
				!(source instanceof Event) ||
				source.type !== "click" ||
				!source.isTrusted ||
				!navigator.userActivation.isActive ||
				stopEvents.has(source)
			)
				throw new Error("Stopping a session requires a user action");
			stopEvents.add(source);
			await agent.stop(String(sessionId));
		},
		ComposerSend,
		openMediaFile,
		revealMediaFile,
		revealMediaLabel,
		// 认不出的轻重按 info：提示条照样弹，不因为插件写错一个字就吞掉。
		notify: (message, level?: NotifyLevel) => notify(String(message), level === "warn" || level === "error" ? level : "info"),
		openPanel: (id, sessionId, options) =>
			host?.openPanel(`${name}/${String(id)}`, sessionId, {
				...(typeof options?.tab === "string" && options.tab ? { tab: options.tab } : {}),
				...(options?.background === true ? { background: true } : {}),
			}),
		closePanel: (id, sessionId, tab) => host?.closePanel(`${name}/${String(id)}`, sessionId, typeof tab === "string" ? tab : undefined),
		openFile: (path, sessionId) => openFile(path, undefined, sessionId),
		findFile: async (path, sessionId) => (typeof path === "string" && typeof sessionId === "string" ? await findFile(sessionId, path) : null),
		droppedPaths: (transfer) => droppedPaths(transfer, window.plume.files.pathFor),
		useFileMenu: usePathMenu,
		FileDiff: DiffView,
		FilePreview: PluginFilePreview,
		DocumentPreview,
		documentViewer: (extensions, component) => owned(registerDocumentViewer(extensions, component)),
		turnFooter: (id, component, options) => registerTurnFooter(name, id, component, options),
		replyAction: (id, component, options) => registerReplyAction(name, id, component, options),
		draftInSession: async (sessionId, draft: SessionDraft) => {
			if (!host) throw new Error("The conversation interface is not ready.");
			// 替人发出去只认人刚点过：插件在没人点的时候要求发，只放进草稿。先记下，打开会话要等一会儿。
			const send = draft?.send === true && navigator.userActivation.isActive;
			await host.draftInSession(sessionId === undefined ? undefined : String(sessionId), {
				text: String(draft?.text ?? ""),
				images: composerImages(draft?.images),
				send,
				replace: draft?.replace === true,
			});
		},
		revealToolCall: async (sessionId, toolCallId) => {
			if (!host) throw new Error("The conversation interface is not ready.");
			requestReveal(String(sessionId), String(toolCallId));
			await host.openSession(String(sessionId));
		},
		mediaUrl: (media, thumb) => {
			if (typeof media !== "string" || !MEDIA_NAME.test(media)) return "";
			const edge = Math.round(Number(thumb));
			return `plume-media://m/${media}${edge > 0 ? `?thumb=${edge}` : ""}`;
		},
		openImage: (images, index, options) => {
			const shown = Array.isArray(images)
				? images.flatMap((image) =>
						typeof image?.src === "string" && image.src
							? [
									{
										src: image.src,
										...(typeof image.alt === "string" ? { alt: image.alt } : {}),
										...(typeof image.onAttach === "function" ? { onAttach: image.onAttach } : {}),
									},
								]
							: [],
					)
				: [];
			const from = options?.from instanceof HTMLElement ? options.from : null;
			openViewer(shown, Number(index) || 0, from?.getBoundingClientRect() ?? null, from, options?.edit === true);
		},
		saveImage: async (src) => {
			await saveImage(String(src));
		},
		captureWindow,
		copyImage: async (src) => {
			await copyImage(String(src));
		},
		openConversationDraft: async (options) => {
			if (!host) throw new Error("The conversation interface is not ready.");
			await host.openConversationDraft(options);
		},
		openSettings: (id) => {
			const key = `${name}/${String(id)}`;
			if (!listSettingsSections().some((section) => section.key === key)) throw new Error("The plugin settings section is not registered.");
			host?.openSettings(key);
		},
		openPage: (id) => {
			const key = `${name}/${String(id)}`;
			if (!pages.some((page) => page.key === key)) throw new Error("The plugin page is not registered.");
			host?.openPage(key);
		},
		pageBadge: (id, badge) => setPageBadge(name, id, badge),
		openExternal: async (url) => {
			await window.plume.openExternal(externalWebUrl(url));
		},
		openPath: async (path) => {
			if (typeof path !== "string" || !path) throw new Error(translate("filePanel.unreadable"));
			const outcome = await window.plume.files.open(path);
			if (outcome === "failed") throw new Error(translate("filePanel.unreadableAt", { path }));
			// 主进程改成了在文件夹里指出来（直接打开会运行它）：说出来，不然这一下看起来像点错了。
			if (outcome === "revealed") notify(translate("attachment.revealedInstead", { name: path.split(/[/\\]/).at(-1) ?? path }), "warn");
		},
		revealPath: async (path) => {
			if (typeof path !== "string" || !path) throw new Error(translate("filePanel.unreadable"));
			// 系统对不存在的路径不报错、改开它的上级目录，看起来像指错了，先问一声。
			if (!(await window.plume.files.exists(path).catch(() => false))) throw new Error(translate("filePanel.unreadableAt", { path }));
			await window.plume.files.reveal(path);
		},
		openLink: async (url, sessionId) => {
			const href = externalWebUrl(url);
			const opener = clickOpener();
			if (opener) opener.open({ url: href }, typeof sessionId === "string" ? sessionId : undefined);
			else await window.plume.openExternal(href);
		},
		settingsSection: (id, component, options) => registerSettingsSection(name, id, component, options),
		screen: screenFor(name),
		screenOverlay: (component) => registerSingle("screenOverlay", name, component),
		pinnedShot: (component) => registerSingle("pinnedShot", name, component),
		useSession: useLiveSession,
		useSessionActivity,
		contextBreakdown: async (sessionId) => await agent.contextBreakdown(String(sessionId)),
		listCommands: async (given) => {
			const cwd = typeof given?.cwd === "string" && given.cwd ? given.cwd : undefined;
			const provided = await agent.listCommands(cwd ? { cwd } : {});
			// 只交命令本身；`action` 是输入框自己用的，插件拿去也做不了什么。
			return menuCommands(productCommands(translate), provided).map(({ name, description, argumentHint, source, plugin }) => ({
				name,
				description,
				...(argumentHint ? { argumentHint } : {}),
				...(source ? { source } : {}),
				...(plugin ? { plugin } : {}),
			}));
		},
		Conversation: HostConversation,
		ChatBackgroundSettings: PluginChatBackgroundSettings,
		Markdown: PluginMarkdown,
		ModelSelect: PluginModelSelect,
		ModelControls: PluginModelControls,
		useModelDefaults,
		useProjects: () => (host ? host.useProjects() : NO_PROJECTS),
		usePluginDisplayName: () => (host ? host.usePluginDisplayName() : NO_DISPLAY_NAME),
		remote: () => pluginRemote(agent, name),
	};
}

/** 已经装上界面的插件 → 它的界面入口地址。 */
const applied = new Map<string, string>();
/** 两次同步挨得近时排队，后一次按前一次的结果对账。 */
let syncing: Promise<void> = Promise.resolve();

/** 撤下一个插件登记的卡片、工具说法、面板、页面和皮肤。 */
function unloadPluginUi(name: string): void {
	lifetimes.get(name)?.dispose();
	lifetimes.delete(name);
	removeToolLines(name);
	for (const table of [codeBlocks, toolCards, toolPrefixes, approvalCards, requestCards] as Map<string, Entry<unknown>[]>[]) {
		for (const [tool, list] of table) {
			const kept = list.filter((entry) => entry.plugin !== name);
			if (kept.length > 0) table.set(tool, kept);
			else table.delete(tool);
		}
	}
	for (const panel of panels) if (panel.plugin === name) wantedShortcuts.delete(panel.key);
	panels = assignShortcuts(panels.filter((panel) => panel.plugin !== name));
	pages = pages.filter((page) => page.plugin !== name);
	for (const key of pageBadges.keys()) if (key.startsWith(`${name}/`)) pageBadges.delete(key);
	composerItems = composerItems.filter((item) => item.plugin !== name);
	composerChips = composerChips.filter((chip) => chip.plugin !== name);
	composerAbove = composerAbove.filter((entry) => entry.plugin !== name);
	conversationCards = conversationCards.filter((card) => card.plugin !== name);
	environmentSections = environmentSections.filter((entry) => !entry.key.startsWith(`${name}/`));
	for (const [key, entries] of sessionToolbar) if (entries.some((entry) => entry.plugin === name)) sessionToolbar.delete(key);
	sessionMenuItems = sessionMenuItems.filter((entry) => entry.plugin !== name);
	removeUiServices(name);
	agentDeliveries = agentDeliveries.filter((entry) => entry.plugin !== name);
	turnFooters = turnFooters.filter((entry) => entry.plugin !== name);
	replyActions = replyActions.filter((entry) => entry.plugin !== name);
	mentionProviders.delete(name);
	composerHints = composerHints.filter((entry) => entry.plugin !== name);
	welcomeLines = welcomeLines.filter((entry) => entry.plugin !== name);
	replyTransforms = replyTransforms.filter((entry) => entry.plugin !== name);
	sessionMarks = sessionMarks.filter((entry) => entry.plugin !== name);
	deleteNoteEntries = deleteNoteEntries.filter((entry) => entry.plugin !== name);
	linkOpeners = linkOpeners.filter((entry) => entry.plugin !== name);
	queueActions = queueActions.filter((entry) => entry.plugin !== name);
	quoteActions = quoteActions.filter((entry) => entry.plugin !== name);
	settingsSections = settingsSections.filter((section) => section.plugin !== name);
	singles.screenOverlay = singles.screenOverlay.filter((entry) => entry.plugin !== name);
	singles.pinnedShot = singles.pinnedShot.filter((entry) => entry.plugin !== name);
	void window.plume.screen.setShortcut(name, null);
	skins.remove(name);
	applied.delete(name);
}

/** 按插件状态装上、撤下界面入口，见文件开头的规则。 */
export function loadPluginUis(plugins: PluginStatus[], agent: Remote<AgentService>): Promise<void> {
	syncing = syncing.then(() => syncPluginUis(plugins, agent));
	return syncing;
}

async function syncPluginUis(plugins: PluginStatus[], agent: Remote<AgentService>): Promise<void> {
	let changed = false;
	for (const name of [...applied.keys()]) {
		const status = plugins.find((candidate) => candidate.name === name);
		if (status?.state === "active" && status.ui === applied.get(name)) continue;
		unloadPluginUi(name);
		changed = true;
	}
	for (const status of plugins) {
		if (status.state !== "active" || applied.has(status.name)) continue;
		try {
			const plugin = status.ui ? ((await import(/* @vite-ignore */ status.ui)) as { default?: UiPlugin }).default : undefined;
			if (!plugin) continue;
			// i18n-exempt：给插件作者的报错，被 loadPluginUis 接住只进日志，界面上不显示。
			if (plugin.name !== status.name) throw new Error(`界面入口的 name 是 ${String(plugin.name)}，和逻辑入口的 ${status.name} 不一致`);
			if (typeof plugin.apply !== "function") throw new Error("界面入口没有 apply");
			applied.set(status.name, status.ui ?? "");
			changed = true;
			plugin.apply(context(status.name, agent));
		} catch (error) {
			console.error(`[${status.name}] 界面入口加载失败：`, error);
			unloadPluginUi(status.name);
		}
	}
	if (!changed) return;
	notifyPluginUis();
	// 新装上的面板可能带着 available，先问一次再列出来。
	void checkPanels();
}

function notifyPluginUis(): void {
	revision += 1;
	for (const listener of subscribers) listener();
}

/** agent 进程给的工具表（`AgentService.listTools`、`tools` 事件）：工具的种类变了，转录按新的种类重新分组、换说法。 */
export function toolTableChanged(tools: RegisteredToolInfo[]): void {
	if (setToolTable(tools)) notifyPluginUis();
}

function notifyPluginSignals(): void {
	signals += 1;
	for (const listener of subscribers) listener();
}

/** 有插件给这个工具登记了卡片：画它的那一行时交给卡片（`ToolCardSlot`）。登记变了用 `usePluginUis` 的修订号重问。 */
export function hasToolCard(tool: string): boolean {
	return matchingToolCards(tool, toolCards, toolPrefixes).length > 0;
}

/** 这次调用在转录里单独一行，不和别的调用合成一段：登记了不是 `inline` 的卡片，或者 `inline` 的函数对这次说了 false。 */
export function ownsToolRow(call: { name: string; arguments: Record<string, unknown>; argumentsText?: string }): boolean {
	return matchingToolCards(call.name, toolCards, toolPrefixes).some((entry) => {
		const inline = inlineCards.get(entry);
		if (typeof inline !== "function") return !inline;
		// 插件的判断出错时按没说 inline 算：单独一行，卡片照常画出来。
		try {
			return !inline(call.arguments, call.argumentsText);
		} catch {
			return true;
		}
	});
}

// 登记变了就从头再试一遍注册者：key 换成新的修订号，Chain 里记的「试到第几个」跟着清掉。
export function ToolCardSlot(props: ToolCardProps) {
	const version = usePluginRegistrations();
	const entries = matchingToolCards(props.call.name, toolCards, toolPrefixes);
	const send: ToolCardProps["send"] = props.send
		? async (text, event, displayText) => {
				const current = matchingToolCards(props.call.name, toolCards, toolPrefixes);
				if (current.length !== entries.length || current.some((entry, index) => entry !== entries[index])) throw new Error("Tool card renderer is inactive");
				await props.send!(text, event, displayText);
			}
		: undefined;
	return <Chain key={version} entries={entries} props={{ ...props, send }} />;
}

/** 正文代码块只用最优先的注册者；解析或渲染失败直接回到源码。 */
export function CodeBlockSlot({ unregistered, ...props }: CodeBlockProps & { unregistered: ReactNode }) {
	const version = usePluginRegistrations();
	const entry = codeBlocks.get(props.language.toLowerCase())?.[0];
	if (!entry) return <>{unregistered}</>;
	const Render = entry.component;
	// 传入的闭包即使被插件保存，撤销注册后也不能再发消息。
	const send: CodeBlockProps["send"] = props.send
		? async (text, event) => {
				if (codeBlocks.get(props.language.toLowerCase())?.[0] !== entry) throw new Error("Code block renderer is inactive");
				await props.send!(text, event);
			}
		: undefined;
	return (
		<Isolated key={`${version}:${props.sessionId}:${props.messageId}:${props.blockId}:${props.complete}`} plugin={entry.plugin} fallback={props.fallback}>
			<Render {...props} {...(send ? { send } : {})} />
		</Isolated>
	);
}

/** 「接受并开启自动模式」：只从请求批准切到帮我批准，别的档不动，免得把完全访问降下来。 */
async function allowAuto(): Promise<void> {
	if (settingsView()?.permissionMode !== "ask") return;
	await modelsAgent().setPermissionMode("auto");
	await refreshModels();
}

/**
 * 等人决定的那一次：工具的插件登记了审批卡就由它画，渲染出错让给下一个，都不行用 `fallback`（产品的通用卡）。
 */
export function ApprovalCardSlot(props: Omit<ApprovalCardProps, "permission" | "allowAuto">) {
	const version = usePluginRegistrations();
	const permission = useSyncExternalStore(subscribeModels, settingsView)?.permissionMode ?? "auto";
	const entries = approvalCards.get(props.request.tool) ?? [];
	return <Chain key={`${version}:${props.request.toolCallId}`} entries={entries} props={{ ...props, permission, allowAuto }} />;
}

/** `run.request` 的卡：按 `kind` 找插件登记的，渲染出错让给下一个，都不行用 `fallback`（产品的通用卡）。 */
export function RequestCardSlot(props: Omit<RequestCardProps, "permission" | "allowAuto">) {
	const version = usePluginRegistrations();
	const permission = useSyncExternalStore(subscribeModels, settingsView)?.permissionMode ?? "auto";
	const entries = requestCards.get(props.request.kind) ?? [];
	return <Chain key={`${version}:${props.request.toolCallId}`} entries={entries} props={{ ...props, permission, allowAuto }} />;
}

/** 一个面板。出错时没有下一个可以让，就在这一格里说一声，别的面板和对话照常。换面板时 key 变，错误状态跟着清掉。 */
export function PanelSlot({ panel, props, owner }: { panel: PanelEntry; props: PanelProps; owner?: string | undefined }) {
	const owned = useLiveSession(owner);
	const { session: currentSession, cwd: currentCwd, ...rest } = props;
	const scoped = owner ? { ...rest, ...(owned ? { session: owned, cwd: owned.summary.cwd } : {}) } : props;
	const { t } = useI18n();
	const [failed, setFailed] = useState(false);
	if (failed) return <p className={`${text.error} px-4 py-3`}>{t("panel.failed")}</p>;
	const Panel = panel.component;
	return (
		<Boundary
			onError={(error) => {
				console.error(`[${panel.plugin}] 面板 ${panel.key} 渲染出错：`, error);
				setFailed(true);
			}}
		>
			<Panel {...scoped} />
		</Boundary>
	);
}

/** 一个页面。和面板一样，出错只在正文区里说一声。 */
export function PageSlot({ page, props }: { page: PageEntry; props: PageProps }) {
	const { t } = useI18n();
	const [failed, setFailed] = useState(false);
	if (failed) return <p className={`${text.error} px-8 py-6`}>{t("page.failed")}</p>;
	const Page = page.component;
	return (
		<Boundary
			onError={(error) => {
				console.error(`[${page.plugin}] 页面 ${page.key} 渲染出错：`, error);
				setFailed(true);
			}}
		>
			<Page {...props} />
		</Boundary>
	);
}

/** 依次尝试注册者：当前这个渲染出错就换下一个，都不行画 fallback。 */
function Chain<P extends { fallback: ReactNode }>({ entries, props }: { entries: Entry<P>[]; props: P }) {
	const [index, setIndex] = useState(0);
	const entry = entries[index];
	if (!entry) return <>{props.fallback}</>;
	const Card = entry.component;
	return (
		<Boundary
			key={index}
			onError={(error) => {
				console.error(`[${entry.plugin}] 卡片渲染出错，让给下一个：`, error);
				setIndex(index + 1);
			}}
		>
			<Card {...props} />
		</Boundary>
	);
}

class Boundary extends Component<{ onError(error: unknown): void; children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	override componentDidCatch(error: unknown): void {
		this.props.onError(error);
	}

	override render(): ReactNode {
		return this.state.failed ? null : this.props.children;
	}
}
