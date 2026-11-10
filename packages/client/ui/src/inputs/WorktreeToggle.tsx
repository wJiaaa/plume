/**
 * 这次对话在它自己的工作树里，还是就在项目本身里。
 *
 * 每次对话各自选，在发出第一条消息之前——只有这一刻选择才有意义，跑过的对话事后没法搬进一份副本。
 * 起始值由用它的地方给（建议卡片从模型说的 `edits_in_parallel` 起步）；没有「新会话默认开」的设置，开不开每一次由人定。
 *
 * 是项目和分支旁边的一个开关，不是菜单：答案只有两个，一眼都看得见——只有标志，或者标志加上它的名字、
 * 用强调色，和计划模式开关说同一件事的方式一样。分叉图标是侧栏标在有工作树的对话上的那个，不是旁边
 * 分支标记的那个。
 *
 * 放在基础组件里而不是某个功能里，因为有两处要问这个问题——主输入框，问正在写的这次对话；建议的
 * 对话卡片，问它要开始的那一次。
 */

import { GitFork } from "../icons/index.ts";
import { useI18n } from "../i18n/index.ts";
import { ComposerToggle } from "./ComposerToggle.tsx";

export function WorktreeToggle({
	on,
	onChange,
	size = "composer",
}: {
	on: boolean;
	onChange: (on: boolean) => void;
	/** `sm` 放在 `Button size="sm"` 旁边，比如建议卡片上：26px，主输入框的控件是 28px。 */
	size?: "composer" | "sm";
}) {
	const { t } = useI18n();
	return (
		<ComposerToggle
			data-plume-worktree-toggle=""
			on={on}
			onChange={onChange}
			size={size}
			icon={<GitFork size={16} strokeWidth={1.8} />}
			label={t("composer.worktree")}
			tip={on ? t("composer.worktreeOn") : t("composer.worktreeOff")}
		/>
	);
}
