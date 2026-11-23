import type { CommandTrigger } from "@plume/contract";
import { ScrollText, useI18n } from "@plume/ui";
import { Eraser, Sparkles, SquareTerminal } from "@plume/ui/icons";
import type { MenuCommand } from "./commands.ts";
import { CompletionPopup } from "./CompletionPopup.tsx";

export function CommandMenu({
	commands,
	trigger,
	...props
}: {
	id: string;
	commands: MenuCommand[];
	trigger: CommandTrigger;
	term: string;
	active: number;
	keyboardSelection: boolean;
	onPick: (command: MenuCommand) => void;
	onHover: (index: number) => void;
}) {
	const { t } = useI18n();
	const dollar = trigger === "$";
	return (
		<CompletionPopup
			{...props}
			items={commands}
			label={t(dollar ? "command.skill" : "command.slash")}
			keyOf={(item) => `${item.trigger ?? "/"}:${item.plugin ?? ""}:${item.name}`}
			groupOf={(item) => (dollar ? "dollar" : item.action ? "builtin" : "custom")}
			heading={(item) => t(dollar ? "command.skill" : item.action ? "command.builtin" : "command.custom")}
			row={(item) => {
				const Icon = dollar ? Sparkles : item.action === "clear" ? Eraser : SquareTerminal;
				const source = item.source ?? (item.action ? t("common.builtin") : "");
				return {
					label: [item.name, item.description, source].filter(Boolean).join(t("common.comma")),
					data: { "data-command": item.name, "data-command-trigger": item.trigger ?? "/" },
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
