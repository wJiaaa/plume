/**
 * 截掉一段对话之前，问一句那几轮改过的文件要不要一起退回去。
 *
 * 撤回和编辑重发做的是同一个截断，截掉的那几轮改过的文件原样留在磁盘上：重问时模型以为回到了这句话之前，
 * 读到的代码却已经被「不存在的那几轮」改过。所以两边先问那几轮碰过哪些文件（只演算，钩子 session.rewind），
 * 再让人选：连文件一起，或者只动对话。有一个文件不能安全退回，就只剩后者，并说明是哪个、为什么。
 */

import type { RevertPlan } from "@plume/contract";
import { Scroller, useConfirmer, useI18n } from "@plume/ui";
import { useCallback, useRef, useState } from "react";
import { relativeTo } from "../files/paths.ts";
import { useFileScope } from "../files/scope.ts";

/** 这个框在这一处的说法：标题、两种说明、两颗按钮。 */
export interface FilesBackWords {
	title: string;
	/** 全部能退回时。 */
	detail: string;
	/** 有文件不能安全退回时。 */
	blocked: string;
	withFiles: string;
	without: string;
}

/**
 * 被截掉的那几轮碰过哪些文件；没碰过、或者问不出来，都是 null。
 *
 * 问不出来当没碰过：只动对话照样做得成，真要写文件时会再查一遍。
 */
async function filesBackPlan(plan: () => Promise<RevertPlan>): Promise<RevertPlan | null> {
	try {
		const value = await plan();
		return value.files.length ? value : null;
	} catch {
		return null;
	}
}

export function useFilesBack() {
	const { t } = useI18n();
	const workspace = useFileScope()?.cwd;
	const confirm = useConfirmer();
	const confirmAsk = confirm.ask;

	const ask = useCallback(
		(plan: RevertPlan, words: FilesBackWords, choose: (files: boolean) => void) => {
			const safe = !plan.unrecorded && plan.files.every((file) => file.problem === null);
			confirmAsk({
				title: words.title,
				detail: safe ? words.detail : words.blocked,
				confirmLabel: safe ? words.withFiles : words.without,
				onConfirm: () => choose(safe),
				...(safe ? { alternate: { label: words.without, onConfirm: () => choose(false) } } : {}),
				children: (
					<Scroller className="max-h-48" contentClassName="flex flex-col gap-1.5 text-label" top="fade" bottom="fade">
						{plan.files.map((file) => (
							<div key={file.path} data-revert-file="" className="flex min-w-0 items-center gap-3">
								<RevertFileName path={workspace ? relativeTo(workspace, file.path) : file.path} />
								{file.problem ? (
									<span className="shrink-0 text-ink-muted">{t(`revert.problem.${file.problem}`)}</span>
								) : (
									<Counts added={file.added} removed={file.removed} />
								)}
							</div>
						))}
						{plan.unrecorded && <p className="text-ink-muted">{t("revert.unrecorded")}</p>}
					</Scroller>
				),
			});
		},
		[confirmAsk, t, workspace],
	);

	// 演算还没回来时再按一次，会弹两个框、做两遍。挡第二遍靠 ref：state 要等下一次渲染才看得到。
	const busy = useRef(false);
	const [checking, setChecking] = useState(false);
	/** 先问那几轮碰过哪些文件：碰过就让人选，没碰过走 `orElse`。 */
	const check = useCallback(
		async (plan: () => Promise<RevertPlan>, words: (count: number) => FilesBackWords, choose: (files: boolean) => void, orElse: () => void) => {
			if (busy.current) return;
			busy.current = true;
			setChecking(true);
			const value = await filesBackPlan(plan).finally(() => {
				busy.current = false;
				setChecking(false);
			});
			if (value) ask(value, words(value.files.length), choose);
			else orElse();
		},
		[ask],
	);

	return { check, checking, confirm, element: confirm.element };
}

/** 文件名留全，目录让位：这个框窄，路径稍长整条一起截的话，人要认的文件名先被截没了。 */
function RevertFileName({ path }: { path: string }) {
	const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
	return (
		<span className="flex min-w-0 flex-1" data-plume-tip={path}>
			<span className="min-w-0 truncate text-ink-muted">{path.slice(0, split)}</span>
			<span className="shrink-0 text-ink">{path.slice(split)}</span>
		</span>
	);
}

function Counts({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="flex shrink-0 items-center gap-1.5 tabular-nums">
			<span className="text-ok">+{added}</span>
			<span className="text-danger">−{removed}</span>
		</span>
	);
}
