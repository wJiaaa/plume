/**
 * 一个列表里还没人用的供应商名字。
 *
 * 两个同名供应商是两行分不清的东西，而且会传下去：两个模型同名时选择器靠供应商名区分，供应商再同名就没有可区分的了。
 * 「新供应商」每次按都是同一个名字，所以新建时在这里避开。用编号而不是 id 做后缀：要的是列表里读得懂。
 * 导入时的同一条规则在 agent 进程（packages/core/agent/src/provider-transfer.ts）。
 */
export function uniqueProviderName(taken: Iterable<string>, wanted: string): string {
	const used = new Set<string>();
	for (const name of taken) used.add(name.trim());
	const base = wanted.trim();
	if (!base || !used.has(base)) return wanted;
	for (let n = 2; ; n++) {
		const candidate = `${base} ${n}`;
		if (!used.has(candidate)) return candidate;
	}
}
