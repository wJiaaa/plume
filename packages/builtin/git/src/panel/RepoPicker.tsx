import { Caret, MENU_MAX_HEIGHT, MenuBody, MenuItem, Popover, ScrollText, Text, usePopover } from "@plume/ui";
import { Check, Folder, GitBranchPlus } from "@plume/ui/icons";
import type { RepoRef } from "../api.ts";
import { useT } from "./i18n.ts";

/**
 * 面板在看哪个仓库，还能看哪些。
 *
 * 一个工作区里放好几个仓库很常见，每个仓库还可能有工作树（同一段历史在别的分支上的另一份检出）。
 * 工作树挂在它所属的仓库下面，不和仓库平列：共用一段历史正是工作树的意义，平铺会把同一个项目的两份检出摆得像两件事。
 */
export function RepoPicker({
	repos,
	trees,
	selected,
	onSelect,
}: {
	repos: RepoRef[];
	trees: Record<string, RepoRef[]>;
	selected: string | null;
	onSelect: (path: string) => void;
}) {
	const t = useT();
	const menu = usePopover();
	const everything = repos.flatMap((repo) => [repo, ...(trees[repo.path] ?? [])]);
	const current = everything.find((entry) => entry.path === selected) ?? repos[0];
	const total = everything.length;
	const pick = (path: string) => {
		onSelect(path);
		menu.close();
	};

	return (
		<>
			<button
				type="button"
				onClick={menu.toggle}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				data-plume-tip={t("repoPicker.count", { n: repos.length, more: total > repos.length ? t("repoPicker.worktrees", { n: total - repos.length }) : "" })}
				data-plume-tip-side="bottom"
				className="plume-scroll git-repo-picker"
			>
				{current?.worktree ? (
					<GitBranchPlus size={12.5} strokeWidth={1.8} className="git-repo-icon" />
				) : (
					<Folder size={12.5} strokeWidth={1.8} className="git-repo-icon" />
				)}
				<Text size="label" className="git-repo-name">
					<ScrollText text={current?.label ?? ""} className="plume-fade-tail git-repo-name-text" />
				</Text>
				{/* 光一个总数说不清数的是什么；分开写。 */}
				<Text size="caption" tone="faint" numeric className="git-repo-count">
					{repos.length}
					{total > repos.length && <span style={{ paddingLeft: 4 }}>+{total - repos.length}</span>}
				</Text>
				<Caret open={menu.open} size={12} strokeWidth={1.9} className="git-repo-caret" />
			</button>

			{menu.open && (
				<Popover
					anchor={menu.anchor}
					onClose={menu.close}
					placement="bottom"
					align="start"
					width="wide"
					maxHeight={MENU_MAX_HEIGHT}
					label={t("repoPicker.switch")}
				>
					<MenuBody>
						{repos.map((repo) => (
							<div key={repo.path}>
								<MenuItem
									icon={<Folder size={13} strokeWidth={1.8} />}
									detail={repo.branch ?? t("sync.detached")}
									selected={repo.path === selected}
									title={repo.path}
									trailing={repo.path === selected ? <Check size={12.5} strokeWidth={2.2} /> : undefined}
									onClick={() => pick(repo.path)}
								>
									{repo.label}
								</MenuItem>
								{(trees[repo.path] ?? []).map((tree) => (
									<MenuItem
										key={tree.path}
										icon={<GitBranchPlus size={13} strokeWidth={1.8} />}
										detail={tree.branch ?? t("sync.detached")}
										selected={tree.path === selected}
										title={tree.path}
										trailing={tree.path === selected ? <Check size={12.5} strokeWidth={2.2} /> : undefined}
										onClick={() => pick(tree.path)}
									>
										{tree.label}
									</MenuItem>
								))}
							</div>
						))}
					</MenuBody>
				</Popover>
			)}
		</>
	);
}
