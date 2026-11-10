/** 每次界面入口有自己的生命周期；先失效再清理，异步回调不能重新登记。 */
export function uiLifetime(onError: (error: unknown) => void) {
	let active = true;
	const effects: Array<() => void> = [];
	return {
		get active() {
			return active;
		},
		effect(dispose: () => void): void {
			if (typeof dispose !== "function") throw new Error("effect requires a cleanup function");
			if (active) effects.push(dispose);
			else {
				try {
					dispose();
				} catch (error) {
					onError(error);
				}
			}
		},
		dispose(): void {
			if (!active) return;
			active = false;
			for (const dispose of effects.reverse()) {
				try {
					dispose();
				} catch (error) {
					onError(error);
				}
			}
			effects.length = 0;
		},
	};
}
