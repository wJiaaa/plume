import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

/**
 * JSON 文件读写：同一个文件的写入排队执行，先写临时文件再改名（`writeFileAtomic`），崩溃时不会留下半个文件。
 *
 * 读时去掉开头的 BOM：记事本存的「UTF-8 带 BOM」和 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 都在文件头写 U+FEFF，
 * `JSON.parse` 会在第一个字符上失败，而这份文件在哪个编辑器里看都好好的。
 */
export function jsonFiles() {
	const queues = new Map<string, Promise<unknown>>();
	const exclusive = (file: string, work: () => Promise<void>): Promise<void> => {
		const next = (queues.get(file) ?? Promise.resolve()).then(work, work);
		queues.set(
			file,
			next.catch(() => undefined),
		);
		return next;
	};
	return {
		async read<T>(file: string): Promise<T | undefined> {
			await queues.get(file);
			try {
				return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")) as T;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		write: (file: string, value: unknown, mode?: number) =>
			exclusive(file, async () => {
				await mkdir(dirname(file), { recursive: true });
				await writeFileAtomic(file, JSON.stringify(value, null, 2), mode === undefined ? {} : { mode });
			}),
		async idle() {
			await Promise.all(queues.values());
		},
	};
}

export type JsonFiles = ReturnType<typeof jsonFiles>;
