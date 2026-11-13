/**
 * 撤销和改动之间的门闩：撤销在写回文件时，工具不能同时改文件、命令不能同时跑、新的一问不能同时开始；反过来，还有改动在进行时不能开始撤销。
 *
 * 项目可以嵌套，文件也可能经硬链接共享，按文件锁挡不住，所以一个 agent 只有一把：`Workspace` 持有它，写文件（`text-file.ts`）、
 * 观测命令（`command-changes.ts`）、撤销（`change-store.ts`）和发一问（`@plume/agent` 的 `submitPrompt`）都经它。
 */

export class ChangeLock {
	private undoing = false;
	private mutations = 0;
	private prompts = 0;

	/** 门闩被占着时给人看的话：`busy` 正在撤销，`running` 还有改动在进行。 */
	constructor(private readonly words: () => { undoBusy: string; undoRunning: string }) {}

	/** 一次改动（写文件、跑一条要记改动的命令）开始；撤销中抛错。返回的函数结束它，调几次都只算一次。 */
	beginMutation(): () => void {
		if (this.undoing) throw new Error(this.words().undoBusy);
		this.mutations++;
		return this.releaser(() => this.mutations--);
	}

	/** 开始撤销；撤销中、还有改动或新的一问在进行时抛错。 */
	beginUndo(): () => void {
		if (this.undoing) throw new Error(this.words().undoBusy);
		if (this.mutations || this.prompts) throw new Error(this.words().undoRunning);
		this.undoing = true;
		return this.releaser(() => (this.undoing = false));
	}

	/** 一问正在送进会话；撤销中返回 undefined（这一问该拦下）。 */
	beginPrompt(): (() => void) | undefined {
		if (this.undoing) return undefined;
		this.prompts++;
		return this.releaser(() => this.prompts--);
	}

	private releaser(release: () => void): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			release();
		};
	}
}
