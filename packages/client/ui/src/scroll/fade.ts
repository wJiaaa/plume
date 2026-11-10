/** 渐隐伸进去多深。下沿是内容流过的那条边——列表往下长，转录往那里输出——那里渐隐太浅读起来像一刀切。 */
const FADE_TOP = 36;
const FADE_BOTTOM = 48;

/** 几个窗格分一个矮窗口时，中间也要读得清。`depth` 覆盖某一边的默认值。 */
export function scrollFade(height: number, edge: "top" | "bottom", depth?: number): number {
	return Math.min(depth ?? (edge === "top" ? FADE_TOP : FADE_BOTTOM), Math.max(0, height) / 5);
}
