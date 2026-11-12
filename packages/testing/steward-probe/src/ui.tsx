/**
 * 代管探针的面板：没有会话时开一个代管会话；在会话里往里转话、看弹着的卡并替人答、看模型的回复。
 * 卡和回复来自逻辑入口（`ctx.sessions.observe`），不读面板自己的 `session`：外面的插件也只能这样拿到它们。
 * 出错原样写在面板里（人停止代管以后再转话，就在这里看到本体的拒绝）。
 */

import type { PanelProps, Remote, UiContext, UiPlugin } from "@plume/contract/ui";
import { Button, Text, TextArea, useI18n } from "@plume/ui";
import { Plug } from "@plume/ui/icons";
import { type CSSProperties, useEffect, useState } from "react";
import { NAME, type ProbeApi, type ProbeView } from "./api.ts";
import { MESSAGES } from "./messages.ts";

const COLUMN: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: 12 };
const ROW: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap" };

/** 一句话交成 `{ answer }`，像 JSON 的按 JSON 交：探针不认识具体的卡，交什么由人在面板里写。 */
function parseAnswer(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return { answer: text.trim() };
	}
}

function stewardPanel(ui: UiContext, api: Remote<ProbeApi>) {
	return function StewardPanel({ session, cwd }: PanelProps) {
		const text = MESSAGES[useI18n().resolvedLocale];
		const sessionId = session?.summary.id;
		const [draft, setDraft] = useState("");
		const [reply, setReply] = useState("");
		const [view, setView] = useState<ProbeView>();
		const [error, setError] = useState<string>();
		const [busy, setBusy] = useState(false);

		useEffect(() => {
			setView(undefined);
			if (!sessionId) return;
			const call = api.watch(sessionId);
			void (async () => {
				try {
					for await (const next of call) setView(next);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			})();
			return () => call.cancel();
		}, [sessionId]);

		const run = async (task: () => Promise<unknown>) => {
			setError(undefined);
			setBusy(true);
			try {
				await task();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setBusy(false);
			}
		};
		const settled = (done: boolean) => {
			if (!done) setError(text.missed);
		};

		const errorLine = error && (
			<Text as="p" size="detail" tone="danger" data-probe-error="">
				{error}
			</Text>
		);

		if (!sessionId) {
			return (
				<div style={COLUMN} data-steward-probe="">
					<Text as="p" size="detail" tone="muted">
						{text.openHint}
					</Text>
					<TextArea value={draft} onChange={setDraft} data-probe-input="" />
					<div style={ROW}>
						<Button
							variant="primary"
							size="sm"
							disabled={!draft.trim()}
							loading={busy}
							data-probe-open=""
							onClick={() =>
								void run(async () => {
									const id = await api.open(draft, cwd);
									setDraft("");
									await ui.openSession(id);
								})
							}
						>
							{text.open}
						</Button>
					</div>
					{errorLine}
				</div>
			);
		}

		const stewarded = session.summary.steward === NAME;
		const pending = view?.pending?.request;
		// 卡可能是子会话（子智能体、侧边聊天）弹的：答的时候传弹它的那个会话。
		const asker = view?.pending?.sessionId ?? sessionId;
		return (
			<div style={COLUMN} data-steward-probe={sessionId}>
				<Text as="p" size="detail" tone={stewarded ? "accent" : "faint"} data-probe-stewarded={stewarded ? "yes" : "no"}>
					{stewarded ? text.stewarded : text.notStewarded}
				</Text>
				<TextArea value={draft} onChange={setDraft} data-probe-input="" />
				<div style={ROW}>
					<Button
						size="sm"
						disabled={!draft.trim()}
						loading={busy}
						data-probe-post=""
						onClick={() =>
							void run(async () => {
								await api.post(sessionId, draft);
								setDraft("");
							})
						}
					>
						{text.post}
					</Button>
				</div>
				{errorLine}

				<Text as="h3" size="title">
					{text.pending}
				</Text>
				{pending ? (
					<div
						style={COLUMN}
						data-probe-pending={pending.toolCallId}
						data-probe-pending-type={pending.type ?? "approval"}
						data-probe-pending-child={asker === sessionId ? "no" : "yes"}
					>
						<Text size="label">{pending.title}</Text>
						{asker !== sessionId && (
							<Text size="caption" tone="faint">
								{text.fromChild}
							</Text>
						)}
						<Text size="caption" tone="faint" mono>
							{pending.tool} · {pending.kind}
						</Text>
						{pending.type === "request" ? (
							<>
								<Text as="p" size="caption" tone="faint">
									{text.answerHint}
								</Text>
								<TextArea value={reply} onChange={setReply} data-probe-answer-input="" />
								<div style={ROW}>
									<Button
										size="sm"
										variant="primary"
										disabled={!reply.trim()}
										data-probe-answer=""
										onClick={() => void run(async () => settled(await api.answer(asker, pending.toolCallId, parseAnswer(reply))))}
									>
										{text.answer}
									</Button>
									<Button size="sm" data-probe-reject="" onClick={() => void run(async () => settled(await api.respond(asker, pending.toolCallId, "reject")))}>
										{text.reject}
									</Button>
								</div>
							</>
						) : (
							<div style={ROW}>
								<Button
									size="sm"
									variant="primary"
									data-probe-allow=""
									onClick={() => void run(async () => settled(await api.respond(asker, pending.toolCallId, "once")))}
								>
									{text.allow}
								</Button>
								<Button size="sm" data-probe-reject="" onClick={() => void run(async () => settled(await api.respond(asker, pending.toolCallId, "reject")))}>
									{text.reject}
								</Button>
							</div>
						)}
					</div>
				) : (
					<Text as="p" size="detail" tone="faint">
						{text.noPending}
					</Text>
				)}

				<Text as="h3" size="title">
					{text.replies}
				</Text>
				{view && view.replies.length > 0 ? (
					view.replies.map((line, index) => (
						<Text key={index} as="p" size="body" data-probe-reply="">
							{line}
						</Text>
					))
				) : (
					<Text as="p" size="detail" tone="faint">
						{text.noReplies}
					</Text>
				)}
			</div>
		);
	};
}

export default {
	name: NAME,
	apply(ui) {
		const api = ui.remote<ProbeApi>();
		ui.panel("steward", stewardPanel(ui, api), {
			title: (locale) => MESSAGES[locale].title,
			description: (locale) => MESSAGES[locale].description,
			icon: Plug,
		});
	},
} satisfies UiPlugin;
