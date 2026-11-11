/**
 * 子智能体经 `yield` 交回的对象，按它的样子画，而不是印一段 JSON。这里不认结构，只读值：结构是父会话和子智能体
 * 约好的，看面板的人没签过它，不该还得读懂它。
 *
 * 在三百来像素宽的面板里，按「一个人怎么读回报」排，而不是一份数据库导出：
 *
 * - `summary` 是开头那段话，不带标签——它就是结论。
 * - 是非（`passed`）是顶上的一枚章：过了还是没过，第一眼就该知道。
 * - 一列记录一条一条地读，不是表格（四列会把「问题」挤成每行四个字）：严重度和位置在第一行，要说的话独占一行，
 *   其余的小一号跟在后面；带严重度的按轻重排。
 * - 长文本（报告、结构说明）直接展开成 Markdown——那就是交付物，不该还得先点一下。
 * - 键名换成人话；认不得的键把下划线和驼峰拆开，照原样写。
 */

import type { UiContext } from "@plume/contract/ui";
import { Text, useI18n } from "@plume/ui";
import { Check, TriangleAlert, X } from "@plume/ui/icons";
import type { ReactNode } from "react";
import { fill, MESSAGES, type Messages } from "./messages.ts";

type Plain = Record<string, unknown>;

/** 长到该当成一段文章来读的，不再塞进一行里。 */
const SHORT_TEXT = 160;
/** 严重度从重到轻；认不得的排在最后，按原来的先后。 */
const SEVERITY_ORDER = ["critical", "high", "error", "medium", "warning", "low", "info", "note"];

function isPlain(value: unknown): value is Plain {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordList(value: unknown): value is Plain[] {
	return Array.isArray(value) && value.length > 0 && value.every(isPlain);
}

/** 空字符串、null、undefined 都算没写；空数组不算——「没有」本身是个回答。 */
function present(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	return typeof value !== "string" || value.trim() !== "";
}

/** 这个对象里有没有一个人能读的东西。`{ summary: "", files: [] }` 也能过校验，但什么都没说。 */
export function hasContent(value: unknown): boolean {
	if (typeof value === "string") return value.trim() !== "";
	if (typeof value === "number" || typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.some(hasContent);
	if (isPlain(value)) return Object.values(value).some(hasContent);
	return false;
}

/** 像路径的用等宽字画，别的当一句话。 */
function looksLikePath(key: string, value: unknown): boolean {
	return typeof value === "string" && (/^(path|file|files?|location|command|dir|where)$/i.test(key) || /^[\w./@-]+\.[a-z]{1,5}(:\d+(-\d+)?)?$/i.test(value));
}

function labelOf(key: string, text: Messages): string {
	return (
		text.outputLabels[key] ??
		key
			.replace(/[_-]+/g, " ")
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.trim()
	);
}

function rank(severity: unknown): number {
	const at = SEVERITY_ORDER.indexOf(String(severity).toLowerCase());
	return at === -1 ? SEVERITY_ORDER.length : at;
}

/** 带严重度的记录按轻重排（稳定排序，同一档保持交上来的先后）。 */
function bySeverity(rows: Plain[]): Plain[] {
	return rows.every((row) => typeof row.severity === "string") ? [...rows].sort((a, b) => rank(a.severity) - rank(b.severity)) : rows;
}

let ui: UiContext;

export function connectStructured(context: UiContext): void {
	ui = context;
}

export function StructuredOutput({ output, warnings, sessionId }: { output: Plain; warnings?: string[]; sessionId: string }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const entries = Object.entries(output).filter(([, value]) => present(value));
	const lead = typeof output.summary === "string" && output.summary.trim() ? output.summary.trim() : null;
	const flags = entries.filter(([, value]) => typeof value === "boolean") as [string, boolean][];
	const rest = entries.filter(([key, value]) => typeof value !== "boolean" && !(key === "summary" && lead));
	return (
		<div className="subagents-out" data-structured-output="">
			{flags.length > 0 && (
				<div className="subagents-out-flags">
					{flags.map(([key, value]) => (
						<Flag key={key} name={key} value={value} />
					))}
				</div>
			)}
			{lead && (
				<div data-field="summary" data-kind="lead">
					<ui.Markdown text={lead} sessionId={sessionId} className="subagents-out-prose" />
				</div>
			)}
			{rest.map(([key, value]) => (
				<Field key={key} name={key} value={value} sessionId={sessionId} />
			))}
			{warnings && warnings.length > 0 && (
				<div data-output-warnings="" className="subagents-out-warnings">
					<Text as="p" size="caption" tone="faint" className="subagents-line">
						<TriangleAlert size={12} aria-hidden />
						{fill(warnings.length === 1 ? text.outputWarning : text.outputWarnings, { n: warnings.length })}
					</Text>
					<ul className="subagents-out-warning-list">
						{warnings.map((warning, index) => (
							// 只读、按位置。
							<li key={index}>
								<Text size="caption" tone="faint">
									{warning}
								</Text>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/** 是非：`passed` 说「通过 / 没通过」，别的键说「键名 · 是 / 否」。颜色只给结论，不给别的是非。 */
function Flag({ name, value }: { name: string; value: boolean }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	if (name === "passed") {
		return (
			<Text size="caption" weight="medium" className="subagents-out-flag" data-field={name} data-kind="flag" data-passed={value}>
				{value ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
				{value ? text.outputPassed : text.outputNotPassed}
			</Text>
		);
	}
	return (
		<Text size="caption" tone="muted" className="subagents-out-flag" data-field={name} data-kind="flag">
			{labelOf(name, text)} · {value ? text.yes : text.no}
		</Text>
	);
}

function Field({ name, value, sessionId }: { name: string; value: unknown; sessionId: string }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	if (typeof value === "number") {
		return (
			<Row name={name} kind="number">
				<Text numeric>{value}</Text>
			</Row>
		);
	}
	if (typeof value === "string") {
		if (value.length > SHORT_TEXT || value.includes("\n")) {
			return (
				<Section name={name} kind="long-text">
					<ui.Markdown text={value} sessionId={sessionId} className="subagents-out-prose" />
				</Section>
			);
		}
		return (
			<Row name={name} kind="text">
				{looksLikePath(name, value) ? (
					<Text size="detail" mono className="subagents-out-path">
						<PathText path={value} />
					</Text>
				) : (
					<Rich text={value} />
				)}
			</Row>
		);
	}
	if (isRecordList(value)) return <Records name={name} rows={value} sessionId={sessionId} />;
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return (
				<Row name={name} kind="empty">
					<Text tone="faint">{text.nothing}</Text>
				</Row>
			);
		}
		return (
			<Section name={name} kind="list" count={value.length}>
				<ul className="subagents-out-list">
					{value.map((item, index) => (
						// 只读、按位置，序号就是它的身份。
						<li key={index} className="subagents-out-bullet">
							<span aria-hidden className="subagents-out-dot" />
							<Text as="div" size={looksLikePath(name, item) ? "detail" : "label"} mono={looksLikePath(name, item)} className="subagents-out-wrap">
								{isPlain(item) ? (
									<StructuredOutput output={item} sessionId={sessionId} />
								) : looksLikePath(name, item) ? (
									<PathText path={String(item)} />
								) : (
									<Rich text={String(item)} />
								)}
							</Text>
						</li>
					))}
				</ul>
			</Section>
		);
	}
	if (isPlain(value)) {
		return (
			<Section name={name} kind="object">
				<div className="subagents-out-nested">
					<StructuredOutput output={value} sessionId={sessionId} />
				</div>
			</Section>
		);
	}
	return null;
}

/** 一行说完的：左边是它叫什么，右边是它。 */
function Row({ name, kind, children }: { name: string; kind: string; children: ReactNode }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	return (
		<div className="subagents-out-row" data-field={name} data-kind={kind}>
			<Text size="caption" tone="faint" className="subagents-out-key">
				{labelOf(name, text)}
			</Text>
			<Text className="subagents-out-wrap">{children}</Text>
		</div>
	);
}

/** 要占几行的：小标题在上，内容在下，占满整个宽度。 */
function Section({ name, kind, count, children }: { name: string; kind: string; count?: number; children: ReactNode }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	return (
		<section className="subagents-out-section" data-field={name} data-kind={kind}>
			<Text as="div" size="caption" tone="faint" className="subagents-out-heading">
				<span>{labelOf(name, text)}</span>
				{count !== undefined && (
					<Text size="caption" tone="faint" numeric>
						· {count}
					</Text>
				)}
			</Text>
			{children}
		</section>
	);
}

/** 一列记录，一条一条地读；`steps` 这种先后本身就是意思的，前面标上序号。 */
function Records({ name, rows, sessionId }: { name: string; rows: Plain[]; sessionId: string }) {
	const severe = rows.every((row) => typeof row.severity === "string");
	const ordered = bySeverity(rows);
	const numbered = /^(steps|stages)$/i.test(name);
	return (
		<Section name={name} kind={severe ? "findings" : "records"} count={rows.length}>
			<ol className="subagents-out-records">
				{ordered.map((row, index) => (
					// 记录按位置。
					<Item key={index} row={row} index={numbered ? index + 1 : undefined} sessionId={sessionId} />
				))}
			</ol>
		</Section>
	);
}

/**
 * 一条记录：第一行是「多严重、在哪儿」，扫一眼就知道该不该先看它；接着是它的名字（有的话）和它要说的那句话，
 * 占满一整行；剩下的几句小一号、带上它们叫什么，跟在后面。
 */
function Item({ row, index, sessionId }: { row: Plain; index?: number; sessionId: string }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const severity = typeof row.severity === "string" ? row.severity : null;
	const line = typeof row.line === "number" ? row.line : null;
	const fields = Object.entries(row).filter(([key, value]) => key !== "severity" && present(value) && !(key === "line" && line !== null));
	const where = fields.filter(([key, value]) => typeof value === "string" && looksLikePath(key, value) && value.length <= SHORT_TEXT) as [string, string][];
	const title = fields.find(([key, value]) => typeof value === "string" && /^(name|title)$/i.test(key)) as [string, string] | undefined;
	const texts = fields.filter(([key, value]) => typeof value === "string" && !where.some(([other]) => other === key) && key !== title?.[0]) as [
		string,
		string,
	][];
	const lists = fields.filter(([, value]) => Array.isArray(value)) as [string, unknown[]][];
	const scalars = fields.filter(([, value]) => typeof value === "number" || typeof value === "boolean") as [string, number | boolean][];
	const nested = fields.filter(([, value]) => isPlain(value)) as [string, Plain][];
	return (
		<li className="subagents-out-item" data-item="" data-severity={severity ?? undefined}>
			{index !== undefined && (
				<Text size="caption" tone="faint" numeric className="subagents-out-index">
					{index}
				</Text>
			)}
			<div className="subagents-out-item-body">
				{(severity || where.length > 0) && (
					<div className="subagents-out-where">
						{severity && <Severity value={severity} />}
						{where.map(([key, value], at) => (
							<Text key={key} size="caption" tone="muted" mono data-item-where="" className="subagents-out-path">
								<PathText path={`${value}${at === 0 && line !== null && !/:\d+/.test(value) ? `:${line}` : ""}`} />
							</Text>
						))}
					</div>
				)}
				{title && (
					<Text as="p" weight="medium" className="subagents-out-wrap">
						<Rich text={title[1]} />
					</Text>
				)}
				{texts.map(([key, value], at) =>
					at === 0 ? (
						<Text key={key} as="p" size={title ? "detail" : "label"} tone={title ? "muted" : "default"} data-item-text="" className="subagents-out-text">
							<Rich text={value} />
						</Text>
					) : (
						<Text key={key} as="p" size="detail" tone="muted" data-item-text="" className="subagents-out-text">
							<Text tone="faint" size="detail">
								{labelOf(key, text)} ·{" "}
							</Text>
							<Rich text={value} />
						</Text>
					),
				)}
				{lists.map(([key, value]) =>
					value.length === 0 ? null : (
						<div key={key} className="subagents-out-chips" data-item-list={key}>
							{value.map((entry, at) => (
								// 只读、按位置。
								<Text key={at} size="caption" tone="muted" mono={looksLikePath(key, entry)} data-item-chip="" className="subagents-out-chip">
									{isPlain(entry) ? (
										Object.values(entry).map(String).join(" · ")
									) : looksLikePath(key, entry) ? (
										<PathText path={String(entry)} />
									) : (
										String(entry)
									)}
								</Text>
							))}
						</div>
					),
				)}
				{scalars.length > 0 && (
					<Text as="p" size="caption" tone="faint">
						{scalars.map(([key, value]) => `${labelOf(key, text)} ${typeof value === "boolean" ? (value ? text.yes : text.no) : value}`).join(" · ")}
					</Text>
				)}
				{nested.map(([key, value]) => (
					<div key={key} className="subagents-out-nested">
						<StructuredOutput output={{ [key]: value }} sessionId={sessionId} />
					</div>
				))}
			</div>
		</li>
	);
}

/** 严重度一枚小章：最重的那几档用危险色，其余由深到浅的灰——不为它再添一种语义色。 */
function Severity({ value }: { value: string }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const level = rank(value);
	return (
		<Text
			size="caption"
			weight="medium"
			data-item-severity={value}
			data-level={level <= 2 ? "high" : level <= 4 ? "medium" : "low"}
			className="subagents-out-severity"
		>
			{text.severityLabels[value.toLowerCase()] ?? value}
		</Text>
	);
}

/** 一句短话里的行内记号：模型写这些字段的习惯和写正文一样，函数名套反引号、要紧的词加粗。 */
function Rich({ text }: { text: string }) {
	return <ui.Markdown text={text} inline />;
}

/** 一条路径，折行时从斜杠后面折：面板窄，见字就断会把 `.ts` 拆成两半；一段本身都放不下时才任意处断。 */
function PathText({ path }: { path: string }) {
	const parts = path.split("/");
	return (
		<>
			{parts.map((part, index) => (
				// 只读、按位置。
				<span key={index}>
					{part}
					{index < parts.length - 1 && (
						<>
							/<wbr />
						</>
					)}
				</span>
			))}
		</>
	);
}
