import type { FilePreviewProps } from "@plume/contract/ui";
import { FileHeader } from "./FileHeader.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { baseName } from "./open-file.ts";

/** 插件已经读取的文档复用文件面板，不为预览放宽工作区外的文件读取权限。 */
export function PluginFilePreview({ sessionId, path, contents }: FilePreviewProps) {
	const name = baseName(path);
	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col">
			<FileHeader path={path} name={name} contents={contents} />
			<FileViewer sessionId={sessionId} path={path} name={name} contents={contents} />
		</div>
	);
}
