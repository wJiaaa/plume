/**
 * 结构视图会不会让 agent 去猜？
 *
 *   node --experimental-transform-types test/tool-eval/outline-eval.ts [<供应商 id>/<模型 id>]
 *
 * 折掉函数体省了上下文，可要是模型接着对没见过的代码说得头头是道，这份节省一文不值——比不值更糟。所以要量的不是 token 数
 * （那是算术），而是边界上的行为：问到被折掉的东西，模型是去读，还是编一个答案？
 *
 * 文件是这个仓库里真的源文件，第一眼和之后按范围的读都经 plume.tools 真的 `read`：模型看到的结构视图、页脚、行号和产品里一字不差。
 */

import { fileURLToPath } from "node:url";
import { streamAssistant } from "../../packages/core/llm/src/ai/index.ts";
import type { AssistantMessage, JsonSchema, Message, ToolSpec } from "../../packages/core/llm/src/types.ts";
import { readTool } from "../../packages/builtin/tools/src/tools/read.ts";
import { loadModel } from "./model.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const READ_TOOL: ToolSpec = { name: "read", description: readTool.description, parameters: readTool.parameters as JsonSchema };

const ANSWER_TOOL: ToolSpec = {
	name: "answer",
	description: "Give your final answer once you are sure of it.",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
		additionalProperties: false,
	},
};

interface Probe {
	id: string;
	file: string;
	question: string;
	/** `structure` 看结构视图就答得出；`body` 要看被折掉的那段。 */
	kind: "structure" | "body";
	/** body 探针：只出现在被折掉的实现里的那个东西。 */
	needle?: string;
}

const PROBES: Probe[] = [
	{
		id: "structure-exports",
		file: "packages/builtin/tools/src/tools/grep.ts",
		kind: "structure",
		question: "这个文件导出了什么？只列名字。",
	},
	{
		id: "structure-signature",
		file: "packages/builtin/tools/src/tools/grep.ts",
		kind: "structure",
		question: "runRipgrepJson 有几个参数？",
	},
	/*
	 * body 探针问的必须是结构视图真的折掉了的东西：问顶层常量的值，结构视图里看得见，「没读就答」反而是对的，探针什么也没量。
	 * 所以问的是函数体里的表达式，答案取标识符而不是英文单词——模型会用用户的语言作答。
	 */
	{
		id: "body-guard",
		file: "packages/builtin/tools/src/tools/read.ts",
		kind: "body",
		question: "readTool 的 execute 里，判断图片体积是否超限时和哪个常量比较？只回答常量名。",
		needle: "MAX_IMAGE_BYTES",
	},
	{
		id: "body-local",
		file: "packages/builtin/tools/src/tools/read.ts",
		kind: "body",
		question: "renderLines 里收集排好的那些行的局部数组叫什么名字？只回答名字。",
		needle: "rendered",
	},
	{
		id: "body-bound",
		file: "packages/builtin/tools/src/tools/grep.ts",
		kind: "body",
		question: "boundCollectedLines 决定在哪一行停下时和哪个常量比较？只回答常量名。",
		needle: "MAX_OUTPUT_CHARS",
	},
];

const textOf = (result: { content: { text: string }[] }) => result.content.map((part) => part.text).join("\n");

async function main(): Promise<void> {
	const { provider, model } = await loadModel(process.argv[2]);

	console.log(`模型 ${model.id}\n`);
	console.log(`${"探针".padEnd(20)} ${"类型".padEnd(10)} ${"读了折叠区".padEnd(12)} 结果`);
	console.log("-".repeat(72));

	let guessed = 0;
	let fetched = 0;
	let bodyProbes = 0;

	for (const probe of PROBES) {
		const ctx = { cwd: ROOT, state: new Map<string, unknown>() };
		const first = await readTool.execute({ path: probe.file }, ctx);
		if (first.isError || !(first.details as { outlined?: boolean } | undefined)?.outlined) {
			console.log(`${probe.id.padEnd(20)} ${"—".padEnd(10)} 文件不出结构视图，跳过`);
			continue;
		}

		const messages: Message[] = [{ role: "user", content: [{ type: "text", text: `${textOf(first)}\n\n${probe.question}` }], timestamp: Date.now() }];

		let didRead = false;
		let answer = "";

		// 最多三步：模型可以读一次，再作答。
		for (let step = 0; step < 3 && !answer; step++) {
			const stream = streamAssistant(
				provider,
				model,
				{
					systemPrompt:
						"You are answering a question about a file. You have been shown a structural outline: " +
						"declarations are visible, bodies are folded and marked with ⋯. " +
						"If the answer is in a folded region, call `read` with offset/limit to fetch it. " +
						"Never guess at folded content. Call `answer` when you are sure.",
					messages,
					tools: [READ_TOOL, ANSWER_TOOL],
				},
				{ maxTokens: 2048, temperature: 0, retryAttempts: 2 },
			);
			let final: AssistantMessage | undefined;
			while (true) {
				const next = await stream.next();
				if (next.done) {
					final = next.value;
					break;
				}
			}
			if (!final) break;
			if (final.stopReason === "error") {
				console.log(`${probe.id.padEnd(20)} 请求失败：${final.errorMessage ?? ""}`);
				break;
			}
			messages.push(final);

			const calls = final.content.filter((c) => c.type === "toolCall");
			if (calls.length === 0) {
				const said = final.content.find((c) => c.type === "text");
				answer = said?.type === "text" ? said.text : "";
				break;
			}

			for (const call of calls) {
				if (call.type !== "toolCall") continue;
				if (call.name === "answer") {
					answer = String((call.arguments as { text?: string }).text ?? "");
					messages.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: "answer",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: Date.now(),
					});
				} else if (call.name === "read") {
					didRead = true;
					// 读的永远是这个探针的文件：路径写错了也不该让它拿不到内容、把「没读到」算成「没去读」。
					const result = await readTool.execute(
						{ ...(call.arguments as Record<string, unknown>), path: probe.file } as Parameters<typeof readTool.execute>[0],
						ctx,
					);
					messages.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: "read",
						content: [{ type: "text", text: textOf(result) }],
						isError: result.isError === true,
						timestamp: Date.now(),
					});
				} else {
					messages.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: [{ type: "text", text: `Unknown tool ${call.name}` }],
						isError: true,
						timestamp: Date.now(),
					});
				}
			}
		}

		const correct = probe.needle ? answer.toLowerCase().includes(probe.needle.toLowerCase()) : answer.trim().length > 0;
		if (probe.kind === "body") {
			bodyProbes += 1;
			if (didRead) fetched += 1;
			else if (correct) guessed += 1; // 没读却答对了 = 背出来的，或者碰巧。
		}

		const mark = correct ? "✓" : "✗";
		const readMark = probe.kind === "body" ? (didRead ? "读了" : "没读 ⚠") : "—";
		console.log(`${probe.id.padEnd(20)} ${probe.kind.padEnd(10)} ${readMark.padEnd(12)} ${mark} ${answer.slice(0, 40).replace(/\n/g, " ")}`);
	}

	console.log("-".repeat(72));
	console.log(`需要看实现的探针 ${bodyProbes} 个：主动去读 ${fetched}，没读就答 ${guessed}`);
	console.log(fetched === bodyProbes ? "✓ 没有一次凭空作答" : `⚠ 有 ${bodyProbes - fetched} 次没有去读折叠区`);
}

await main();
