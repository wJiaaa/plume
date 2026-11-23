/**
 * 改动文件列表和目录树共用的行内小件：变更状态标、对齐的增删统计、复制文件路径按钮。
 */

import { IconButton, Text } from "@plume/ui";
import { Check, Copy } from "@plume/ui/icons";
import { useEffect, useRef, useState } from "react";
import type { FileStatus } from "../api.ts";
import type { MessageKey } from "../messages.ts";
import { formatStatCount } from "./diff-layout.ts";
import { useT } from "./i18n.ts";

const STATUS_META: Record<FileStatus, { glyph: string; labelKey: MessageKey }> = {
	added: { glyph: "A", labelKey: "fileStatus.added" },
	untracked: { glyph: "U", labelKey: "fileStatus.untracked" },
	modified: { glyph: "M", labelKey: "fileStatus.modified" },
	deleted: { glyph: "D", labelKey: "fileStatus.deleted" },
	renamed: { glyph: "R", labelKey: "fileStatus.renamed" },
};

/** 单个文件的 git 状态字母标（A / M / D / R / U），色相按语义区分。 */
export function FileStatusBadge({ status }: { status: FileStatus }) {
	const t = useT();
	const meta = STATUS_META[status];
	return (
		<Text as="span" size="caption" mono weight="medium" data-git-status={status} data-plume-tip={t(meta.labelKey)} className="git-status-badge">
			{meta.glyph}
		</Text>
	);
}

/** 对齐的 `+增 −删` 统计；两个数都是 0 时不占位。 */
export function DiffStat({ added, removed, inline = false, className = "" }: { added: number; removed: number; inline?: boolean; className?: string }) {
	if (added <= 0 && removed <= 0) return null;
	return (
		<Text size="caption" mono numeric className={`${inline ? "git-stat-inline" : "git-stat"} ${className}`.trim()}>
			{added > 0 && <span className="git-add">+{formatStatCount(added)}</span>}
			{removed > 0 && <span className="git-remove">−{formatStatCount(removed)}</span>}
		</Text>
	);
}

/** 悬停时复制相对文件路径，给一个短暂的对勾反馈。 */
export function CopyPathButton({ path }: { path: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	const copy = () => {
		void navigator.clipboard.writeText(path).then(
			() => {
				setCopied(true);
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), 1400);
			},
			() => {},
		);
	};

	return (
		<IconButton
			icon={copied ? <Check size={12} strokeWidth={2.2} className="git-ok" /> : <Copy size={12} strokeWidth={1.9} />}
			label={copied ? t("changes.copiedPath") : t("changes.copyPath")}
			size="sm"
			onClick={copy}
		/>
	);
}
