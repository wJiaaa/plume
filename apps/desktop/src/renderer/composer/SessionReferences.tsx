import { useSyncExternalStore } from "react";
import { useI18n } from "@plume/ui";
import { MessageSquare, X } from "@plume/ui/icons";
import type { SessionReference } from "./session-references.ts";

const drafts = new Map<string, SessionReference[]>();
const empty: SessionReference[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
export const sessionReferences = (scope: string): SessionReference[] => drafts.get(scope) ?? empty;
export function setSessionReferences(scope: string, refs: SessionReference[]): void {
	if (refs.length) drafts.set(scope, [...new Map(refs.map((ref) => [ref.id, ref])).values()]);
	else drafts.delete(scope);
	for (const listener of listeners) listener();
}
export function useSessionReferences(scope: string): SessionReference[] {
	return useSyncExternalStore(subscribe, () => sessionReferences(scope));
}
export function SessionReferences({
	references,
	onRemove,
	onOpen,
}: {
	references: readonly SessionReference[];
	onRemove?: (id: string) => void;
	onOpen?: (id: string) => void;
}) {
	const { t } = useI18n();
	return (
		<div className="flex flex-wrap gap-1.5" data-session-references="">
			{references.map((ref) => (
				<button
					key={ref.id}
					type="button"
					aria-label={onRemove ? t("composer.removeSessionRef", { title: ref.title }) : ref.title}
					onClick={() => (onRemove ? onRemove(ref.id) : onOpen?.(ref.id))}
					className="flex h-8 max-w-[240px] items-center gap-1.5 rounded-lg border border-line-soft bg-card pl-2 pr-1.5 text-caption text-ink-muted transition-colors hover:text-ink active:bg-elevated"
				>
					<MessageSquare size={12} className="shrink-0" />
					<span className="min-w-0 truncate">{ref.title}</span>
					{onRemove && <X size={12} className="shrink-0" />}
				</button>
			))}
		</div>
	);
}
