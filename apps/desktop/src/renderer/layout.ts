/**
 * 外壳按窗口宽度换形状，不只是挤：窗口能从全屏一直缩到 380px。
 *
 *   regular  ≥760  侧栏推开正文，可以收起、可以拖宽度
 *   compact  <760  侧栏变成盖在正文上的抽屉，默认关着，选完东西自己收起
 *
 * 面板在空间够时与正文并排；横向不够、纵向够时上下排列；compact 一次只显示正文或面板。
 * 全屏和单面板模式只隐藏正文，不卸载会话；按 Esc 恢复或收起面板。
 *
 * 侧栏、面板的宽度和收没收起是偏好，记在 localStorage 里，下次打开照旧；抽屉开没开不记。
 */

export const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 248;
/** 窄于这个宽度，侧栏和一列读得下去的正文就摆不下了。 */
const COMPACT_MAX = 760;
/** 推开模式下正文至少留这么宽，侧栏、面板的宽度偏好在这之后才算数。 */
const CONTENT_MIN = 420;

export const PANEL_MIN = 300;
/** 尚未量过工作区时为 0，首次显示按工作区的四成定宽。 */
const PANEL_DEFAULT = 0;

export type LayoutMode = "compact" | "regular";

export function layoutMode(windowWidth: number): LayoutMode {
	return windowWidth < COMPACT_MAX ? "compact" : "regular";
}

/**
 * 侧栏实际画多宽。偏好只按自己的上下限夹；装不装得下还看窗口，这里再收窄，但不改写偏好——
 * 窗口拉宽回来侧栏就回到原来的宽度。
 */
export function sidebarWidthFor(preferred: number, windowWidth: number): number {
	return clamp(preferred, SIDEBAR_MIN, Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, windowWidth - CONTENT_MIN)));
}

/** 面板能不能并排推开正文：sidebar 是侧栏实际推开的宽度（收起或抽屉时为 0），除掉它还摆得下正文和最窄的面板。 */
function panelDocked(windowWidth: number, sidebar: number): boolean {
	return windowWidth - sidebar - PANEL_MIN >= CONTENT_MIN;
}

/** 实际尺寸不改写偏好，窗口拉宽后恢复；双方保留最小可读宽度，不设固定像素上限。 */
export function panelWidthFor(preferred: number, windowWidth: number, sidebar: number): number {
	const available = Math.max(0, windowWidth - sidebar);
	const desired = clamp(preferred > 0 ? preferred : available * 0.4, available * 0.15, available * 0.85);
	return panelDocked(windowWidth, sidebar) ? clamp(desired, PANEL_MIN, available - CONTENT_MIN) : Math.min(PANEL_MIN, available);
}

/** 横向装不下但高度够就上下排列；compact 一次只显示正文或面板，不卸载另一块。 */
export function panelArrangement(windowWidth: number, height: number, sidebar: number): "row" | "column" | "single" {
	if (layoutMode(windowWidth) === "compact") return "single";
	return !panelDocked(windowWidth, sidebar) && height >= 260 + 150 && windowWidth - sidebar >= CONTENT_MIN ? "column" : "row";
}

export function panelHeightFor(share: number, height: number): number {
	return clamp(height * clamp(share, 0.15, 0.85), 150, height - 260);
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// ── 偏好 ────────────────────────────────────────────────────────────

export interface SidebarPrefs {
	open: boolean;
	width: number;
}

const PREFS_KEY = "plume.sidebar";

export function readSidebarPrefs(): SidebarPrefs {
	try {
		const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<SidebarPrefs>;
		return {
			open: raw.open !== false,
			width: typeof raw.width === "number" ? clamp(raw.width, SIDEBAR_MIN, SIDEBAR_MAX) : SIDEBAR_DEFAULT,
		};
	} catch {
		return { open: true, width: SIDEBAR_DEFAULT };
	}
}

export function writeSidebarPrefs(prefs: SidebarPrefs): void {
	localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export interface PanelPrefs {
	open: boolean;
	width: number;
}

const PANEL_PREFS_KEY = "plume.panel";

export function readPanelPrefs(): PanelPrefs {
	try {
		const raw = JSON.parse(localStorage.getItem(PANEL_PREFS_KEY) ?? "{}") as Partial<PanelPrefs>;
		return {
			open: raw.open === true,
			width: typeof raw.width === "number" && Number.isFinite(raw.width) && raw.width > 0 ? Math.max(PANEL_MIN, raw.width) : PANEL_DEFAULT,
		};
	} catch {
		return { open: false, width: PANEL_DEFAULT };
	}
}

export function writePanelPrefs(prefs: PanelPrefs): void {
	localStorage.setItem(PANEL_PREFS_KEY, JSON.stringify(prefs));
}

interface PanelTabPrefs {
	id: string;
	panel?: string;
	title?: string;
	sessionId?: string;
	file?: { path: string; sessionId: string };
}

export interface PanelTabsPrefs {
	tabs: PanelTabPrefs[];
	active: string;
}

const PANEL_TABS_KEY = "plume.panel-tabs";

/** 面板标签属于会话，重开应用后仍应回到上次看的那一组。空白会话不落盘。 */
export function readPanelTabs(): Record<string, PanelTabsPrefs> {
	try {
		const raw = JSON.parse(localStorage.getItem(PANEL_TABS_KEY) ?? "{}") as Record<string, unknown>;
		const result: Record<string, PanelTabsPrefs> = {};
		for (const [scope, value] of Object.entries(raw)) {
			if (!scope || !value || typeof value !== "object") continue;
			const candidate = value as { tabs?: unknown; active?: unknown };
			if (!Array.isArray(candidate.tabs) || typeof candidate.active !== "string") continue;
			const tabs = candidate.tabs.flatMap((tab): PanelTabPrefs[] => {
				if (!tab || typeof tab !== "object") return [];
				const item = tab as Record<string, unknown>;
				if (typeof item.id !== "string" || item.id === "") return [];
				return [
					{
						id: item.id,
						...(typeof item.panel === "string" ? { panel: item.panel } : {}),
						...(typeof item.title === "string" ? { title: item.title } : {}),
						...(typeof item.sessionId === "string" ? { sessionId: item.sessionId } : {}),
						...(item.file &&
						typeof item.file === "object" &&
						"path" in item.file &&
						typeof item.file.path === "string" &&
						"sessionId" in item.file &&
						typeof item.file.sessionId === "string"
							? { file: { path: item.file.path, sessionId: item.file.sessionId } }
							: {}),
					},
				];
			});
			if (tabs.some((tab) => tab.id === candidate.active)) result[scope] = { tabs, active: candidate.active };
		}
		return result;
	} catch {
		return {};
	}
}

export function writePanelTabs(prefs: Record<string, PanelTabsPrefs>): void {
	try {
		const persisted = Object.fromEntries(Object.entries(prefs).filter(([scope]) => scope !== ""));
		localStorage.setItem(PANEL_TABS_KEY, JSON.stringify(persisted));
	} catch {
		// 标签状态不能影响面板的打开和关闭。
	}
}
