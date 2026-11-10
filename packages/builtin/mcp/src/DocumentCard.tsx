import type { Remote, ToolCardProps, UiContext } from "@plume/contract/ui";
import { Button, Card, Text, useI18n } from "@plume/ui";
import { useCallback, useState } from "react";
import type { McpApi } from "./api.ts";
import { isDocumentList, type DocumentRef } from "./document-types.ts";
import { MESSAGES } from "./messages.ts";

function Document({ document, sessionId, ui, api }: { document: DocumentRef; sessionId: string; ui: UiContext; api: Remote<McpApi> }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [open, setOpen] = useState(false);
	const readBytes = useCallback(
		async (signal: AbortSignal) => {
			signal.throwIfAborted();
			const call = api.readDocument(sessionId, document.id);
			const cancel = () => call.cancel();
			signal.addEventListener("abort", cancel, { once: true });
			try {
				const chunks: Uint8Array[] = [];
				let length = 0;
				for await (const chunk of call) {
					signal.throwIfAborted();
					length += chunk.length;
					if (length > document.bytes) throw new Error(text.documentReadFailed);
					chunks.push(chunk);
				}
				signal.throwIfAborted();
				if (length !== document.bytes) throw new Error(text.documentReadFailed);
				const bytes = new Uint8Array(length);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.length;
				}
				return bytes;
			} finally {
				cancel();
				signal.removeEventListener("abort", cancel);
			}
		},
		[api, sessionId, document.id, document.bytes, text.documentReadFailed],
	);
	return (
		<Card
			title={document.name}
			status={
				<Button size="xs" variant="subtle" expanded={open} data-mcp-document={document.name} onClick={() => setOpen(!open)}>
					{open ? text.documentClose : text.documentOpen}
				</Button>
			}
		>
			{open && (
				<div className="mcp-document-preview">
					<ui.DocumentPreview
						name={document.name}
						identity={`${sessionId}:${document.id}`}
						readBytes={readBytes}
						fallback={<Text tone="faint">{text.documentUnavailable}</Text>}
					/>
				</div>
			)}
		</Card>
	);
}

export function documentCard(ui: UiContext, api: Remote<McpApi>) {
	return function Documents({ sessionId, status, result, fallback }: ToolCardProps) {
		const details = result?.details;
		const documents = details && typeof details === "object" && "documents" in details ? details.documents : undefined;
		if (status !== "done" || !isDocumentList(documents)) return <>{fallback}</>;
		return (
			<>
				{fallback}
				<div className="mcp-documents">
					{documents.map((document, index) => (
						<Document key={`${document.id}:${index}`} document={document} sessionId={sessionId} ui={ui} api={api} />
					))}
				</div>
			</>
		);
	};
}
