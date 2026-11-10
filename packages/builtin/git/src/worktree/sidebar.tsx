/**
 * 侧栏和删除确认框里属于工作树的两样：有工作树的对话行首画 ⑂（空闲时，代替产品的空心圈），删掉它之前说清会留下什么。
 */

import type { SessionMarkProps } from "@plume/contract/ui";
import { GitFork } from "@plume/ui/icons";
import { useEffect, useSyncExternalStore } from "react";
import type { WorktreeMessages as Messages } from "../messages.ts";
import { useText, worktree } from "./remote.ts";

/**
 * 有工作树的会话 → 分支，所有行共用一份。行挂上、会话换了目录（第一轮开出工作树、检不出来退回项目）时重读；
 * 一屏的行同时挂上只读一两次：读着的时候再要读，等这次回来补读一次。
 */
let branches: Record<string, string> = {};
let reading = false;
let again = false;
const listeners = new Set<() => void>();

function reload(): void {
	if (reading) {
		again = true;
		return;
	}
	reading = true;
	worktree()
		.worktreeBranches()
		.then(
			(next) => {
				branches = next;
				for (const listener of listeners) listener();
			},
			() => {},
		)
		.finally(() => {
			reading = false;
			if (!again) return;
			again = false;
			reload();
		});
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function WorktreeMark({ session, fallback }: SessionMarkProps) {
	const text = useText();
	const branch = useSyncExternalStore(subscribe, () => branches[session.id]);
	useEffect(reload, [session.id, session.cwd]);
	if (!branch) return <>{fallback}</>;
	const tip = text.inWorktree(branch);
	return (
		<span data-worktree-mark="" data-plume-tip={tip} data-plume-tip-side="right" role="img" aria-label={tip} className="worktree-mark">
			<GitFork size={11} strokeWidth={2.1} aria-hidden />
		</span>
	);
}

/**
 * 删除确认框里的那句：删掉对话会收走工作树的目录，合进基分支的分支一起删。活得比对话长的那部分点出来，
 * 它是这份活里唯一不跟着删的：没提交的文件留在原地，没合并的提交留在分支上。
 */
export async function deleteNote(sessionId: string, text: Messages): Promise<string | undefined> {
	const [record, state] = await Promise.all([worktree().worktreeRecord(sessionId), worktree().worktreeState(sessionId)]);
	const tree = record?.worktree;
	if (!tree || !state) return undefined;
	const lines: string[] = [];
	if (state.present && state.uncommitted > 0) lines.push(text.deleteUncommitted(state.uncommitted, tree.cwd));
	if (state.ahead > 0) lines.push(text.deleteUnmerged(state.ahead, state.branch));
	if (lines.length === 0 && state.present) lines.push(text.deleteWorktree);
	return lines.join(" ") || undefined;
}
