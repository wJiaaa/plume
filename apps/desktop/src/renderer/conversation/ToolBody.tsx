/**
 * 工具组里一次调用点开以后（`ToolRow`，单独一次时是整组点开以后）：按它做的是哪种活摆。
 *
 * - 交了文件改动（`FileDiffDetails`）：路径，底下是带行号的 diff。
 * - 跑命令：命令照命令的样子摆在框里（悬停出复制键），底下是输出；跑着时说「运行中 · 12s」，跑完没打一个字说「没有输出」。
 * - 读文件：路径，底下是带行号、按语法上色的那几行。行号从结果里读（每行 `行号→内容`），读不出就照原样摆输出。
 * - 插件给了详情（`ToolLine.fields`）：列成几行「名称 值」，不摆参数和输出。
 * - 其余：参数（JSON）和输出。
 *
 * 调用答完了、它在后台留下了事的（`CallState.background`），最后说一句它在后台怎样了：还在跑、跑完、出错、被停下。
 *
 * 只在点开时挂上：输出拼接、上色都在这里面算，收着的行每次重画不白算。
 */

import type { BackgroundCallState, ChangeHunk } from "@plume/contract";
import { activeLocale, CopyMark, type MessageKey, Scroller, translate, useNow } from "@plume/ui";
import { Fragment, type ReactNode, useMemo } from "react";
import { relativeTo } from "../markdown/assets.ts";
import { CommandBox, JsonBox } from "./detail/CodeText.tsx";
import { DiffView } from "./detail/DiffView.tsx";
import type { Call } from "./grouping.ts";
import { formatElapsed } from "./running-line.ts";
import { declaredDiff, hunksOf, NO_READS, ResultImages, resultText, sameJob, writeDraft } from "./ToolCard.tsx";
import { lineCommand, lineFields, lineFile, lineNote, runsCommand, toolKind } from "./tool-lines.ts";
import { polledJob, pollOutput } from "./turn-blocks.ts";
import { callStatus, callStopped, callUnanswered, sameItems, useCallLive, useCalls, useTranscript } from "./view-state.ts";

/** 点开以后最后那一句：它在后台留下的那件事此刻怎样。 */
const BACKGROUND_WORDS: Record<BackgroundCallState, MessageKey> = {
	running: "toolRow.background",
	exited: "toolRow.backgroundDone",
	failed: "toolRow.backgroundFailed",
	stopped: "toolCard.stopped",
};

/** 带行号的代码框里最多画多少行：读文件一次最多也就这么多，再多是在拖慢展开。 */
const MAX_CODE_LINES = 2000;

export function ToolBody({ call, polls, label }: { call: Call; polls?: Call[] | undefined; label: string }) {
	const { cwd } = useTranscript();
	const job = polledJob(call.block);
	const latest = job && polls ? polls[polls.length - 1]! : call;
	const status = useCalls((calls) => callStatus(calls, latest.block.id, latest.stopReason));
	const result = useCalls((calls) => calls.results.get(latest.block.id));
	const started = useCalls((calls) => (job ? calls.jobs.get(job) : undefined), sameJob);
	const reads = useCalls((calls) => (job ? (polls ?? [call]).map((one) => calls.results.get(one.block.id)) : NO_READS), sameItems);
	const { progress, startedAt } = useCallLive(latest.block.id);
	const later = useCalls((calls) => calls.background[latest.block.id]);
	const running = status === "running" || status === "approval";
	const now = useNow(running && startedAt !== undefined, 1000);
	const stopped = useCalls((calls) => status === "error" && callStopped(calls, latest.block.id));
	const unanswered = useCalls((calls) => callUnanswered(calls, latest.block.id));
	// 输出标红只看这次调用自己：它答得好好的、是后来后台那件出错了的，输出不是错的。
	const failed = status === "error" && !stopped && unanswered === undefined && result?.isError !== false;
	const { block } = writeDraft(call.block, status);
	const shown = (path: string) => (cwd ? (relativeTo(cwd, path) ?? path) : path);

	const hunks = hunksOf(result);
	const kind = toolKind(block.name);
	const args = (block.arguments ?? {}) as Record<string, unknown>;
	const file = kind === "view" ? lineFile(block.name, args) : undefined;
	const read = !hunks && file && !failed ? result : undefined;
	// 收起过渡中详情仍挂着。只按读取结果拆行，否则同一份代码会被当成新的 diff，在消失前重新上色一次。
	const numbered = useMemo(() => (read ? numberedLines(resultText(read.content)) : null), [read]);
	if (hunks) {
		const path = declaredDiff(result)?.path;
		const file = typeof path === "string" ? path : undefined;
		return (
			<>
				{file && <PathLine path={shown(file)} />}
				<CodeBox>
					<DiffView hunks={hunks} {...(file ? { path: file } : {})} />
				</CodeBox>
			</>
		);
	}

	const output = job ? pollOutput(reads.flatMap((read) => (read ? [resultText(read.content)] : []))) : result ? resultText(result.content) : (progress ?? "");
	const command = job
		? (started?.command ?? (result?.details as { command?: unknown } | undefined)?.command)
		: runsCommand(kind)
			? (lineCommand(block.name, args) ?? args.command)
			: undefined;
	const images = result ? <ResultImages result={result} summary={label} spaced={output !== ""} /> : null;
	// 调用答完了还在跑的，是它起的任务在后台跑；停下、出错的这一句只说后台那件，调用自己的结果照常摆。
	const afterwards =
		result && later ? (
			<div className={`mt-1.5 px-0.5 text-detail ${later === "failed" ? "text-danger" : "text-ink-faint"}`} data-tool-background={later}>
				{translate(BACKGROUND_WORDS[later])}
			</div>
		) : null;
	const tail = (
		<>
			{running && !result && (
				<div className="mt-1.5 px-0.5 text-detail text-ink-faint tabular-nums">
					{translate("toolRow.running")}
					{startedAt !== undefined && now - startedAt >= 1000 ? ` · ${formatElapsed(now - startedAt)}` : ""}
				</div>
			)}
			{output !== "" ? (
				<Output text={output} failed={failed} />
			) : (
				result &&
				!running &&
				!resultHasImages(result) && (
					<div className="mt-1.5 px-0.5 text-detail text-ink-faint">{stopped && !later ? translate("toolCard.stopped") : translate("toolRow.noOutput")}</div>
				)
			)}
			{images}
			{afterwards}
		</>
	);

	const fields = result && !result.isError ? lineFields(block.name, args, result.details, activeLocale()) : [];
	if (fields.length > 0) {
		return (
			<>
				<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 px-0.5 text-detail" data-tool-fields="">
					{fields.map((field, index) => (
						<Fragment key={index}>
							<dt className="text-ink-faint">{field.label}</dt>
							<dd className={`break-words whitespace-pre-wrap text-ink ${field.mono ? "font-mono text-code" : ""}`}>{field.value}</dd>
						</Fragment>
					))}
				</dl>
				{afterwards}
			</>
		);
	}

	if (typeof command === "string") {
		return (
			<>
				<CommandBox command={command} />
				{tail}
			</>
		);
	}

	if (file && numbered) {
		return (
			<>
				<PathLine path={shown(file.path)} />
				<CodeBox>
					<DiffView hunks={numbered.hunks} path={file.path} maxLines={MAX_CODE_LINES} />
				</CodeBox>
				{numbered.rest && <div className="mt-1.5 px-0.5 text-detail break-words whitespace-pre-wrap text-ink-faint">{numbered.rest}</div>}
				{images}
			</>
		);
	}

	// 模型写的说明已经是这一行的标题，参数里不再摆一遍。
	const note = lineNote(block.name, args);
	const rest = Object.fromEntries(Object.entries(args).filter(([, value]) => typeof value !== "string" || value.trim() !== note));
	return (
		<>
			{Object.keys(rest).length > 0 && <JsonBox text={JSON.stringify(rest, null, 2)} />}
			{tail}
		</>
	);
}

function PathLine({ path }: { path: string }) {
	return <div className="mb-1.5 px-0.5 text-detail break-all text-ink">{path}</div>;
}

/** 代码框：diff、读到的那几行。竖着封顶，横着由 `DiffView` 自己滚。 */
function CodeBox({ children }: { children: ReactNode }) {
	return (
		<div className="overflow-hidden rounded-lg border border-line-soft">
			<Scroller className="max-h-72" overscroll="auto">
				{children}
			</Scroller>
		</div>
	);
}

function Output({ text, failed }: { text: string; failed: boolean }) {
	return (
		<div className="group/copy relative mt-1.5">
			<Scroller className="max-h-80" overscroll="auto">
				<div className={`px-0.5 pr-8 font-mono text-code break-words whitespace-pre-wrap ${failed ? "text-danger" : "text-ink"}`}>{text}</div>
			</Scroller>
			<CopyMark text={text} />
		</div>
	);
}

function resultHasImages(result: { content: readonly { type: string }[]; shownImages?: readonly unknown[] | undefined }): boolean {
	return result.content.some((part) => part.type === "image") || (result.shownImages?.length ?? 0) > 0;
}

const NUMBERED = /^\s*(\d+)→(.*)$/;

/**
 * 读文件的结果按行号拆开：开头那行方括号里的路径（`[src/a.ts]`）上面已经摆过，跳过；接着连着的 `行号→内容` 那几行是代码，
 * 后面跟着的（「还有 N 行」这类说明）是附注。拆成一段只有上下文行的 diff，交给 `DiffView` 画：行号栏、语法上色、横滚和 diff
 * 是同一个样子。一行都拆不出就是 null。
 */
function numberedLines(output: string): { hunks: ChangeHunk[]; rest: string } | null {
	const lines = output.split("\n");
	const code: ChangeHunk["lines"] = [];
	let at = 0;
	while (at < lines.length && /^\[[^\]\n]*\]$/.test(lines[at]!.trim())) at++;
	for (; at < lines.length; at++) {
		const match = NUMBERED.exec(lines[at]!);
		if (!match) break;
		code.push({ type: "context", text: match[2]!, newLine: Number(match[1]) });
	}
	if (code.length === 0) return null;
	const first = code[0]!.newLine!;
	return { hunks: [{ oldStart: first, newStart: first, lines: code }], rest: lines.slice(at).join("\n").trim() };
}
