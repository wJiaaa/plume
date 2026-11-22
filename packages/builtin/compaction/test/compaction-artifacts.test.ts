/**
 * 压缩剪工具结果时，原文只给留下的那几条存。
 *
 * 存下的原文每个会话有份数上限，按修改时间挤掉最旧的。以前整段看过的历史都带着存，随后被摘要掉的那段也存了一份，
 * 一次压缩就能把留下的尾部、工具自己外溢出去还被指着的原文挤掉，模型再 `read artifact://…` 就读不到了。
 */

import { expect, it } from "vitest";
import type { Message } from "@plume/contract";
import { compactIfNeeded } from "../src/compaction.ts";
import type { ArtifactSink } from "../src/prune.ts";
import { recorder, reply, request, say, textOf, toolResult, user } from "./helpers.ts";

it("压缩只给留下的尾部里剪过的结果存原文，摘要掉的那段不存", async () => {
	const history: Message[] = [user("把这些日志都看一遍")];
	for (let i = 0; i < 6; i++) {
		history.push(reply([{ type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: `cat log-${i}` } }]));
		history.push(toolResult(`t${i}`, `log-${i} `.repeat(1_500)));
	}
	history.push(say("看完了", 9_500));

	const stored: string[] = [];
	const artifacts: ArtifactSink = {
		keep: (_tool, content) => {
			stored.push(content);
			return `artifact://a${String(stored.length).padStart(12, "0")}`;
		},
	};
	const result = await compactIfNeeded(request(history, recorder().models, { artifacts }));
	expect(result).not.toBeNull();

	const tail = result!.messages.slice(result!.messages.length - result!.kept);
	const cutInTail = tail.filter((message) => message.role === "toolResult" && textOf(message).includes("omitted by Plume"));
	expect(cutInTail.length).toBeGreaterThan(0);
	expect(cutInTail.length).toBeLessThan(6);
	// 留下的每条剪过的结果都带着取回原文的地址，存的份数正好是这几条。
	for (const message of cutInTail) expect(textOf(message)).toMatch(/artifact:\/\/a\d{12}/);
	expect(stored.length).toBe(cutInTail.length);
});
