/**
 * 一次提交，活在弹窗外面。
 *
 * 提交弹窗关掉就卸载，而它做的事都要等：留空生成要模型写两三秒，提交并推送更久。状态长在弹窗上的话，按一下 Esc，
 * 转圈、写到一半的话、工具条上那颗按钮的忙碌都没了，磁盘上的事照样在跑。所以这份状态归面板，弹窗只是它的样子：
 * 关掉再打开还是原来那一个；`active` 是按钮转圈的理由，也是它忙着时仍能按下去（回到弹窗）的理由。
 *
 * 不在这里的是「包含未暂存」：它跟着暂存区的数目走，重开时按当下重算才对。
 */

import { useEffect, useState } from "react";

/** 弹窗底下三行，哪一行在跑。 */
type CommitAction = "commit" | "commitAndPush" | "push";

/** 提交到当前分支，还是一个还没建的新分支。 */
type CommitTarget = { kind: "current" } | { kind: "new"; name: string };

export interface CommitWork {
	/** 输入框里那句话，生成的也写回这里。 */
	message: string;
	setMessage: (value: string) => void;
	/** 新分支到真提交那一刻才建，这里只存名字。 */
	target: CommitTarget;
	setTarget: (value: CommitTarget) => void;
	action: CommitAction | null;
	setAction: (value: CommitAction | null) => void;
	/** 模型在写提交说明；可以和 `action` 同时为真。 */
	generating: boolean;
	setGenerating: (value: boolean) => void;
	active: boolean;
}

export function useCommitWork(cwd: string | null): CommitWork {
	const [message, setMessage] = useState("");
	const [target, setTarget] = useState<CommitTarget>({ kind: "current" });
	const [action, setAction] = useState<CommitAction | null>(null);
	const [generating, setGenerating] = useState(false);

	// 换了仓库，草稿不跟过去：写给 A 的提交说明出现在 B 的框里，会被原样提交上去。跑着的那件事不清，它自己收尾。
	useEffect(() => {
		setMessage("");
		setTarget({ kind: "current" });
	}, [cwd]);

	return { message, setMessage, target, setTarget, action, setAction, generating, setGenerating, active: action !== null || generating };
}
