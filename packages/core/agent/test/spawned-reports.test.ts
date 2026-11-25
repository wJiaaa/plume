import { expect, it } from "vitest";
import type { DeliveryInput, Message, ReportFrame, SessionSummary, TurnCause, TurnStop } from "@plume/contract";
import type { Session } from "../src/session/session.ts";
import { createSpawnedReports, reportTail, reportText } from "../src/session/spawned-reports.ts";

it("汇报：标签里转义标题，没回复时说一句；结尾点名在等用户的会话", () => {
	const text = reportText({ sessionId: "s1", name: "cli", title: 'a "b" <c>', status: "failed", reply: "" });
	expect(text).toContain('<session-report id="s1" name="cli" title="a &quot;b&quot; &lt;c&gt;" status="failed">');
	expect(text).toContain("（它没有留下回复。）");
	expect(reportTail([])).not.toContain("在等用户");
	expect(reportTail(["cli（s1）"])).toContain("cli（s1） 在等用户");
});

const user = (text: string, extra: Partial<Extract<Message, { role: "user" }>> = {}) =>
	({ role: "user", content: [{ type: "text", text }], timestamp: 0, ...extra }) as Message;
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as Message;
const call = (id: string, name = "spawn_session") => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] }) as unknown as Message;

type Sent = {
	parentId: string;
	sessionId: string;
	text: string;
	options: { delivery: DeliveryInput; reply?: string; frame?: ReportFrame; wake: boolean };
	plugin: string;
};

/**
 * 一组会话：p 是来处（里面有 `spawn_session` 的调用 c1、c2），别的按 `spawnedFrom` 挂在它下面。`whenIdle` 由测试放行（`settle`）。
 * `reportBack` 收下每一份。`end` 收场一轮，`cause` 是本体给这一轮定下的（缺省是开出来的第一轮）。
 */
function family(children: Record<string, { toolCallId: string; messages: Message[]; background?: boolean; name?: string }>) {
	const sent: Sent[] = [];
	const messages = new Map<string, Message[]>([["p", [call("c1"), call("c2")]]]);
	const sessions = new Map<string, Session>();
	const add = (summary: Partial<SessionSummary> & { id: string }) => {
		sessions.set(summary.id, { summary: { title: `标题 ${summary.id}`, kind: "top", running: false, ...summary } as SessionSummary } as Session);
	};
	add({ id: "p" });
	for (const [id, child] of Object.entries(children)) {
		messages.set(id, child.messages);
		add({ id, spawnedFrom: { sessionId: "p", toolCallId: child.toolCallId, ...(child.name ? { name: child.name } : {}), reportBack: true } });
	}
	const idle = new Map<string, () => void>();
	const reports = createSpawnedReports({
		sessions,
		readMessages: (session) => messages.get(session.summary.id) ?? [],
		whenIdle: (session) => new Promise((resolve) => idle.set(session.summary.id, resolve)),
		host: { toolOwners: () => [{ name: "spawn_session", plugin: "plume.test" }] as never },
		background: { reportBack: (parentId, sessionId, text, options, plugin) => void sent.push({ parentId, sessionId, text, options, plugin }) },
		quitting: () => false,
		log: () => undefined,
	});
	const session = (id: string) => sessions.get(id)!;
	const end = (id: string, reason: TurnStop["reason"] = "done", cause: TurnCause = LAUNCH, peers?: readonly string[]) => {
		const child = children[id];
		session(id).cause = cause;
		const inferred = peers ?? (cause.by === "peer" ? [cause.from] : undefined);
		if (inferred) session(id).peerRead = new Set(inferred);
		else delete session(id).peerRead;
		if (child?.background) session(id).summary.background = true;
		else delete session(id).summary.background;
		reports.turnEnded(session(id), { reason });
	};
	const settle = async (id: string) => {
		idle.get(id)?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return { reports, sent, end, settle, session };
}

const LAUNCH: TurnCause = { by: "launch", plugin: "plume.test" };
const FROM_ORIGIN: TurnCause = { by: "peer", from: "p" };

it("每轮汇报：第一轮和来处的信引起的那一轮叫醒，人说话引起的、出错的不叫醒，被停下的不交", () => {
	const child = { toolCallId: "c1", name: "cli", messages: [user("任务"), reply("做完了：改了 a.ts")] };
	const { sent, end } = family({ s1: child });
	end("s1");
	expect(sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({
		parentId: "p",
		sessionId: "s1",
		plugin: "plume.test",
		options: { wake: true, reply: "做完了：改了 a.ts", delivery: { title: "标题 s1", status: "done" } },
	});
	expect(sent[0]!.text).toContain('name="cli"');
	expect(sent[0]!.text).toContain("做完了：改了 a.ts");

	child.messages.push(user("再改一下"), reply("改好了"));
	end("s1", "done", { by: "human" });
	expect(sent[1]!.options.wake).toBe(false);

	child.messages.push(user("<session-message>"), reply("b.ts 也改了"));
	end("s1", "done", FROM_ORIGIN);
	expect(sent[2]!.options.wake).toBe(true);
	// 别的会话的信、运行时叫起的不叫醒来处；人说话的一轮中途读到过来处的信照样叫醒，读到别的会话的信不叫醒。
	end("s1", "done", { by: "peer", from: "q" });
	end("s1", "done", { by: "runtime" });
	end("s1", "done", { by: "human" }, ["p"]);
	end("s1", "done", { by: "human" }, ["q"]);
	expect(sent.slice(3).map((one) => one.options.wake)).toEqual([false, false, true, false]);

	child.messages.push(user("<session-message>"), reply("出错了"));
	end("s1", "error", FROM_ORIGIN);
	expect(sent[7]!.options).toMatchObject({ wake: false, delivery: { status: "failed", incomplete: true } });

	expect(sent).toHaveLength(8);
	end("s1", "aborted");
	end("s1", "interrupted");
	expect(sent).toHaveLength(8);
});

it("每轮汇报：收尾时还有事没回来先不交，回来以后那一轮收场时交（它的 cause 由本体沿用上一轮的）；来处那次调用不在了不交；回复只取前 400 字", () => {
	const child = { toolCallId: "c1", background: true, messages: [user("任务"), reply("已派出子 Agent，等结果")] };
	const { sent, end } = family({ s1: child, s2: { toolCallId: "gone", messages: [user("x"), reply("y")] } });
	end("s1");
	expect(sent).toEqual([]);
	child.background = false;
	child.messages.push(user("结果", { synthetic: true, delivery: [] }), reply("字".repeat(500)));
	end("s1");
	expect(sent).toHaveLength(1);
	expect(sent[0]!.options.wake).toBe(true);
	expect(sent[0]!.text).toContain(`${"字".repeat(400)}…`);
	expect(sent[0]!.text).not.toContain("字".repeat(401));

	end("s2");
	expect(sent).toHaveLength(1);
});

it("每轮汇报：收尾时没回来的事被人停掉、没再开一轮，真闲下来时照样交上这一轮的，不叫醒；又开了一轮就交给那一轮收场时定", async () => {
	const child = { toolCallId: "c1", background: true, messages: [user("任务"), reply("已起后台命令，等结果")] };
	const other = {
		toolCallId: "c2",
		background: true,
		messages: [user("<session-message>", { peer: [{ sessionId: "p", from: "p", text: "去做" }] }), reply("等着")],
	};
	const { sent, end, settle } = family({ s1: child, s2: other });
	end("s1");
	end("s2", "done", FROM_ORIGIN);
	expect(sent).toEqual([]);

	await settle("s1");
	expect(sent.map((one) => [one.sessionId, one.options.wake])).toEqual([["s1", false]]);
	expect(sent[0]!.text).toContain("已起后台命令，等结果");

	// s2 被回来的结果叫起了新的一轮：本体让它沿用上一轮的（来处的信引起的），叫醒；之前那次等闲下来的不再交。
	other.background = false;
	other.messages.push(user("结果", { synthetic: true, delivery: [] }), reply("做完了"));
	end("s2", "done", FROM_ORIGIN);
	await settle("s2");
	expect(sent.map((one) => [one.sessionId, one.options.wake])).toEqual([
		["s1", false],
		["s2", true],
	]);
	expect(sent[1]!.text).toContain("做完了");
});

it("汇报的结尾送出那一刻才写：那时弹着卡的会话（或挂在它下面的子会话弹着卡）点名在等用户", () => {
	const { sent, end, session } = family({ s1: { toolCallId: "c1", name: "cli", messages: [user("任务"), reply("好了")] } });
	end("s1");
	const tail = sent[0]!.options.frame!.tail!;
	expect(tail()).not.toContain("在等用户");
	session("s1").approvals = [{} as never];
	expect(tail()).toContain("cli（s1） 在等用户");
});

it("没要 reportBack 的、子会话、来处归档了的不交；删掉的会话不再等它闲下来", async () => {
	const { reports, sent, end, settle, session } = family({ s1: { toolCallId: "c1", messages: [user("任务"), reply("好了")] } });
	session("s1").summary.kind = "child";
	end("s1");
	session("s1").summary.kind = "top";
	session("p").summary.archived = true;
	end("s1");
	session("p").summary.archived = false;
	session("s1").summary.spawnedFrom = { sessionId: "p", toolCallId: "c1" };
	end("s1");
	expect(sent).toEqual([]);

	session("s1").summary.spawnedFrom = { sessionId: "p", toolCallId: "c1", reportBack: true };
	session("s1").summary.background = true;
	reports.turnEnded(session("s1"), { reason: "done" });
	reports.forget(["s1"]);
	await settle("s1");
	expect(sent).toEqual([]);
});
