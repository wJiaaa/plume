import { Folder, MessageCircle } from "@plume/ui/icons";
import { translate, portal } from "@plume/ui";
import { CARD_Z, useCardPlacement } from "./SessionCard.tsx";

export function ProjectCard({
	name,
	path,
	folders,
	count,
	anchor,
	leaving,
}: {
	folders?: readonly string[];
	name: string;
	path: string;

	count: number;

	anchor: DOMRect;
	leaving?: boolean;
}) {
	const { card, at } = useCardPlacement(anchor);

	return portal(
		<div
			ref={card}
			role="tooltip"
			data-plume-project-card=""
			style={{ zIndex: CARD_Z, left: at?.left ?? -9999, top: at?.top ?? -9999, opacity: at ? undefined : 0 }}
			className={`bg-float shadow-menu pointer-events-none fixed w-max max-w-[340px] min-w-[220px] overflow-hidden rounded-xl border border-line-float px-3 py-2.5 ${
				leaving ? "sidebar-card-out" : "sidebar-card-in"
			}`}
		>
			<p className="truncate text-label text-ink">{name}</p>
			<p className="mt-1 flex items-center gap-1.5 text-detail text-ink-muted">
				<MessageCircle size={11.5} strokeWidth={1.9} className="shrink-0 text-ink-faint" />
				{translate("projectCard.chats", { n: count })}
			</p>
			<div className="mt-2 flex flex-col gap-1">
				{[...new Set([path, ...(folders ?? [])])].map((folder) => (
					<p key={folder} data-plume-project-card-folder="" className="flex items-start gap-1.5 text-detail text-ink-muted">
						<Folder size={11.5} strokeWidth={1.9} className="mt-[3px] shrink-0 text-ink-faint" />
						<span className="min-w-0 [overflow-wrap:anywhere]">{folder}</span>
					</p>
				))}
			</div>
		</div>,
	);
}
