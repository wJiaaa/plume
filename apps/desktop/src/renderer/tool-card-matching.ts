/** 精确工具名优先，动态工具族的前缀卡片按正常的 order／注册顺序让位。 */
export function matchingToolCards<T extends { order: number; seq: number }>(
	tool: string,
	exact: ReadonlyMap<string, T[]>,
	prefixes: ReadonlyMap<string, T[]>,
): T[] {
	const families = [...prefixes].filter(([prefix]) => tool.startsWith(prefix)).flatMap(([, entries]) => entries);
	families.sort((a, b) => a.order - b.order || b.seq - a.seq);
	return [...(exact.get(tool) ?? []), ...families];
}
