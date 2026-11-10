import { Trash2 } from "../icons/index.ts";
import { IconButton } from "./IconButton.tsx";

/** 动作的位置一直占着，包括只有悬停或键盘焦点才让它露出来的时候。 */
export function RowDeleteButton({ label, onClick, pending = false }: { label: string; onClick: () => void; pending?: boolean }) {
	return (
		<span className="plume-row-action relative flex shrink-0" data-pending={pending || undefined}>
			<IconButton
				label={label}
				tone="danger"
				icon={<Trash2 size={14} strokeWidth={1.8} />}
				disabled={pending}
				onClick={(event) => {
					event.stopPropagation();
					onClick();
				}}
			/>
		</span>
	);
}
