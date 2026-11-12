/**
 * 交回父会话的那段字：每份结果原文外面套一层标签，说清是谁、干的什么、怎么收场的；同一次送达里的几份共用一头一尾
 * （`ReportFrame`），告诉父会话这几份是什么、接下来怎么用。宿主在整段前面再加一句「这是后台送达，不是用户说的话」。
 */

import type { TaskRecord } from "./types.ts";

/** 对话里那一行（`DeliveredReport.details`）带的：哪个子智能体交的。宿主不读，界面入口拿它找脸。 */
export interface DeliveryDetails {
	agent: string;
}

type Delivered = Pick<TaskRecord, "id" | "agent" | "description" | "state" | "answer" | "error" | "incomplete">;

/** 标签属性里的值：引号换掉，换行压平，免得一句描述把标签撑破。 */
function attribute(value: string): string {
	return value.replaceAll('"', "'").replace(/\s+/g, " ").trim();
}

// i18n-exempt：交给父会话模型的正文。
export const DELIVERY_HEAD = "你之前派出去的子代理有结果了：";

/** 一份结果。 */
// i18n-exempt：交给父会话模型的正文。
export function deliveryBlock(task: Delivered): string {
	const body = task.answer || (task.error ? `它没能跑完：${task.error}` : "（它跑完了，但什么都没交回来。）");
	const attrs = [
		`id="${attribute(task.id)}"`,
		`agent="${attribute(task.agent)}"`,
		`task="${attribute(task.description)}"`,
		`status="${task.state}"`,
		// `done` 只说它停了；没做完的那种要在标签上就读得出来，不靠正文第一行那个 ⚠。
		task.incomplete ? `incomplete="true"` : "",
	].filter(Boolean);
	return `<subagent_result ${attrs.join(" ")}>\n${body}\n</subagent_result>`;
}

/**
 * 这一次送达的结尾，送出那一刻按同一个父会话里还没回来的（`pending`）写。还有没回来的时，只就这几份说清带来了什么、
 * 还在等谁——点名等的是谁，父会话才不会把「第一份到了」当成「都到了」去收尾。都回来了：这是材料不是成品，合并成一份
 * 按问题组织的回答；已经抢先答过的，只说材料改变了什么，不把整份回答重写一遍。
 */
// i18n-exempt：交给父会话模型的正文。
export function deliveryTail(pending: readonly Pick<TaskRecord, "agent" | "description">[]): string {
	return pending.length > 0
		? `还有 ${pending.length} 个没回来：${pending.map((one) => `${one.agent}（${one.description}）`).join("、")}。它们跑完也会这样送到。` +
				"现在只就上面这几份用一两句话告诉用户：带来了什么结论、还在等哪几个——不要写最终回答，也不要自己去做它们正在做的事。"
		: "派出去的都回来了。这些是交给你的材料，不是给用户的成品：结合之前送到的和用户后来说的话接着做。" +
				"派出之后你如果已经给过用户完整的回答，不要把它重写一遍：只说这些材料改变了什么——新增的、修正的、推翻了之前哪条结论；什么都没改变就用一句话说明。" +
				"还没回答过的，需要回答用户时，把结论合并成一份按问题组织的回答——去重、核对关键结论，不要逐个转述「某个子代理做了什么」。";
}
