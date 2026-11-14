/**
 * 工具组里一次调用点开以后（`ToolRow`，单独一次时是整组点开以后）：按它做的是哪种活摆。
 *
 * - 交了文件改动（`FileDiffDetails`）：路径，底下是带行号的 diff。
 * - 跑命令：命令照命令的样子摆在框里（悬停出复制键），底下是输出；跑着时说「运行中 · 12s」，跑完没打一个字说「没有输出」。
 * - 读文件：路径，底下是带行号、按语法上色的那几行。行号从结果里读（每行 `行号→内容`），读不出就照原样摆输出。
 * - 其余：参数（JSON）和输出。
 *
 * 只在点开时挂上：输出拼接、上色都在这里面算，收着的行每次重画不白算。
 */

import type { ChangeHunk } from "@plume/contract";
import { CopyMark, Scroller, translate, useNow } from "@plume/ui";
import type { ReactNode } from "react";
import { relativeTo } from "../markdown/assets.ts";
import { CodeText } from "./detail/CodeText.tsx";
import { DiffView } from "./detail/DiffView.tsx";
import type { Call } from "./grouping.ts";
import { formatElapsed } from "./running-line.ts";
import { declaredDiff, hunksOf, NO_READS, ResultImages, resultText, sameJob, writeDraft } from "./ToolCard.tsx";
import { lineCommand, lineFile, lineNote, runsCommand, toolKind } from "./tool-lines.ts";
import { polledJob, pollOutput } from "./turn-blocks.ts";
import { callStatus, sameItems, stoppedByUser, useCallLive, useCalls, useTranscript } from "./view-state.ts";

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
	const running = status === "running" || status === "approval";
	const now = useNow(running && startedAt !== undefined, 1000);
	const stopped = status === "error" && stoppedByUser(result);
	const failed = status === "error" && !stopped;
	const { block } = writeDraft(call.block, status);
	const shown = (path: string) => (cwd ? (relativeTo(cwd, path) ?? path) : path);

	const hunks = hunksOf(result);
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
	const kind = toolKind(block.name);
	const args = (block.arguments ?? {}) as Record<string, unknown>;
	const command = job
		? (started?.command ?? (result?.details as { command?: unknown } | undefined)?.command)
		: runsCommand(kind)
			? (lineCommand(block.name, args) ?? args.command)
			: undefined;
	const images = result ? <ResultImages result={result} summary={label} spaced={output !== ""} /> : null;
	const tail = (
		<>
			{running && (
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
					<div className="mt-1.5 px-0.5 text-detail text-ink-faint">{stopped ? translate("toolCard.stopped") : translate("toolRow.noOutput")}</div>
				)
			)}
			{images}
		</>
	);

	if (typeof command === "string") {
		return (
			<>
				{/* 「$ 」悬在左边：命令折行时，接下来的几行和命令的头一个字对齐，不和 $ 对齐。 */}
				<div className="group/copy relative rounded-lg border border-line-soft bg-code-bg py-1.5 pr-9 pl-[calc(0.625rem+2ch)] indent-[-2ch] font-mono text-code break-all whitespace-pre-wrap text-ink">
					<span className="select-none text-ink-faint">$ </span>
					<CodeText text={command} kind="shell" />
					<CopyMark text={command} />
				</div>
				{tail}
			</>
		);
	}

	const file = kind === "view" ? lineFile(block.name, args) : undefined;
	const numbered = file && result && !failed ? numberedLines(output) : null;
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
			{Object.keys(rest).length > 0 && (
				<div className="rounded-lg border border-line-soft bg-code-bg px-2.5 py-1.5 font-mono text-code break-all whitespace-pre-wrap text-ink">
					<CodeText text={JSON.stringify(rest, null, 2)} kind="json" />
				</div>
			)}
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
