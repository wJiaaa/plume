/**
 * 一个没有行的改动文件：画出图片，或者画文件的标记和大小。
 *
 * 仓库里最常见的二进制文件是图片，图片的 diff 就是前后两张并排；别的（`.zip`）预览不了，照实说。
 */

import { iconColour, lookFor, Text } from "@plume/ui";
import { useEffect, useMemo, useState } from "react";
import type { DiffFile, FileStatus } from "../api.ts";
import type { MessageKey } from "../messages.ts";
import { useT } from "./i18n.ts";
import { baseName, git } from "./remote.ts";

function sidesFor(status: FileStatus): ("head" | "work")[] {
	if (status === "added" || status === "untracked") return ["work"];
	if (status === "deleted") return ["head"];
	return ["head", "work"];
}

const SIDE_LABEL: Record<"head" | "work", MessageKey> = { head: "binaryDiff.before", work: "binaryDiff.after" };

export function BinaryDiff({ cwd, file }: { cwd: string | null; file: DiffFile }) {
	const t = useT();
	const sides = useMemo(() => sidesFor(file.status), [file.status]);
	const [blobs, setBlobs] = useState<Partial<Record<"head" | "work", string | null>>>({});
	const [settled, setSettled] = useState(false);

	useEffect(() => {
		if (!cwd) {
			setSettled(true);
			return;
		}
		let live = true;
		setSettled(false);
		void Promise.all(
			sides.map(async (side) => {
				const blob = await git()
					.blob(cwd, file.path, side)
					.then(
						(value) => value,
						() => null,
					);
				return [side, blob?.dataUrl ?? null] as const;
			}),
		).then((pairs) => {
			if (!live) return;
			setBlobs(Object.fromEntries(pairs));
			setSettled(true);
		});
		return () => {
			live = false;
		};
	}, [cwd, file.path, sides]);

	const drawn = sides.filter((side) => blobs[side]);
	if (settled && drawn.length === 0) return <Mark file={file} />;
	if (!settled) return <div className="git-binary-wait" aria-hidden />;

	return (
		<div className="git-binary">
			{drawn.map((side) => (
				<figure key={side} className="git-binary-side">
					<div className="git-checker git-binary-frame">
						<img src={blobs[side] ?? ""} alt={`${file.path} ${t(SIDE_LABEL[side])}`} className="git-binary-image" />
					</div>
					{/* 有两张要分辨时才标。 */}
					{drawn.length > 1 && (
						<Text size="caption" tone="faint">
							{t(SIDE_LABEL[side])}
						</Text>
					)}
				</figure>
			))}
		</div>
	);
}

/** 不是图片的：文件自己的标记和大小。 */
function Mark({ file }: { file: DiffFile }) {
	const t = useT();
	const name = baseName(file.path);
	const look = lookFor(name, false);
	return (
		<div className="git-binary-mark">
			<look.Icon size={26} strokeWidth={1.6} style={{ color: iconColour(look) }} />
			<Text size="detail" tone="muted" className="git-binary-name">
				{name}
			</Text>
			<Text size="caption" tone="faint">
				{file.bytes ? t("binaryDiff.sized", { size: formatBytes(file.bytes) }) : t("binaryDiff.binary")}
			</Text>
		</div>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
