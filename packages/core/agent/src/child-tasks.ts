/**
 * 子会话交给父会话的那几件事走到了哪（`ChildTask`），建子会话的插件照它画（`ConversationProps.tasks`）。
 *
 * 还排着的就是父会话队列里带着 `childId` 的那几条，不在这里另记一份：排着时被人删掉、拖动、「现在就发」都只改队列，
 * 两份对不上的时候就没有。离开队列开始跑以后，状态只有这里有：在跑、做完、失败、随父会话停下。只在内存里，
 * 重开应用就没了（还排着的跟着队列落盘，照样在）。
 */

import type { ChildTask, QueuedMessage, TurnStop } from "@plume/contract";

/** 一轮怎么收的场，落到这件事上是什么。正常返回不等于做完：打转、用满步数都没出错，也没做完，记成失败，好让人重试。 */
function settledAs(stop: TurnStop): Pick<ChildTask, "status" | "error" | "unfinished" | "cancelledBy"> {
	switch (stop.reason) {
		case "done":
			return { status: "done" };
		case "aborted":
		case "interrupted":
			return { status: "cancelled", cancelledBy: "stop" };
		case "error":
			return { status: "failed", ...(stop.error ? { error: stop.error } : {}) };
		default:
			return { status: "failed", unfinished: stop.reason };
	}
}

/** 失败的、随父会话停下的能重新排进去；人自己收回的、做完的不行（再要一遍是新交一件）。 */
function resumable(task: ChildTask): boolean {
	return task.status === "failed" || (task.status === "cancelled" && task.cancelledBy === "stop");
}

export class ChildTasks {
	/** 子会话 → 它交出去、已经离开队列的那几件，先开始的在前。 */
	private readonly started = new Map<string, ChildTask[]>();
	/** 父会话 → 往它这里交过事的子会话：父会话的队列变了，要告诉的是这几个。 */
	private readonly sides = new Map<string, Set<string>>();

	constructor(private readonly changed: (childId: string) => void) {}

	/** 子会话往父会话交了一件（排进了队列）。 */
	handed(parentId: string, childId: string): void {
		let sides = this.sides.get(parentId);
		if (!sides) this.sides.set(parentId, (sides = new Set()));
		sides.add(childId);
	}

	/** 交过事的子会话：父会话的队列变了时挨个告诉。 */
	sidesOf(parentId: string): string[] {
		return [...(this.sides.get(parentId) ?? [])];
	}

	/** 排着的那一条轮到了：父会话开始为它跑一轮。返回的这份在这一轮收场时交回 `settle`。 */
	start(entry: QueuedMessage & { childId: string }): ChildTask {
		const task: ChildTask = {
			id: entry.id,
			text: entry.message.displayText ?? entry.preview,
			status: "running",
			createdAt: entry.createdAt,
			startedAt: Date.now(),
		};
		this.started.set(entry.childId, [...(this.started.get(entry.childId) ?? []), task]);
		this.changed(entry.childId);
		return task;
	}

	/** 那一轮收了场。已经被别处定了（拿掉了）的不改。 */
	settle(childId: string, task: ChildTask, stop: TurnStop): void {
		if (task.status !== "running" || !this.started.get(childId)?.includes(task)) return;
		Object.assign(task, settledAs(stop), { finishedAt: Date.now() });
		this.changed(childId);
	}

	/** 全部：离开队列的在前，还排着的（父会话队列里这个子会话交的）在后。 */
	list(childId: string, queue: readonly QueuedMessage[]): ChildTask[] {
		const queued = queue
			.filter((entry) => entry.childId === childId)
			.map((entry): ChildTask => ({ id: entry.id, text: entry.message.displayText ?? entry.preview, status: "queued", createdAt: entry.createdAt }));
		return [...(this.started.get(childId) ?? []).map((task) => ({ ...task })), ...queued];
	}

	/** 「重试」「继续」：从列表里拿出来，由调用方重新排进父会话。不能继续的不动。 */
	takeResumable(childId: string, taskId: string): ChildTask | undefined {
		const task = this.started.get(childId)?.find((item) => item.id === taskId);
		if (!task || !resumable(task)) return undefined;
		this.remove(childId, task);
		return task;
	}

	/** 「移除」：收了场的才能拿掉，在跑的拿掉了，屏上就没有东西说它还在跑。 */
	dismiss(childId: string, taskId: string): boolean {
		const task = this.started.get(childId)?.find((item) => item.id === taskId);
		if (!task || task.status === "running") return false;
		this.remove(childId, task);
		this.changed(childId);
		return true;
	}

	/** 父会话的清单作废了：交过去、还能继续的那几件算人收回，「继续」不再把它们拉回来。 */
	discard(parentId: string): void {
		for (const childId of this.sidesOf(parentId)) {
			const tasks = (this.started.get(childId) ?? []).filter(resumable);
			for (const task of tasks) Object.assign(task, { status: "cancelled", cancelledBy: "user" } satisfies Partial<ChildTask>);
			if (tasks.length > 0) this.changed(childId);
		}
	}

	/** 会话删掉了：作为子会话交的、作为父会话收的都不再记。 */
	forget(sessionIds: readonly string[]): void {
		for (const id of sessionIds) {
			this.started.delete(id);
			this.sides.delete(id);
			for (const sides of this.sides.values()) sides.delete(id);
		}
	}

	private remove(childId: string, task: ChildTask): void {
		const rest = (this.started.get(childId) ?? []).filter((item) => item !== task);
		if (rest.length > 0) this.started.set(childId, rest);
		else this.started.delete(childId);
	}
}
