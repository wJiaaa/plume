/** 深浅模式只暂存在主进程，按渲染窗口记账；一个窗口撤下不影响其他窗口。 */
export class ThemeOverrides {
	private owners = new Map<number, "system" | "light" | "dark">();

	get mode(): "system" | "light" | "dark" | undefined {
		return Array.from(this.owners.values()).at(-1);
	}

	set(owner: number, mode: "system" | "light" | "dark" | null): void {
		if (this.owners.get(owner) === mode) return;
		this.owners.delete(owner);
		if (mode !== null) this.owners.set(owner, mode);
	}
}
