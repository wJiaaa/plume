/**
 * 现在是什么在压暗整个窗口。
 *
 * 在 Windows 和 Linux 上，最小化、最大化、关闭按钮由系统自己画在页面上方，颜色由应用交给它——页面里
 * 什么都盖不住它们。对话框的遮罩压暗了整个窗口，唯独右上角那一小块没暗，成了屏幕上最亮的地方。
 * 压暗窗口的东西在压暗期间在这里持有一个遮罩；画在页面之外的东西跟着它变。
 *
 * 只是一份状态，背后没有服务，这样 `ui/` 里的浮层能说出自己在做什么，又不越过自己这一层。
 */

export interface Scrim {
	/** `#rrggbb`。 */
	color: string;
	/** 盖住底下多少，0–1。 */
	alpha: number;
}

const held = new Set<Scrim>();
const listeners = new Set<() => void>();

/** 用这个遮罩压暗窗口，直到调用返回的释放函数。 */
export function holdScrim(color: string, alpha: number): () => void {
	const scrim = { color, alpha };
	held.add(scrim);
	notify();
	return () => {
		if (held.delete(scrim)) notify();
	};
}

/** 现在持有的遮罩，按铺下的顺序，第一个在最底下。 */
export function heldScrims(): Scrim[] {
	return [...held];
}

export function onScrimsChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function notify(): void {
	for (const listener of listeners) listener();
}
