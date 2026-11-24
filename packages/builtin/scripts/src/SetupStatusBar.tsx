import type { ComposerAboveProps, Remote, UiContext } from "@plume/contract/ui";
import { Button, StatusSpinner, Text, useI18n } from "@plume/ui";
import { SquareTerminal } from "@plume/ui/icons";
import type { ScriptsApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import type { SetupRunStatus } from "./types.ts";

export function SetupStatusBar({ session, api, ui }: ComposerAboveProps & { api: Remote<ScriptsApi>; ui: UiContext }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const status = ui.useSessionStore<SetupRunStatus | null>("setup-status", session.summary.id);
	if (!status) return null;
	return (
		<div className="plume-scripts-setup-bar" role="status" data-scripts-setup-status="">
			<div className="plume-scripts-setup-info">
				<StatusSpinner size={13} className="plume-scripts-setup-spinner" />
				<Text size="detail" tone="muted" className="plume-scripts-setup-text">
					{text.setupRunning(status.scriptName)}
				</Text>
			</div>
			<Button
				size="xs"
				variant="subtle"
				icon={<SquareTerminal size={12} aria-hidden />}
				onClick={() => {
					void api.revealTerminal(session.summary.id, status.tab).catch((error: unknown) => {
						ui.notify(error instanceof Error ? error.message : String(error), "error");
					});
				}}
			>
				{text.viewTerminal}
			</Button>
		</div>
	);
}
