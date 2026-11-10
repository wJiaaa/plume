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
