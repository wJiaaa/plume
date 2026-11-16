import type { CallContext, PluginContext, RegisteredToolInfo, SessionMessage, ToolOutput, TurnStop } from "@plume/contract";
import type { AgentDefinition } from "./agents.ts";
import type { AgentCatalog, SubagentsApi } from "./api.ts";
import type { AgentDefinitions, AgentRecord, AgentSave } from "./definitions.ts";
import { atCheckpoint, completed, latestTodos, openSegment, planDemand, SALVAGE_STEPS, segmentRounds, type Segment } from "./checkpoint.ts";
import { DELIVERY_HEAD, deliveryBlock, deliveryTail, type DeliveryDetails } from "./delivery.ts";
import { MESSAGES } from "./messages.ts";
import { Store } from "./store.ts";
import { isActive, lastProse, type Dispatch, type Face, type ModelChoice, type TaskRecord } from "./types.ts";
import { finalDemand, HANDOFF_SCHEMA, incompleteNote, judgeYield, renderYield } from "./yield.ts";

export const MAX_RUNNING = 4;

export class Registry implements SubagentsApi {
	private readonly store: Store;
	/**
	 * 正在派、正在跑、还没交完回报的任务：它们的对象在几处异步步骤之间共用，按停、删会话改的是同一个。
	 * 结束了的只在库里，要用时现读。
	 */
	private readonly live = new Map<string, TaskRecord>();
	private active = true;
	private readonly occupied = new Set<string>();
	private readonly cancelled = new Set<string>();
	private readonly epochs = new Map<string, number>();
	private readonly listeners = new Set<() => void>();
	private readonly jobs = new Set<Promise<void>>();
	/** 这一次运行里调过几次 `yield`：每次派发、续跑重新数。 */
	private readonly attempts = new Map<string, number>();
	/** 这一次运行的检查点：每段几步、上一个检查点在哪、清单推进到哪、讨交接用了几步。 */
	private readonly segments = new Map<string, Segment>();

	private readonly ctx: PluginContext;
	private readonly definitions: AgentDefinitions;

	constructor(ctx: PluginContext, definitions: AgentDefinitions) {
		this.ctx = ctx;
		this.definitions = definitions;
		this.store = new Store(ctx.dataDir);
		ctx.sessions.onStopped((id) => {
			this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
			const touched = [...this.live.values()].filter((task) => task.parent === id || task.session === id);
			for (const task of touched) this.cancel(task);
			this.changed(...touched);
		});
		ctx.sessions.onDeleted((id) => {
			this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
			for (const task of this.live.values()) {
				if (task.parent !== id && task.session !== id) continue;
				this.cancel(task, false);
				if (task.parent === id) this.live.delete(task.id);
			}
			this.store.deleteByParent(id);
			// 子会话没了：不能再续跑，回报和展示照留。
			const orphans = this.store.bySession(id).map((stored) => this.live.get(stored.id) ?? stored);
			for (const task of orphans) task.resumable = false;
			this.changed(...orphans);
			this.pump();
		});
		ctx.effect(async () => {
			this.active = false;
			const touched = [...this.live.values()];
			for (const task of touched) this.cancel(task);
			this.changed(...touched);
			await Promise.allSettled(this.jobs);
			this.store.close();
		});
	}

	async restore(): Promise<void> {
		const sessions = await this.ctx.sessions.list();
		const children = new Set(
			sessions.flatMap((session) => (session.owner === this.ctx.name && session.parentId ? [`${session.id}\n${session.parentId}`] : [])),
		);
		const touched = this.store.reconcile(
			sessions.map((session) => session.id),
			[...children],
		);
		for (const task of touched) {
			task.resumable &&= children.has(`${task.session}\n${task.parent}`);
			if (isActive(task)) {
				task.state = "stopped";
				task.stop = { reason: "interrupted" };
				task.endedAt = Date.now();
				delete task.pending;
			}
		}
		this.changed(...touched);
	}

	/** 库里的就是最新的：在跑的任务每改一次都写回去。 */
	list(parentId: string): TaskRecord[] {
		return this.store.byParent(parentId);
	}

	async *watch(parentId: string, call: CallContext): AsyncGenerator<TaskRecord[], void> {
		let dirty = true;
		let wake: (() => void) | undefined;
		const changed = () => {
			dirty = true;
			wake?.();
		};
		this.listeners.add(changed);
		call.signal.addEventListener("abort", changed, { once: true });
		try {
			while (!call.signal.aborted && this.active) {
				if (!dirty)
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				wake = undefined;
				if (call.signal.aborted || !this.active) break;
				dirty = false;
				yield this.list(parentId);
			}
		} finally {
			this.listeners.delete(changed);
			call.signal.removeEventListener("abort", changed);
		}
	}

	identity(sessionId: string): TaskRecord | undefined {
		for (const task of this.live.values()) if (task.session === sessionId && task.resumable) return task;
		return this.store.bySession(sessionId).find((task) => task.resumable && !this.live.has(task.id));
	}

	/** 这个目录下能派的种类：生效的那份定义，关掉的不算。 */
	async enabled(cwd: string): Promise<AgentDefinition[]> {
		return (await this.definitions.list(cwd)).map(({ definition }) => definition).filter((definition) => !this.store.disabled.has(definition.name));
	}

	async faces(parentId: string): Promise<Face[]> {
		const cwd = (await this.ctx.sessions.get(parentId))?.cwd ?? null;
		return (await this.definitions.list(cwd)).map(({ definition }) => ({ name: definition.name, ...(definition.avatar ? { avatar: definition.avatar } : {}) }));
	}

	async catalog(project: string | null): Promise<AgentCatalog> {
		return {
			records: await this.definitions.list(project),
			tools: this.tools().map(({ name, kind }) => ({ name, ...(kind ? { kind } : {}) })),
			choices: structuredClone(this.store.choices),
			disabled: [...this.store.disabled],
			models: await this.ctx.sessions.models(),
		};
	}

	read(project: string | null, id: string): Promise<AgentRecord> {
		return this.definitions.read(project, id);
	}

	async save(project: string | null, input: AgentSave): Promise<void> {
		await this.definitions.save(
			project,
			input,
			this.tools().map((tool) => tool.name),
		);
		this.changed();
	}

	async remove(project: string | null, id: string, revision: string): Promise<void> {
		await this.definitions.remove(project, id, revision);
		this.changed();
	}

	setEnabled(agent: string, enabled: boolean): void {
		if (typeof agent !== "string" || !agent) throw new Error(MESSAGES[this.ctx.locale()].unavailable);
		this.store.setDisabled(agent, !enabled);
		this.changed();
	}

	/** 定义里能挑的工具：派发和停止子智能体的两样子智能体本来就用不了，交差用的 `yield` 每一种都有，都不列。 */
	private tools(): RegisteredToolInfo[] {
		return this.ctx.tools.list().filter(({ name }) => name !== "task" && name !== "stop_subagent" && name !== "yield");
	}

	async dispatch(parentId: string, cwd: string, description: string, prompt: string, agent: string, resume?: string): Promise<Dispatch> {
		if (!this.active) throw new Error("Sub-agent plugin has stopped.");
		const epoch = this.epochs.get(parentId) ?? 0;
		let task: TaskRecord;
		if (resume) {
			const earlier = this.live.get(resume) ?? this.store.get(resume);
			if (!earlier || earlier.parent !== parentId || !earlier.resumable) throw new Error("This sub-agent cannot be resumed. Dispatch a new one instead.");
			if (isActive(earlier) || this.occupied.has(earlier.id))
				throw new Error("This sub-agent is still running or settling its report; do not resume or dispatch it again.");
			task = earlier;
			this.live.set(task.id, task);
			task.attempt++;
		} else {
			const agents = await this.enabled(cwd);
			const definition = agents.find((entry) => entry.name === agent);
			if (!definition) throw new Error(`Unknown subagent_type "${agent}". Available: ${agents.map((entry) => entry.name).join(", ")}`);
			const choice = this.store.choices[agent] ?? {};
			await this.validateChoice(choice);
			// 设置里选的模型优先；没选时用定义里写的，这台机器上没有那个模型就跟着主会话。
			const defined = definition.model && (await this.ctx.sessions.models()).some((entry) => entry.id === definition.model) ? definition.model : undefined;
			const model = choice.model ?? defined;
			const child = await this.ctx.sessions.create({
				parentId,
				title: description,
				...(model ? { model } : {}),
				...(choice.thinking ? { thinking: choice.thinking } : {}),
			});
			task = {
				id: child.id,
				session: child.id,
				parent: parentId,
				agent,
				description,
				prompt,
				identity: {
					prompt: definition.prompt,
					tools: definition.tools,
					...(definition.output ? { output: definition.output } : {}),
					...(definition.schemaMode ? { schemaMode: definition.schemaMode } : {}),
					...(definition.maxTurns ? { maxTurns: definition.maxTurns } : {}),
				},
				state: "queued",
				createdAt: Date.now(),
				attempt: 1,
				reported: false,
				resumable: true,
				thinking: child.thinking,
			};
			this.live.set(task.id, task);
			// 建子会话的那一会儿父会话被删了：这条任务不留。放进 `live` 以后再删的，删会话时会把它拿走，同样不留。
			if (epoch !== (this.epochs.get(parentId) ?? 0) && (!(await this.ctx.sessions.get(parentId)) || this.live.get(task.id) !== task)) {
				if (this.live.get(task.id) === task) this.live.delete(task.id);
				throw new Error("The parent conversation was deleted.");
			}
		}
		this.cancelled.delete(task.id);
		task.state = "queued";
		task.reported = false;
		task.pending = { content: [{ type: "text", text: prompt }], origin: "parent" };
		delete task.runId;
		delete task.stop;
		// 上一段交的东西说的是上一段：这一段什么都没交的话，不能把旧的那份当成新结论。
		delete task.answer;
		delete task.answerTimestamp;
		delete task.output;
		delete task.warnings;
		delete task.incomplete;
		delete task.error;
		this.attempts.delete(task.id);
		this.segments.delete(task.id);
		delete task.startedAt;
		delete task.endedAt;
		if (!this.active || epoch !== (this.epochs.get(parentId) ?? 0)) this.cancel(task);
		this.changed(task);
		this.pump();
		return { id: task.id, session: task.session, parent: task.parent, agent: task.agent };
	}

	stop(sessionId: string): void {
		const task = this.identity(sessionId);
		if (!task) throw new Error(MESSAGES[this.ctx.locale()].unavailable);
		this.cancel(task);
		this.changed(task);
		this.pump();
	}

	async steer(sessionId: string, message: SessionMessage): Promise<void> {
		const task = this.identity(sessionId);
		if (!this.active || task?.state !== "running" || !task.runId) throw new Error(MESSAGES[this.ctx.locale()].gone);
		// 来源只能由派发工具赋予，面板里的插话始终是用户说的话。
		await this.ctx.sessions.steer(sessionId, { content: message.content, displayText: message.displayText, attachments: message.attachments });
	}

	async setModel(agent: string, choice: ModelChoice): Promise<void> {
		if (typeof agent !== "string" || !agent) throw new Error(MESSAGES[this.ctx.locale()].unavailable);
		await this.validateChoice(choice);
		this.store.setChoice(agent, { model: choice.model || undefined, thinking: choice.thinking });
		this.changed();
	}

	/** 子智能体调了 `yield`：按它派发时的输出结构判一次，收下的记在任务上，跑完时交回。 */
	yielded(sessionId: string, args: Record<string, unknown>): ToolOutput {
		const task = this.identity(sessionId);
		// i18n-exempt：发给模型的工具结果。
		if (!task || !isActive(task)) return { output: "`yield` only works in a running sub-agent.", isError: true };
		const attempt = (this.attempts.get(task.id) ?? 0) + 1;
		this.attempts.set(task.id, attempt);
		const verdict = judgeYield(args, task.identity.output ?? HANDOFF_SCHEMA, task.identity.output ? task.identity.schemaMode : "permissive", attempt);
		if (verdict.accepted) {
			task.output = verdict.accepted.value;
			task.warnings = verdict.accepted.warnings;
			this.changed(task);
		}
		return { output: verdict.output, ...(verdict.isError ? { isError: true } : {}), ...(verdict.terminate ? { terminate: "done" as const } : {}) };
	}

	/** 在讨交接时是讨交接已经用了几步（这两步里除了 `yield` 什么都不执行），不在讨时为空。 */
	salvage(sessionId: string): number | undefined {
		const task = this.identity(sessionId);
		return task && this.segments.get(task.id)?.salvage;
	}

	/** 讨交接的一步收尾了：记上一步。不在讨交接时返回 false。 */
	salvageStep(sessionId: string): boolean {
		const task = this.identity(sessionId);
		const segment = task && this.segments.get(task.id);
		if (segment?.salvage === undefined) return false;
		segment.salvage++;
		return true;
	}

	/**
	 * 一步收尾、还要接着做时看一眼：到了检查点按清单定接着跑、让它列清单，还是停下讨交接；宿主一轮的步数只剩两步时也讨。
	 * 讨的是一份交接——一个停在半路的子智能体交回做到了哪、还剩什么，而不是停下前随口说的最后一句。返回要对它说的话；照常接着跑的返回空。
	 */
	async checkpoint(sessionId: string, step: number, stepsLeft: number): Promise<string | undefined> {
		const task = this.identity(sessionId);
		const segment = task && this.segments.get(task.id);
		if (!task || !segment || task.state !== "running" || segment.salvage !== undefined || this.cancelled.has(task.id) || stepsLeft === 0) return undefined;
		if (stepsLeft > SALVAGE_STEPS) {
			if (step - segment.start < segment.rounds) return undefined;
			segment.start = step;
			const todos = latestTodos(await this.ctx.sessions.messages(task.session));
			if (this.cancelled.has(task.id)) return undefined;
			// 记进度清单的工具按声明的类别找（`category: "checklist"`），没有时让它列清单是一句做不到的话。
			const checklist = this.ctx.tools.list().find((tool) => tool.category === "checklist")?.name;
			const next = atCheckpoint(segment, todos, checklist !== undefined);
			if (next === "continue") return undefined;
			if (next === "plan" && checklist !== undefined) return planDemand(segment.rounds, checklist);
		}
		segment.salvage = 0;
		return finalDemand(segment.rounds);
	}

	model(sessionId: string, model: { id: string; name: string }): void {
		const task = this.identity(sessionId);
		if (!task || (task.model?.id === model.id && task.model.name === model.name)) return;
		task.model = { id: model.id, name: model.name };
		this.changed(task);
	}

	private async validateChoice(choice: ModelChoice): Promise<void> {
		if (!choice.model && !choice.thinking) return;
		const models = await this.ctx.sessions.models();
		const model = models.find((entry) => entry.id === choice.model);
		if (choice.model && !model) throw new Error(MESSAGES[this.ctx.locale()].modelUnavailable);
		if (choice.thinking && !(model ? model.thinking : models.flatMap((entry) => entry.thinking)).some((entry) => entry.id === choice.thinking)) {
			throw new Error(MESSAGES[this.ctx.locale()].thinkingUnavailable);
		}
	}

	private cancel(task: TaskRecord, stopProcess = true): void {
		// 结束到回报落定之间也可能被按停；这时仍要撤销尚未送出的回报。
		const already = this.cancelled.has(task.id);
		this.cancelled.add(task.id);
		if (isActive(task)) {
			task.state = "stopped";
			task.stop = { reason: "aborted" };
			task.endedAt = Date.now();
			delete task.pending;
		}
		if (stopProcess && !already && this.occupied.has(task.id)) this.ctx.sessions.stop(task.session);
	}

	/** 把改过的任务写回库里，再告诉看着的人；不在跑、也不在交回报的不再留在内存里。 */
	private changed(...tasks: TaskRecord[]): void {
		this.store.put(tasks);
		for (const task of tasks) if (!isActive(task) && !this.occupied.has(task.id) && this.live.get(task.id) === task) this.live.delete(task.id);
		for (const listener of this.listeners) listener();
	}

	private pump(): void {
		if (!this.active) return;
		for (const task of this.live.values()) {
			if (task.state !== "queued") continue;
			const running = [...this.occupied].filter((id) => this.live.get(id)?.parent === task.parent).length;
			if (running >= MAX_RUNNING) continue;
			this.occupied.add(task.id);
			task.state = "running";
			task.startedAt = Date.now();
			this.changed(task);
			const job = this.run(task)
				.catch((error: unknown) => {
					this.ctx.log.error(`Sub-agent ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
				})
				.finally(() => {
					this.occupied.delete(task.id);
					if (!isActive(task) && this.live.get(task.id) === task) this.live.delete(task.id);
					this.jobs.delete(job);
					this.pump();
				});
			this.jobs.add(job);
		}
	}

	private async run(task: TaskRecord): Promise<void> {
		const message = task.pending!;
		// 跑着的时候父会话可能被删：删掉的任务不再写回库里。
		const kept = () => this.live.get(task.id) === task;
		let stop: TurnStop;
		// 开跑、等待这几步自己抛了错（不是模型服务在一轮里报的错）：这次什么都没交出来，只说它没能跑完和原因。
		let threw = false;
		let since = 0;
		const segment = openSegment(segmentRounds(task.identity.maxTurns));
		try {
			const earlier = await this.ctx.sessions.messages(task.session);
			since = earlier.length;
			// 判清单推进了没有的起点取在开跑之前：续跑接着用上一段留下的清单。
			segment.done = completed(latestTodos(earlier));
			this.segments.set(task.id, segment);
			if (!this.active || this.cancelled.has(task.id)) return;
			const run = await this.ctx.sessions.start(task.session, message);
			task.runId = run.id;
			delete task.pending;
			if (!this.active || this.cancelled.has(task.id)) this.ctx.sessions.stop(task.session);
			if (kept()) this.changed(task);
			stop = await this.ctx.sessions.wait(run.id);
		} catch (error) {
			stop = { reason: "error", error: error instanceof Error ? error.message : String(error) };
			threw = true;
		}
		if (!kept()) return;
		const reply = lastProse(await this.ctx.sessions.messages(task.session).catch(() => []), since);
		const yielded = task.output ? { value: task.output, warnings: task.warnings ?? [] } : undefined;
		// `yield` 交的对象是答案，它最后说的话垫底：校验只问字段在不在，`{ summary: "", files: [] }` 也能过，写出来是空的。
		const delivered = (yielded ? renderYield(yielded) : "") || reply.text;
		task.stop = this.cancelled.has(task.id) ? { reason: "aborted" } : stop;
		const stopped = ["aborted", "interrupted"].includes(task.stop.reason);
		// 讨交接时交上来的那份结束了这一轮，但这一轮是因为步数用完才讨的：说的仍是「没做完」。
		const reason = segment.salvage !== undefined && task.stop.reason === "done" ? "max_turns" : task.stop.reason;
		// 怎么没跑完写在正文最前面：父会话只读得到这一段字，不写的话跑满步数、原地打转和干净收尾读起来一模一样。
		const note = stopped || threw ? undefined : incompleteNote(reason, task.stop.error, yielded !== undefined, segment.rounds);
		task.answer = threw ? undefined : [note, delivered].filter(Boolean).join("\n\n") || undefined;
		task.answerTimestamp = reply.timestamp;
		if (note) task.incomplete = true;
		// 按停的不是失败，用满步数、原地打转也不是：活干了，只是没干完，上面那句说了。只有服务出错算失败。
		task.state = stopped ? "stopped" : task.stop.reason === "error" ? "failed" : "done";
		task.error = task.stop.error;
		delete task.pending;
		task.endedAt = Date.now();
		this.segments.delete(task.id);
		if (!kept()) return;
		// 完整报告先落盘；停止与卸载不允许唤醒父会话。
		this.changed(task);
		if (!this.active || this.cancelled.has(task.id) || !task.runId || task.state === "stopped") return;
		// 结尾到送出那一刻才写：同一刻回来的几份合成一条送达，那时还在等谁才是准的。
		const pending = () => [...this.live.values()].filter((other) => other.parent === task.parent && other.id !== task.id && isActive(other));
		task.reported = await this.ctx.sessions.report(task.runId, deliveryBlock(task), {
			frame: { head: DELIVERY_HEAD, tail: () => deliveryTail(pending()) },
			// 对话里那一行「消息来自 @谁」：点了翻到面板里它那一页，所以 id 是任务的 id。
			delivery: {
				id: task.id,
				title: task.description,
				status: task.state === "failed" ? "failed" : "done",
				...(task.incomplete ? { incomplete: true } : {}),
				details: { agent: task.agent } satisfies DeliveryDetails,
			},
		});
		if (kept()) this.changed(task);
	}
}
