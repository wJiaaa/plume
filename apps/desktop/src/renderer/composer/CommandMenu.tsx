import { ScrollText, useI18n } from "@plume/ui";
import { Eraser, SquareTerminal } from "@plume/ui/icons";
import type { MenuCommand } from "./commands.ts";
import { CompletionPopup } from "./CompletionPopup.tsx";

export function CommandMenu({
	commands,
	...props
}: {
	id: string;
	commands: MenuCommand[];
	term: string;
	active: number;
	keyboardSelection: boolean;
	onPick: (command: MenuCommand) => void;
	onHover: (index: number) => void;
}) {
	const { t } = useI18n();
	return (
		<CompletionPopup
			{...props}
			items={commands}
			label={t("command.slash")}
			keyOf={(item) => `${item.plugin ?? ""}:${item.name}`}
			groupOf={(item) => (item.action ? "builtin" : "custom")}
			heading={(item) => t(item.action ? "command.builtin" : "command.custom")}
			row={(item) => {
				const Icon = item.action === "clear" ? Eraser : SquareTerminal;
				const source = item.source ?? (item.action ? t("common.builtin") : "");
				return {
					label: [item.name, item.description, source].filter(Boolean).join(t("common.comma")),
					data: { "data-command": item.name },
					content: (
						<>
							<Icon size={16} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
							<ScrollText text={item.name} className="min-w-0 max-w-[42%] shrink-0 text-ink" />
							<ScrollText text={item.description} className="min-w-0 flex-1 text-ink-muted" />
							<ScrollText text={source} className="ml-auto min-w-0 max-w-[20%] shrink-0 text-detail text-ink-faint" />
						</>
					),
				};
			}}
		/>
	);
}
