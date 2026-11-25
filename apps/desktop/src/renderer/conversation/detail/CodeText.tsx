import { CopyMark } from "@plume/ui";
import { TOKEN_CLASS, type Token, tokenizeJson, tokenizeShell } from "./tokens.ts";

export type CodeKind = "shell" | "json" | "text";

/** 卡片里的代码按它是什么上色：一条命令在哪里展示都是同一个样子。 */
export function CodeText({ text, kind }: { text: string; kind: CodeKind }) {
	const tokens: Token[] = kind === "shell" ? tokenizeShell(text) : kind === "json" ? tokenizeJson(text) : [{ text, kind: "plain" }];
	return (
		<>
			{tokens.map((token, index) => {
				const className = TOKEN_CLASS[token.kind];
				// 按位置作 key：同一段文字切出来的片段只按次序排，没有别的身份。
				return className ? (
					<span key={index} className={className}>
						{token.text}
					</span>
				) : (
					token.text
				);
			})}
		</>
	);
}

/** 一条命令的框，工具卡片的详情和审批卡共用。 */
export function CommandBox({ command }: { command: string }) {
	return (
		// 「$ 」悬在左边：命令折行时，接下来的几行和命令的头一个字对齐，不和 $ 对齐。
		<div className="group/copy relative rounded-lg border border-line-soft bg-code-bg py-1.5 pr-9 pl-[calc(0.625rem+2ch)] indent-[-2ch] font-mono text-code break-all whitespace-pre-wrap text-ink">
			<span className="select-none text-ink-faint">$ </span>
			<CodeText text={command} kind="shell" />
			<CopyMark text={command} />
		</div>
	);
}

/** JSON 参数的框，工具卡片的详情和审批卡共用。 */
export function JsonBox({ text }: { text: string }) {
	return (
		<div className="rounded-lg border border-line-soft bg-code-bg px-2.5 py-1.5 font-mono text-code break-all whitespace-pre-wrap text-ink">
			<CodeText text={text} kind="json" />
		</div>
	);
}
