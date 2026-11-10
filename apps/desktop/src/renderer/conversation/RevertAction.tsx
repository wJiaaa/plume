/**
 * 「撤回并重新编辑」：这条和之后的全部截掉，这条放回输入框。截掉的那几轮改过文件时先问要不要一起退回（`files-back.tsx`）；
 * 没碰过文件的照旧：最后一条直接撤，更早的先问一句，它会带走后面几轮。
 * 一轮还在跑时不给：截掉的可能正是在跑的那一轮。
 */

import type { RevertPlan } from "@plume/contract";
import { IconButton, useI18n } from "@plume/ui";
import { Undo2 } from "@plume/ui/icons";
import { useFilesBack } from "./files-back.tsx";

export function RevertAction({
	running,
	last,
	plan,
	onRevert,
}: {
	running: boolean;
	last: boolean;
	plan: () => Promise<RevertPlan>;
	onRevert: (files: boolean) => void;
}) {
	const { t } = useI18n();
	const filesBack = useFilesBack();

	const ask = () =>
		filesBack.check(
			plan,
			(n) => ({
				title: t("userMessage.undoConfirmTitle"),
				detail: t("revert.filesDetail", { n }),
				blocked: t("revert.filesBlocked"),
				withFiles: t("revert.withFiles"),
				without: t("revert.conversationOnly"),
			}),
			onRevert,
			() => {
				if (last) return onRevert(false);
				filesBack.confirm.ask({
					title: t("userMessage.undoConfirmTitle"),
					detail: t("userMessage.undoConfirmDetail"),
					confirmLabel: t("userMessage.undoConfirm"),
					onConfirm: () => onRevert(false),
				});
			},
		);

	return (
		<>
			<IconButton
				data-message-undo=""
				label={running ? t("userMessage.undoRunning") : t("userMessage.undo")}
				ariaLabel={t("userMessage.undo")}
				explainDisabled
				disabled={running || filesBack.checking}
				onClick={() => {
					if (!running) void ask();
				}}
				icon={<Undo2 size={12.5} strokeWidth={1.8} />}
			/>
			{filesBack.element}
		</>
	);
}
