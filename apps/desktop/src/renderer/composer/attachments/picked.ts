/**
 * 一批刚放进来的文件，连同它们在磁盘上的位置。
 *
 * `File` 自己答不了「从哪儿来」，只有预加载脚本里的 `webUtils.getPathForFile` 答得了；没有位置，一份拖进来的
 * 表格就只是一个名字，打不开也指不出在哪。要在拿到 `FileList` 的那一刻同步取：拖放事件返回时 `DataTransfer`
 * 就清空了。拖、贴、选三条路都走这里，免得哪一条忘了取。
 */

export interface PickedFile {
	file: File;
	/** 磁盘上的位置。粘贴进来的截图没有：剪贴板给的是一团像素，不是某个文件。 */
	path?: string;
	/** 拖进来的是一个目录：没有字节可读，只记路径，见 `readPickedFiles`。 */
	directory?: true;
}

export function pickedFrom(list: FileList | null | undefined): PickedFile[] {
	if (!list) return [];
	return Array.from(list).map((file) => {
		// 取不到就是没有，不是错：这是一次同步调用，抛出来会掀掉整个拖放处理。
		try {
			const path = window.plume.files.pathFor(file);
			return path ? { file, path } : { file };
		} catch {
			return { file };
		}
	});
}

/**
 * 拖进来的一批，认出其中哪些是文件夹。
 *
 * 文件夹在 `files` 里也是一个 `File`，读它的字节会失败；当文件读，结果是一条「无法读取」。是不是文件夹只有
 * `items` 答得出，也只在拖放事件里答得出，所以在第一个 `await` 之前取完。`files` 就是按顺序排的那几个
 * `kind === "file"` 的 item，按下标对得上。
 *
 * `webkitGetAsEntry()` 答不上来（null）时读一个字节试试：文件夹读不出字节，而一份读不出字节、却有路径的东西，
 * 当文件夹至少还指得到它。取不到路径的文件夹丢掉：它什么也指不到。
 */
export async function droppedFrom(transfer: DataTransfer): Promise<PickedFile[]> {
	const entries = Array.from(transfer.items).filter((item) => item.kind === "file");
	const dropped = pickedFrom(transfer.files).map((picked, index) => ({
		picked,
		/** `undefined` 是「没答上来」，不是「不是文件夹」。 */
		directory: entries[index]?.webkitGetAsEntry()?.isDirectory,
	}));

	const out: PickedFile[] = [];
	for (const { picked, directory } of dropped) {
		const folder =
			directory ??
			(picked.path !== undefined &&
				!(await picked.file
					.slice(0, 1)
					.arrayBuffer()
					.then(
						() => true,
						() => false,
					)));
		if (!folder) out.push(picked);
		else if (picked.path) out.push({ ...picked, directory: true });
	}
	return out;
}
