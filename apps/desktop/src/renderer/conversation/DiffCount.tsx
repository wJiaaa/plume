/** 过程行尾的「+N -M」：一次改动，或一段活加总的增删行数。过程行的骨架本身是 `@plume/ui` 的 `FlowRow`。 */
export function DiffCount({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="font-mono text-caption">
			<span className="text-ok">+{added}</span> <span className="text-danger">-{removed}</span>
		</span>
	);
}
