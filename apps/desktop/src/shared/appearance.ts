/**
 * 外观设置：主题、配色、会话背景。主进程存盘、开窗前设好 nativeTheme，渲染进程据此改 token、画背景。
 *
 * 只存用户改过的字段。没有的字段沿用 theme.css 的默认值（配色）或下面的 CHAT_BACKGROUND_DEFAULTS（会话背景），
 * 所以默认值只在一处，皮肤插件也照常生效，直到用户自己挑了颜色。
 */

type ThemeSource = "system" | "light" | "dark";
export type ChatBackgroundEffect = "none" | "dither" | "ascii" | "halftone" | "scanlines" | "haze";
export type ChatBackgroundFit = "cover" | "tile";

export interface Appearance {
	theme?: ThemeSource;
	accent?: string;
	lightBackground?: string;
	lightForeground?: string;
	darkBackground?: string;
	darkForeground?: string;
	uiFont?: string;
	uiFontSize?: number;
	pointerCursor?: boolean;
	vibrancy?: boolean;
	reduceMotion?: "system" | "on" | "off";
	/** 改动里加的、删的行怎么标：底色，或行首的 +/−（分不清红绿的人用）。 */
	diffMarkers?: "color" | "symbols";
	codeLightTheme?: string;
	codeDarkTheme?: string;
	codeFont?: string;
	codeFontSize?: number;
	codeLineHeight?: number;
	codeLetterSpacing?: number;
	inlineCode?: "app" | "syntax" | "custom";
	inlineCodeLightBg?: string;
	inlineCodeLightFg?: string;
	inlineCodeDarkBg?: string;
	inlineCodeDarkFg?: string;
	inlineCodeBorder?: boolean;
	/** 0–100，对应 --plume-contrast 的 0–1。 */
	contrast?: number;
	/** 主进程存下的文件名（见 CHAT_BACKGROUND_NAME），不是路径。 */
	chatBackground?: string;
	chatBackgroundOnNewChat?: boolean;
	chatBackgroundInChat?: boolean;
	chatBackgroundEffect?: ChatBackgroundEffect;
	chatBackgroundOpacity?: number;
	chatBackgroundFit?: ChatBackgroundFit;
}

/** 改外观时传的补丁：值为 null 表示删掉这一项，回到默认。 */
export type AppearancePatch = { [K in keyof Appearance]?: Appearance[K] | null };

const CHAT_BACKGROUND_EFFECTS: ReadonlySet<string> = new Set<ChatBackgroundEffect>(["none", "dither", "ascii", "halftone", "scanlines", "haze"]);
const CHAT_BACKGROUND_FITS: ReadonlySet<string> = new Set<ChatBackgroundFit>(["cover", "tile"]);

/** 浓度的两头。再淡就看不见了；再浓，正文压在上面就读不清。 */
const CHAT_BACKGROUND_OPACITY = { min: 0.05, max: 0.65 } as const;
/** 选图与拖拽共同的体积上限，读进内存之前先拦住过大的文件。 */
export const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024;

export const CHAT_BACKGROUND_DEFAULTS = {
	chatBackgroundOnNewChat: true,
	chatBackgroundInChat: true,
	chatBackgroundEffect: "none" as ChatBackgroundEffect,
	chatBackgroundOpacity: 0.24,
	chatBackgroundFit: "cover" as ChatBackgroundFit,
};

/** 主进程只认自己写下的文件名：渲染进程给的字符串不当路径用，`../` 之类的走不到文件系统。 */
export const CHAT_BACKGROUND_NAME = /^chat-\d+(?:-\d+)*\.(?:png|jpe?g|gif|webp)$/;

const HEX = /^#[0-9A-F]{6}$/;
const COLOR_KEYS = [
	"accent",
	"lightBackground",
	"lightForeground",
	"darkBackground",
	"darkForeground",
	"inlineCodeLightBg",
	"inlineCodeLightFg",
	"inlineCodeDarkBg",
	"inlineCodeDarkFg",
] as const;

/** 未设置的颜色、字体和尺寸仍由 token/皮肤决定；这里仅给不能从 CSS 读取的选项默认值。 */
export const CODE_DEFAULTS = {
	codeLightTheme: "plume-light",
	codeDarkTheme: "plume-dark",
	inlineCode: "app",
	inlineCodeLightBg: "#F4F4F5",
	inlineCodeLightFg: "#1C1C21",
	inlineCodeDarkBg: "#242424",
	inlineCodeDarkFg: "#EDEDED",
	inlineCodeBorder: false,
} as const;

const CODE_APPEARANCE_KEYS = [
	...(Object.keys(CODE_DEFAULTS) as (keyof typeof CODE_DEFAULTS)[]),
	"codeFont",
	"codeFontSize",
	"codeLineHeight",
	"codeLetterSpacing",
] as const;

/** 数据皮肤接管的仅是界面配色和深浅模式，用户原值留在设置里。 */
const MANAGED_COLOR_KEYS: ReadonlySet<string> = new Set([
	"theme",
	"accent",
	"lightBackground",
	"lightForeground",
	"darkBackground",
	"darkForeground",
	"contrast",
]);

export function editableAppearancePatch(patch: AppearancePatch, managed: boolean): AppearancePatch {
	return managed ? (Object.fromEntries(Object.entries(patch).filter(([key]) => !MANAGED_COLOR_KEYS.has(key))) as AppearancePatch) : patch;
}

/** 生效值与存盘值分开：字体、代码外观、背景图及其他偏好照常生效。 */
export function effectiveAppearance(appearance: Appearance, managed: boolean): Appearance {
	return editableAppearancePatch(appearance, managed) as Appearance;
}

/** 恢复默认撤销用户覆盖，不把出厂颜色写死在皮肤上方。 */
export function resetAppearancePatch(current: Appearance, codeOnly = false): AppearancePatch {
	const keys = codeOnly ? CODE_APPEARANCE_KEYS : Object.keys(current);
	return Object.fromEntries(keys.map((key) => [key, null])) as AppearancePatch;
}

const NUMBER_BOUNDS = {
	uiFontSize: [11, 20],
	codeFontSize: [10, 20],
	codeLineHeight: [1, 3],
	codeLetterSpacing: [-0.1, 0.2],
} as const;

/** 按字段校验，认不出的丢掉。存盘前、读盘后、渲染进程收到时都过一遍，坏文件不会把界面画坏。 */
export function cleanAppearance(input: unknown): Appearance {
	const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	const out: Appearance = {};
	if (raw.theme === "system" || raw.theme === "light" || raw.theme === "dark") out.theme = raw.theme;
	for (const key of COLOR_KEYS) {
		const value = raw[key];
		if (typeof value === "string" && HEX.test(value.toUpperCase())) out[key] = value.toUpperCase();
	}
	for (const key of ["uiFont", "codeFont"] as const) {
		const value = raw[key];
		if (typeof value === "string" && value.trim() !== "" && value.length <= 500) out[key] = value;
	}
	for (const key of Object.keys(NUMBER_BOUNDS) as (keyof typeof NUMBER_BOUNDS)[]) {
		const value = raw[key];
		const [min, max] = NUMBER_BOUNDS[key];
		if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.min(max, Math.max(min, value));
	}
	for (const key of ["codeLightTheme", "codeDarkTheme"] as const) {
		if (typeof raw[key] === "string" && /^[a-z0-9-]{1,64}$/.test(raw[key])) out[key] = raw[key];
	}
	if (typeof raw.pointerCursor === "boolean") out.pointerCursor = raw.pointerCursor;
	if (typeof raw.vibrancy === "boolean") out.vibrancy = raw.vibrancy;
	if (raw.reduceMotion === "system" || raw.reduceMotion === "on" || raw.reduceMotion === "off") out.reduceMotion = raw.reduceMotion;
	if (raw.diffMarkers === "color" || raw.diffMarkers === "symbols") out.diffMarkers = raw.diffMarkers;
	if (raw.inlineCode === "app" || raw.inlineCode === "syntax" || raw.inlineCode === "custom") out.inlineCode = raw.inlineCode;
	if (typeof raw.inlineCodeBorder === "boolean") out.inlineCodeBorder = raw.inlineCodeBorder;
	if (typeof raw.contrast === "number" && Number.isFinite(raw.contrast)) out.contrast = Math.round(Math.min(100, Math.max(0, raw.contrast)));
	if (typeof raw.chatBackground === "string" && CHAT_BACKGROUND_NAME.test(raw.chatBackground)) out.chatBackground = raw.chatBackground;
	if (typeof raw.chatBackgroundOnNewChat === "boolean") out.chatBackgroundOnNewChat = raw.chatBackgroundOnNewChat;
	if (typeof raw.chatBackgroundInChat === "boolean") out.chatBackgroundInChat = raw.chatBackgroundInChat;
	if (typeof raw.chatBackgroundEffect === "string" && CHAT_BACKGROUND_EFFECTS.has(raw.chatBackgroundEffect))
		out.chatBackgroundEffect = raw.chatBackgroundEffect as ChatBackgroundEffect;
	if (typeof raw.chatBackgroundOpacity === "number" && Number.isFinite(raw.chatBackgroundOpacity)) {
		out.chatBackgroundOpacity = Math.min(CHAT_BACKGROUND_OPACITY.max, Math.max(CHAT_BACKGROUND_OPACITY.min, raw.chatBackgroundOpacity));
	}
	if (typeof raw.chatBackgroundFit === "string" && CHAT_BACKGROUND_FITS.has(raw.chatBackgroundFit))
		out.chatBackgroundFit = raw.chatBackgroundFit as ChatBackgroundFit;
	return out;
}

/** 补丁合进当前值：null 删掉那一项，其余覆盖，最后整体校验一遍。 */
export function patchAppearance(current: Appearance, patch: AppearancePatch): Appearance {
	const next: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null || value === undefined) delete next[key];
		else next[key] = value;
	}
	return cleanAppearance(next);
}
