import { DiffFileList, SkeletonBar, Text } from "@plume/ui";
import type { DiffFile } from "../api.ts";
import { BinaryDiff } from "./BinaryDiff.tsx";
import { DiffView, type DiffLayout } from "./DiffView.tsx";
import { useT } from "./i18n.ts";

/** 整个目录都没跟踪时，git 给的是带 `/` 结尾的那一条。 */
function isDirectory(path: string): boolean {
	return path.endsWith("/");
}

/**
 * 展开的一个文件下面画什么：没跟踪的目录、二进制、还在读、没有可以按行比的内容，其余是它的 diff。列表和树共用。
 */
export function FileDiffBody({
	file,
	cwd,
	loadingContent,
	layout,
	wrap,
}: {
	file: DiffFile;
	cwd: string | null;
	loadingContent: boolean;
	layout: DiffLayout;
	wrap: boolean;
}) {
	const t = useT();
	if (isDirectory(file.path))
		return (
			<Text as="p" size="detail" tone="faint" className="git-file-note">
				{t("diffList.untracked")}
			</Text>
		);
	if (file.binary) return <BinaryDiff cwd={cwd} file={file} />;
	if (!file.hunks.length && loadingContent)
		return (
			<div className="git-file-skeleton" aria-hidden>
				<SkeletonBar width="88%" height={10} />
				<SkeletonBar width="64%" height={10} />
				<SkeletonBar width="76%" height={10} />
			</div>
		);
	if (!file.hunks.length)
		return (
			<Text as="p" size="detail" tone="faint" className="git-file-note">
				{t("diffList.noLineDiff")}
			</Text>
		);
	return <DiffView hunks={file.hunks} path={file.path} layout={layout} wrap={wrap} />;
}

/**
 * 改动的文件，一个个展开成自己的 diff。行和工具栏是 `@plume/ui` 的多文件 diff，和交付卡的审核面板长得一样；
 * 三个视图共用，只有行尾的按钮不同（`actions`）。
 */
export function FileDiffList({
	files,
	actions,
	emptyLabel,
	initiallyOpen,
	cwd = null,
	loadingContent = false,
	openPaths,
	onTogglePath,
}: {
	files: DiffFile[];
	/** 文件在这台机器上的哪个仓库；为空时二进制文件只写名字和大小，画不出图。 */
	cwd?: string | null;
	actions?: (file: DiffFile) => React.ReactNode;
	emptyLabel?: string;
	initiallyOpen?: boolean;
	/** 行是真的，diff 还在读：展开的文件没有 hunk 时画占位，而不是说「没有可以按行比的内容」。 */
	loadingContent?: boolean;
	/** 外部受控展开集合；省略时由列表自己记。 */
	openPaths?: ReadonlySet<string>;
	onTogglePath?: (path: string) => void;
}) {
	const t = useT();
	return (
		<DiffFileList
			files={files}
			open={openPaths}
			onToggle={onTogglePath}
			initiallyOpen={initiallyOpen}
			actions={actions}
			emptyLabel={emptyLabel ?? t("diffList.noMatch")}
			renderDiff={(file, view) => <FileDiffBody file={file} cwd={cwd} loadingContent={loadingContent} {...view} />}
		/>
	);
}
