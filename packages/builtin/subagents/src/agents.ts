/**
 * 子智能体的种类：名字给模型选（`task` 的 `subagent_type`），说明写进系统提示词的名单，`prompt` 换掉子会话的身份那一段，
 * `tools` 是它能用的工具（`*` 是主会话的全部，`task` 除外：子智能体不再派子智能体），`output` 是它交回的对象长什么样。
 *
 * 这里是内置的几种；人自己写的放在 `~/.plume/agents/*.md` 和项目的 `.plume/agents/*.md`，同名时盖住内置的，见 `definitions.ts`。
 * 人写的按工具名列它能用的工具；内置的不点名别的插件的工具，按种类（`ToolDefinition.kind`）在工具表里挑，见 `builtinAgents`。
 */

import type { RegisteredToolInfo, ToolKind } from "@plume/contract";
import type { JsonSchema, SchemaMode } from "./yield.ts";

export interface AgentDefinition {
	name: string;
	description: string;
	prompt: string;
	tools: readonly string[] | "*";
	/** 默认用哪个模型（`SessionModel.id`）；设置里给这一种选过模型时那个优先，都没有就跟着主会话。 */
	model?: string;
	/**
	 * 它的脸：`形状-颜色`，比如 `cloud-violet`。写在定义里而不是界面的偏好里，是因为它是身份的一部分——定义文件拷到
	 * 另一台机器上，来的应该是同一个「人」。运行时不读它，认不出来的值界面按名字另算一张。
	 */
	avatar?: string;
	/**
	 * 交回的对象长什么样。写了就挂上参数是这份结构的 `yield`，父会话拿到一个校验过的对象，而不是它碰巧最后写的那段话；
	 * 不写的做完了用正文回答，适合答案本来就是一段话的种类。
	 */
	output?: JsonSchema;
	/** 用完重试后对象还不合格时：`permissive`（默认）带着警告照收，`strict` 不收——给接不住缺字段的下游用。 */
	schemaMode?: SchemaMode;
	/** 每跑多少步停下来看一眼（检查点，见 `checkpoint.ts`），不写是 60。改的是多久汇报一次，不是最多干多少活。 */
	maxTurns?: number;
	source: "builtin" | "user" | "workspace";
}

/** 内置的一种：能用的工具是 `*`（全部），或者几种活（`ToolKind`），按这里的顺序在工具表里挑出名字。 */
export type BuiltinAgent = Omit<AgentDefinition, "tools"> & { tools: "*" | readonly ToolKind[] };

/** 读、按名字找、按内容搜、列目录，跑命令、看后台命令的输出。 */
const READ_AND_SHELL: readonly ToolKind[] = ["view", "find", "search", "list", "command", "job"];
const READ_ONLY: readonly ToolKind[] = ["view", "find", "search", "list"];

// i18n-exempt：下面都是发给模型的话，名单里的说明也是。
export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [
	{
		name: "general",
		avatar: "circle-blue",
		source: "builtin",
		description: "通用研究与代码修改",
		prompt:
			"You are a sub-agent working on one delegated task. Complete it fully, then reply with a concise report of " +
			"what you found or changed. Your final message is the only thing the parent agent sees, so it must stand alone.",
		tools: "*",
	},
	{
		name: "explore",
		avatar: "drop-green",
		source: "builtin",
		description: "只读搜索与代码定位",
		prompt: "You are a read-only exploration agent. Search broadly, read only what you need, and never modify files. Do not paste large file contents.",
		tools: READ_AND_SHELL,
		// `summary` 和 `report` 分开：前者是父会话据以决定下一步的结论，得短到值得派出去；后者是给人读的交付物，要多长写多长。
		output: {
			type: "object",
			required: ["summary", "files"],
			properties: {
				summary: { type: "string", description: "The conclusion, in two or three sentences. Written for the agent that dispatched you." },
				files: {
					type: "array",
					description: "The files that answer the question. Leave empty only if there genuinely are none.",
					items: {
						type: "object",
						required: ["path", "why"],
						properties: {
							path: { type: "string", description: "Project-relative path, optionally with a `:12-34` line range." },
							why: { type: "string", description: "What is in this file that matters here." },
						},
					},
				},
				architecture: { type: "string", description: "How these pieces connect, when that is part of the answer." },
				report: {
					type: "string",
					description:
						"The full deliverable, when the task asked for a report, a table or a list — written out at the depth asked for. " +
						"Not a summary of it; `summary` already does that. Omit for a quick lookup.",
				},
			},
		},
	},
	{
		name: "review",
		avatar: "squircle-pink",
		source: "builtin",
		description: "检查代码缺陷与风险",
		prompt:
			"You are a code review agent. Inspect the changes you are pointed at and report concrete defects: " +
			"correctness bugs, missing error handling, security issues. Do not report style preferences.",
		tools: READ_AND_SHELL,
		output: {
			type: "object",
			required: ["summary", "findings"],
			properties: {
				summary: { type: "string", description: "What you looked at and what you concluded, in two or three sentences." },
				findings: {
					type: "array",
					description: "One entry per concrete defect. Empty when you found none — say so in `summary` rather than inventing one.",
					items: {
						type: "object",
						required: ["file", "problem", "failure"],
						properties: {
							file: { type: "string", description: "Path with line, as `src/auth.ts:42`." },
							severity: { type: "string", enum: ["high", "medium", "low"], description: "How much it matters." },
							problem: { type: "string", description: "What is wrong, in one sentence." },
							failure: { type: "string", description: "Concrete inputs or state that make it go wrong. Not a restatement of the problem." },
						},
					},
				},
			},
		},
	},
	{
		name: "verify",
		avatar: "blob-teal",
		source: "builtin",
		description: "执行检查并报告结果",
		prompt:
			"You run one verification — a test suite, a typecheck, a build, a lint — and report what happened. " +
			"You do not fix anything, and you do not speculate about causes beyond what the output states. " +
			"Run the command, read its output, then yield. The full log stays with you; the parent only needs " +
			"whether it passed and, if not, each failure on its own: what failed, where, and the assertion or error " +
			"message. Keep `summary` to one sentence.\n\n" +
			"Read the numbers from the runner itself, never from a wrapper around it: `ℹ pass N` / `ℹ fail M` " +
			"(node --test), `Tests: N passed, M failed` (jest/vitest), `N passed, M failed` (pytest). If the command " +
			"went through `npm test` or `pnpm test` and the runner's own summary is buried in wrapper noise, run the " +
			"underlying command directly. Each entry in `failures` takes its `name` from the runner's own failure line " +
			"(the `✖` line, the `FAIL` line, the `FAILED` line) — the test's name as the runner printed it, not your " +
			"paraphrase of it.",
		tools: ["view", "command", "job"],
		output: {
			type: "object",
			required: ["passed", "summary", "failures"],
			properties: {
				passed: { type: "boolean", description: "Whether the verification succeeded." },
				summary: { type: "string", description: "One sentence: what was run and the count — e.g. `node --test: 41 passed, 2 failed`." },
				command: { type: "string", description: "The exact command that was run." },
				failures: {
					type: "array",
					description: "One entry per failure. Empty when it passed.",
					items: {
						type: "object",
						required: ["name", "message"],
						properties: {
							name: { type: "string", description: "The failing test, file, or check." },
							location: { type: "string", description: "`path:line` when the output gives one." },
							message: { type: "string", description: "The assertion or error message, trimmed to the line that says what went wrong." },
						},
					},
				},
			},
		},
	},
	{
		name: "plan",
		avatar: "cloud-violet",
		source: "builtin",
		description: "只读分析与实施规划",
		prompt:
			"You plan a change without making it. Read what you need to understand the task, then yield the plan as Markdown, " +
			"complete enough that whoever carries it out has nothing left to decide: a title, a brief summary, the key changes grouped " +
			"by behaviour or subsystem (name a path only where it prevents a mistake), the test plan, and the assumptions you made where " +
			"the code could not settle a question. Usually three to five short sections. Do not write or edit anything. Do not pad.",
		tools: READ_ONLY,
		output: {
			type: "object",
			required: ["plan"],
			properties: {
				plan: { type: "string", description: "The whole plan as Markdown." },
			},
		},
	},
	/*
	 * 审计划的只拿到计划，拿不到讨论它的那段对话：独立性就来自这里。不复用 `review`：那张表是代码缺陷（`file:line`、失败输入），
	 * 计划的问题是事实不对、范围漏了、步骤走不通、验收证明不了目标。bash 和 `review` 一样给，核实版本、依赖要靠它。
	 * 没人自动派它：讨论计划时模型自己挑，或人用 `@plan-review` 点名。值得在设置里换一个模型家族，同一个模型审它自己写的计划多半同意。
	 */
	{
		name: "plan-review",
		avatar: "hexagon-indigo",
		source: "builtin",
		description: "只读核实一份实施计划能否照做",
		prompt:
			"You review an implementation plan before anyone carries it out. You get the plan, not the discussion behind it; judge it " +
			"against the code. Check that what it states about the code is true (paths, APIs, versions, callers, configuration), that its " +
			"scope misses nothing the goal needs, that its steps can be carried out in the order given, that its verification would actually " +
			"show the goal was met, and that it leaves the implementer nothing to decide. A blocker is something that would make the " +
			"implementation fail, go wrong, or stall; give it with the evidence you found and the smallest change to the plan that resolves " +
			"it. Anything less goes in `notes`. Do not rewrite the plan, and propose a different approach only when this one cannot work. " +
			"If you are told which blockers an earlier review raised, check those first and say for each whether it is resolved, then " +
			"reuse what is already settled rather than verifying it again. Never modify files.",
		tools: [...READ_ONLY, "command"],
		output: {
			type: "object",
			required: ["approved", "summary", "blockers"],
			properties: {
				approved: { type: "boolean", description: "True exactly when `blockers` is empty." },
				summary: { type: "string", description: "Your verdict and why, in two or three sentences." },
				blockers: {
					type: "array",
					description: "One entry per problem that must be fixed before the plan is carried out. Empty when there is none — do not invent one.",
					items: {
						type: "object",
						required: ["problem", "evidence", "fix"],
						properties: {
							problem: { type: "string", description: "What in the plan is wrong or missing, in one sentence." },
							evidence: { type: "string", description: "What shows it: `path:line`, a command and its output, a version." },
							fix: { type: "string", description: "The smallest change to the plan that resolves it." },
						},
					},
				},
				notes: { type: "array", items: { type: "string" }, description: "Lesser points worth knowing while implementing." },
			},
		},
	},
	{
		name: "simple",
		avatar: "pill-brown",
		source: "builtin",
		description: "量大但机械、边界清楚的改动，批量做完",
		prompt: "Complete the delegated task efficiently. Read the necessary context, make only requested changes, verify them and report the result concisely.",
		tools: "*",
	},
	{
		name: "reason",
		avatar: "triangle-orange",
		source: "builtin",
		description: "先想清楚再动手的难题",
		prompt:
			"Investigate the delegated problem carefully. Ground decisions in evidence, implement the requested solution, verify the result and report remaining uncertainty.",
		tools: "*",
	},
];

/**
 * 内置的几种按这一刻的工具表定下能用的工具：每种活挑出声明了它的工具，按种类的顺序、同一种里按工具表的顺序列名字。
 * 工具表里没有哪种活，那一种就少一样；名字跟着提供它的插件走，换了插件不用改这里。
 */
export function builtinAgents(tools: readonly RegisteredToolInfo[]): AgentDefinition[] {
	return BUILTIN_AGENTS.map((agent) => ({
		...agent,
		tools: agent.tools === "*" ? "*" : agent.tools.flatMap((kind) => tools.flatMap((tool) => (tool.kind === kind ? [tool.name] : []))),
	}));
}

export const DEFAULT_AGENT = "general";

/** 子智能体交差用的工具：每一种都有（参数随定义换），主会话和别的会话看不到。 */
export const YIELD_TOOL = "yield";

/**
 * 这个子智能体能不能用这个工具。`checklists` 是工具表里记进度清单的工具（`category: "checklist"`）：那是它自己的记事本，
 * `yield` 是它交差的路，都不算能力，总是在。
 */
export function allows(agent: Pick<AgentDefinition, "tools">, tool: string, checklists: readonly string[]): boolean {
	return tool !== "task" && tool !== "stop_subagent" && (checklists.includes(tool) || tool === YIELD_TOOL || agent.tools === "*" || agent.tools.includes(tool));
}
