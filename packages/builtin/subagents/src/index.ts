/**
 * 子任务登记后立即交回 ID；队列、报告与身份由私有登记簿管理，对话仍由宿主保存。
 * 子代理交回的结果经资源地址 `agent://<id>` 读（`resource.ts`），一次只取要的那个字段。
 */

import type { CallContext, Plugin, PromptSection, SessionMessage, StepEnd, StepVerdict, ToolKind, ToolOutput } from "@plume/contract";
import type { SubagentsApi } from "./api.ts";
import { allows, DEFAULT_AGENT, YIELD_TOOL, type AgentDefinition } from "./agents.ts";
import { awaitingEmptyNudge, AwaitWatch } from "./awaiting.ts";
import { SALVAGE_STEPS, segmentRounds } from "./checkpoint.ts";
import { AgentDefinitions, type AgentSave } from "./definitions.ts";
import { MESSAGES } from "./messages.ts";
import { MAX_RUNNING, Registry } from "./registry.ts";
import { agentResource } from "./resource.ts";
import { isActive, type ModelChoice } from "./types.ts";
import { HANDOFF_DESCRIPTION, HANDOFF_SCHEMA, YIELD_DESCRIPTION, yieldInstruction, yieldOnly } from "./yield.ts";

/*
 * 「结论依赖它们」那句写在描述里：只写在「已派出」的工具结果里，模型接着读上几次请求就忘了，把写最终回答也算成
 * 「不依赖它们的事」（见 `awaiting.ts`）。描述每次请求都在，而且走缓存。
 */
// i18n-exempt：工具的说明、参数、结果和提示词都是发给模型的。
const DESCRIPTION =
	"Run a sub-agent in its own context window. It starts from nothing — your `prompt` is all it knows, and it cannot ask you questions. " +
	"It runs in the background and this call immediately returns its ID. When it finishes, its final message is delivered automatically; do not poll, resume or duplicate running work. The files it read and the commands it ran stay out of your context. " +
	"Your conclusion depends on what they return: write no final answer or summary, and never guess what they will find, until every sub-agent you dispatched has reported. " +
	"Two kinds of work are worth delegating: work whose intermediate output is large and whose conclusion is all you need (sweeping dozens of files " +
	"for one answer, running something with long output for its failures), and a sizeable piece of work that does not depend on what you are doing. " +
	"Do everything else yourself: a change of a step or two, part of what you are writing now (such as tests for the function you just wrote), " +
	"or work you could only hand off after spelling out its interfaces and conventions — spelling those out costs as much as doing it. " +
	"Agents with write tools edit files directly; their risky actions are asked of the user, like yours. Calls in one reply run in parallel " +
	"(extra ones queue), so dispatch independent pieces together; have each skip builds, lints and tests, and verify once yourself after they " +
	"have all reported. Pieces that need a shared interface which does not exist yet are not independent — write the interface first, or do not split. " +
	"Each file has one writer: when sub-agents may edit files, name in each prompt the files it owns, and never give two of them the same file.";

const PARAMETERS = {
	type: "object",
	properties: {
		description: { type: "string", description: "3-5 word summary of the task." },
		prompt: { type: "string", description: "Self-contained instructions for the sub-agent." },
		subagent_type: { type: "string", description: "Which agent definition to use. Defaults to `general`." },
		resume: {
			type: "string",
			description: "ID of a stopped or finished sub-agent to continue in the same context. Keeps its original identity and tool restrictions.",
		},
	},
	required: ["description", "prompt"],
	additionalProperties: false,
};

/**
 * 子会话的系统提示词末尾那一段。检查点按轮算、每一轮都要把整段上下文再发一遍，说清这对它意味着什么，「独立的调用放在
 * 同一条回复里」才压得住——夹在系统提示词十几条准则中间时，一轮只调一个工具的模型照样个个撞上检查点。清单那句只在它的
 * 工具表里有记清单的工具（`checklist`，按 `category: "checklist"` 找到的名字）时说。`searches` 是它工具表里按内容搜、按名字找文件的工具
 * （按 `kind` 找到的名字），点名它们；没有就说「几次搜索」。最后两句写给派它来的那一方：它交回的是材料，改了什么、验证到哪一步要说清。
 */
// i18n-exempt：发给模型的话。
function workingNote(rounds: number, checklist: string | undefined, searches: readonly string[]): string {
	const search = searches.length > 0 ? `要跑的几条 ${searches.join(" / ")}` : "要跑的几次搜索";
	return [
		`你是被派出来做一件事的子代理，按轮计：每一轮都要把整段上下文再发一遍，每跑 ${rounds} 轮会停下来检查一次进度。`,
		`所以每一轮都把能同时做的事一起做——要读的几个文件、${search}，放在同一条回复里一起发出去；只有后一步确实要用前一步的结果时才分开。一轮只调一个工具，会让你在做完之前就耗光这一段的轮数。`,
		checklist ? `活有三步以上，就用 \`${checklist}\` 记下步骤、做完一项勾一项：到检查点时，清单在往前推就会让你接着跑。` : "",
		"你交回的东西是给派你来的 Agent 读的材料：结论先行、关键事实带 `path:line`，不要复述过程。",
		"改了文件的，列出改了哪些；跑过什么验证、结果如何，没验证的明说没验证。读到的事实和你的推断分开写——派你来的 Agent 据此决定哪些要自己再核对。",
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * 主会话系统提示词里的名单，末尾说清同时跑几个、多的排队：不说的话，模型怕挤占就一轮只派一个，每多派一个就多等一整轮。
 * 子代理拿不到 `task`（见 `allows`），所以最后一句是实话。
 */
// i18n-exempt：发给模型的话。
function catalogue(agents: readonly AgentDefinition[]): string {
	const lines = agents.map((agent) => `- ${agent.name}: ${agent.description} (tools: ${agent.tools === "*" ? "all" : agent.tools.join(", ")})`);
	return [
		"Sub-agents for the `task` tool's `subagent_type`: pass the one whose description fits. When the user asks for @name from this list, dispatch that agent.",
		"",
		"<available_subagents>",
		...lines,
		"</available_subagents>",
		"",
		"互不依赖的几件事，在同一条回复里一起派出去（一次发出多个 `task` 调用）：" +
			`最多 ${MAX_RUNNING} 个子代理同时跑，多出来的自动排队，前面的跑完一个就补上一个——排队不用你管，也不多花钱。` +
			"别为了等前一个的结果而一轮只派一个，那样每多派一个就多等一整轮。" +
			"子代理自己不能再派子代理，要拆的活由你来拆。",
	].join("\n");
}

function failed(output: string): ToolOutput {
	return { output, isError: true };
}

/**
 * 只有顶层会话（侧栏里那段对话）建得了子会话：插件的子会话、独立会话（比如运维助手）下面本体不让再挂子会话。
 * 在那里不给派活、停活的工具，名单也不列；调到了照样拒绝，说清为什么。
 */
const TOP_ONLY = new Set(["task", "stop_subagent"]);
// i18n-exempt：发给模型的工具结果。
const NOT_TOP =
	"Only a main conversation can dispatch sub-agents; a side chat, another plugin's child session or a plugin-owned session cannot. Do the work yourself.";

export default {
	name: "plume.subagents",
	async apply(ctx) {
		const registry = new Registry(
			ctx,
			new AgentDefinitions(
				ctx.appDataDir,
				() => MESSAGES[ctx.locale()],
				(path) => ctx.trash(path),
				() => ctx.tools.list(),
			),
		);
		await registry.restore();
		ctx.resources.register(agentResource((sessionId) => registry.list(sessionId)));

		/** 工具表里记进度清单的工具（`category: "checklist"`），不认别的插件的工具名。 */
		const checklists = () => ctx.tools.list().flatMap((tool) => (tool.category === "checklist" ? [tool.name] : []));

		ctx.tools.register({
			name: "task",
			description: DESCRIPTION,
			parameters: PARAMETERS,
			// 别的插件要叫模型派子智能体时按这一类找到它，不认 `task` 这个名字。
			category: "delegate",
			// i18n-exempt：导出会话成 Markdown 时的一行，导出是英文的。
			describe: (args) => (typeof args.description === "string" ? args.description : "Sub-agent task"),
			// 导出时把结论引在这一行下面；出错的、标了只派出去（`detached`）的不引。
			exportResult: (result) =>
				result.isError || (result.details as { detached?: unknown } | undefined)?.detached
					? undefined
					: result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
			async execute(args, run) {
				if (registry.identity(run.sessionId)) return failed("Sub-agents cannot dispatch sub-agents. Do the work yourself.");
				if (run.session.kind !== "top") return failed(NOT_TOP);
				const description = typeof args.description === "string" ? args.description.trim() : "";
				const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
				if (!description || !prompt) return failed("Both `description` and `prompt` are required and must be non-empty strings.");
				const requested = typeof args.subagent_type === "string" && args.subagent_type.trim() ? args.subagent_type.trim() : DEFAULT_AGENT;
				const resume = typeof args.resume === "string" ? args.resume.trim() : undefined;
				if (run.signal.aborted) return failed("The parent turn was stopped before dispatch.");
				try {
					const dispatch = await registry.dispatch(run.sessionId, run.cwd, description, prompt, requested, resume);
					run.progress(JSON.stringify(dispatch));
					return {
						details: dispatch,
						output: `Dispatched in the background. Sub-agent ID: ${dispatch.id}. Its result will arrive automatically. Do not poll, resume, duplicate its work, or edit its files. Your conclusion and summary depend on its result: until every dispatched sub-agent has reported, do not write a conclusion for the user. Continue only independent work; once that is done, or if there is none, tell the user in a sentence or two what is delegated and who you are still waiting for, then end this turn.`,
					};
				} catch (error) {
					return failed(error instanceof Error ? error.message : String(error));
				}
			},
		});

		/*
		 * 交差用的工具只有一个名字，参数随派发时的定义换（见 model.context）：有输出结构的，参数就是那份结构；没有的挂交接那一份，
		 * 从派发起就在工具表里，讨交接的那两步工具表一个字不变，前缀缓存不至于整段作废。
		 */
		ctx.tools.register({
			name: YIELD_TOOL,
			description: HANDOFF_DESCRIPTION,
			parameters: HANDOFF_SCHEMA,
			async execute(args, run) {
				return registry.yielded(run.sessionId, args);
			},
		});

		ctx.hook("model.context", async (input, next) => {
			const record = registry.identity(input.sessionId);
			if (!record) {
				// 里层都改完了再看：别的插件藏起了 task（侧边聊天只留它自己那几样工具）、这里不是顶层会话（见 `TOP_ONLY`），名单也就不列。
				const context = await next(input);
				const tools = context.tools.filter((tool) => tool.name !== YIELD_TOOL && (input.session.kind === "top" || !TOP_ONLY.has(tool.name)));
				if (!tools.some((tool) => tool.name === "task")) return { ...context, tools };
				const agents = await registry.enabled(input.cwd);
				// 种类全关掉了：没有能派的，task 也不给模型，免得它调了只拿到错误。
				if (agents.length === 0) return { ...context, tools: tools.filter((tool) => tool.name !== "task") };
				return { ...context, tools, sections: [...context.sections, { id: "subagents", text: catalogue(agents), category: "catalog" }] };
			}
			registry.model(input.sessionId, input.model);
			const context = await next(input);
			// 身份那一段按类别（`PromptSection.category`）换成这种子智能体自己的，不认提供它的插件定的段名。
			const sections: PromptSection[] = context.sections.filter((section) => section.category !== "identity" && section.id !== "subagents");
			const output = record.identity.output;
			const lists = checklists();
			const tools = context.tools
				.filter((tool) => allows(record.identity, tool.name, lists))
				.map((tool) => (tool.name === YIELD_TOOL && output ? { ...tool, description: YIELD_DESCRIPTION, parameters: output } : tool));
			const registered = ctx.tools.list();
			const offered = (kind: ToolKind) =>
				registered.flatMap((tool) => (tool.kind === kind && tools.some((given) => given.name === tool.name) ? [tool.name] : []));
			const note = workingNote(
				segmentRounds(record.identity.maxTurns),
				lists.find((name) => tools.some((tool) => tool.name === name)),
				[...offered("search"), ...offered("find")],
			);
			return {
				...context,
				sections: [
					{ id: "subagent-identity", text: record.identity.prompt, category: "identity" },
					...sections,
					{ id: "subagent", text: output ? `${note}\n\n${yieldInstruction(output)}` : note },
				],
				tools,
			};
		});

		ctx.hook("tool.execute", async (input, next) => {
			const record = registry.identity(input.sessionId);
			if (!record) return input.call.name === YIELD_TOOL ? failed("`yield` only works in a sub-agent.") : next(input);
			const salvage = registry.salvage(input.sessionId);
			let output: ToolOutput;
			if (!allows(record.identity, input.call.name, checklists()))
				output = failed(`The "${input.call.name}" tool is not available to the ${record.agent} sub-agent.`);
			// 讨交接的那两步：工具表原样留着（换了它前缀缓存从头作废），拒绝放在执行这一下。
			else if (salvage !== undefined && input.call.name !== YIELD_TOOL) output = failed(yieldOnly(input.call.name));
			else output = await next(input);
			// 讨交接的最后一步：交没交上，这一轮都到此为止。
			return salvage !== undefined && salvage >= SALVAGE_STEPS - 1 ? { ...output, terminate: output.terminate ?? "done" } : output;
		});

		/*
		 * 检查点。放在别的插件的收尾外面（清单插件在 -10）：讨交接的两步不问里层——它道个歉没交时被追问去勾清单，
		 * 勾清单在这两步里是被拒的，两步就全白花了。
		 */
		const watches = new Map<string, AwaitWatch>();
		ctx.sessions.onDeleted((sessionId) => watches.delete(sessionId));
		ctx.hook(
			"step.end",
			async (input, next) => {
				if (!registry.identity(input.sessionId)) return awaitingStep(input, next);
				if (registry.salvageStep(input.sessionId)) return input.toolResults.length > 0 ? { continue: true } : { continue: false };
				const verdict = await next(input);
				if (!verdict.continue) return verdict;
				const demand = await registry.checkpoint(input.sessionId, input.step, input.stepsLeft);
				return demand ? { continue: true, say: demand } : verdict;
			},
			{ order: -20 },
		);

		/** 父会话这一步：还有派出去没回来的，告诉里层别逼它交结论，隔几步提醒一次在等谁（见 `awaiting.ts`）。 */
		async function awaitingStep(input: StepEnd, next: (input: StepEnd) => Promise<StepVerdict>): Promise<StepVerdict> {
			if (input.step === 1) watches.delete(input.sessionId);
			const pending = registry.list(input.sessionId).filter(isActive);
			const verdict = await next(pending.length > 0 ? { ...input, awaiting: { nudge: awaitingEmptyNudge(pending) } } : input);
			if (input.toolResults.length === 0) return verdict;
			let watch = watches.get(input.sessionId);
			if (!watch) watches.set(input.sessionId, (watch = new AwaitWatch()));
			const note = watch.afterTools(pending);
			if (!note || !verdict.continue) return verdict;
			return { continue: true, say: verdict.say ? `${verdict.say}\n\n${note}` : note };
		}

		ctx.tools.register({
			name: "stop_subagent",
			description:
				"Stop one of this conversation's sub-agents, including queued work. Does not stop the parent or siblings. Do not restart stopped work unless the user asks.",
			parameters: {
				type: "object",
				properties: { id: { type: "string", description: "The sub-agent ID returned by task." } },
				required: ["id"],
				additionalProperties: false,
			},
			async execute(args, run) {
				const id = typeof args.id === "string" ? args.id : "";
				const task = registry.list(run.sessionId).find((entry) => entry.id === id);
				if (!task) return failed("No such sub-agent belongs to this conversation.");
				registry.stop(task.session);
				return { output: `Sub-agent ${id} stopped.`, details: { id: task.id, session: task.session, parent: task.parent, agent: task.agent } };
			},
		});
		ctx.serve({
			list: (parentId: string) => registry.list(parentId),
			watch: (parentId: string, call: CallContext) => registry.watch(parentId, call),
			stop: (sessionId: string) => registry.stop(sessionId),
			steer: (sessionId: string, message: SessionMessage) => registry.steer(sessionId, message),
			faces: (parentId: string) => registry.faces(parentId),
			catalog: (project: string | null) => registry.catalog(project),
			read: (project: string | null, id: string) => registry.read(project, id),
			save: (project: string | null, input: AgentSave) => registry.save(project, input),
			remove: (project: string | null, id: string, revision: string) => registry.remove(project, id, revision),
			setModel: (agent: string, choice: ModelChoice) => registry.setModel(agent, choice),
			setEnabled: (agent: string, enabled: boolean) => registry.setEnabled(agent, enabled),
		} satisfies SubagentsApi);
	},
} satisfies Plugin;
