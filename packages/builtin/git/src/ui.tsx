/**
 * plume.git 的界面入口：Git 面板、输入框上方的分支签和改动计数；对话自己的工作树——项目签那一行里的开关、工作树签和
 * 没建成的提醒，侧栏行首的 ⑂，删除确认框里会留下什么，设置页里「工作树」一节。git 本身在逻辑入口，这边经 `ui.remote()` 调。
 */

import type { UiPlugin } from "@plume/contract/ui";
import { FolderGit2, GitCompare } from "@plume/ui/icons";
import type { GitApi } from "./api.ts";
import dialogCss from "./css/dialog.css";
import diffCss from "./css/diff.css";
import panelCss from "./css/panel.css";
import sharedCss from "./git.css";
import { BranchChip, ChangeBar } from "./panel/composer.tsx";
import { GitPanel } from "./panel/GitPanel.tsx";
import { PANEL_ID, setHost } from "./panel/host.ts";
import { setGit } from "./panel/remote.ts";
import type { WorktreeApi } from "./worktree/api.ts";
import { WorktreeSlot } from "./worktree/chip.tsx";
import { WORKTREE_MESSAGES } from "./messages.ts";
import { setWorktreeHost } from "./worktree/remote.ts";
import { WorktreesSettings } from "./worktree/settings.tsx";
import { deleteNote, WorktreeMark } from "./worktree/sidebar.tsx";
import worktreeCss from "./worktree/worktree.css";

/**
 * 宿主不加载插件的样式表，这里自己挂一份。按插件名认那个元素：更新后重新加载时换掉内容，不叠一份。
 * 停用后留着也无妨：没有这些组件时类名没人用。
 */
function mountStyles(): void {
	const id = "plume.git";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = [sharedCss, panelCss, diffCss, dialogCss, worktreeCss].join("\n");
}

export default {
	name: "plume.git",
	apply(ui) {
		mountStyles();
		const remote = ui.remote<GitApi & WorktreeApi>();
		setGit(remote);
		setWorktreeHost(ui, remote);
		setHost(ui);
		ui.panel(PANEL_ID, GitPanel, {
			title: "Git",
			restore: true,
			detachable: true,
			icon: GitCompare,
			shortcut: "CommandOrControl+Shift+R",
			// 要在项目里才列：不属于项目的聊天没有可看的检出。项目还不是仓库也列，面板里有「初始化仓库」「让 Agent 处理」。
			available: ({ cwd }) => Boolean(cwd),
		});
		// 分支紧跟在项目后面：发送前要确认的就是「哪个项目、哪个分支」。
		ui.composerChip("branch", BranchChip, { side: "start" });
		ui.composerChip("changes", ChangeBar, { side: "end" });
		// 工作树开关、工作树签跟在分支签后面：项目、分支、要不要副本，是发送前一起看的三件事。
		ui.composerChip("worktree", WorktreeSlot, { side: "start", order: 10 });
		ui.sessionMark(WorktreeMark);
		ui.deleteNote((sessionId, locale) => deleteNote(sessionId, WORKTREE_MESSAGES[locale]));
		const useProjects = ui.useProjects.bind(ui);
		ui.settingsSection("worktrees", () => <WorktreesSettings useProjects={useProjects} />, {
			title: (locale) => WORKTREE_MESSAGES[locale].title,
			icon: FolderGit2,
			group: "vcs",
			page: "nav",
		});
	},
} satisfies UiPlugin;
