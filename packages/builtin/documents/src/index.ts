import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@plume/contract";
import { MAX_BYTES, type DocumentsApi, type Sheets } from "./api.ts";
import { MESSAGES } from "./messages.ts";
import { readDatabase, readWorkbook } from "./readers.ts";

const READER = "--plume-document-reader";
// 同一打包入口作为子进程启动，避免给插件构建器另加一套入口约定。
if (process.argv[2] === READER) {
	try {
		const data =
			process.argv[4] === "database" ? readDatabase(process.argv[3] ?? "", process.argv[5] ?? "[{n} bytes]") : await readWorkbook(process.argv[3] ?? "");
		process.stdout.write(JSON.stringify(data));
	} catch (error) {
		process.stderr.write(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

export default {
	name: "plume.documents",
	apply(ctx) {
		const lifetime = new AbortController();
		ctx.effect(() => lifetime.abort());
		ctx.serve({
			async sheets(data, database, call) {
				const text = MESSAGES[ctx.locale()];
				if (!(data instanceof Uint8Array) || typeof database !== "boolean") throw new Error(text.invalid);
				if (data.byteLength > MAX_BYTES) throw new Error(text.tooLarge);
				const signal = AbortSignal.any([call.signal, lifetime.signal]);
				signal.throwIfAborted();
				const dir = await mkdtemp(join(ctx.dataDir, "preview-"));
				try {
					const path = join(dir, "document");
					await writeFile(path, data, { mode: 0o600, signal });
					signal.throwIfAborted();
					return await new Promise<Sheets>((resolve, reject) => {
						const entry = fileURLToPath(import.meta.url);
						const child = spawn(
							process.execPath,
							[
								...(entry.endsWith(".ts") ? ["--experimental-strip-types", "--no-warnings"] : []),
								entry,
								READER,
								path,
								database ? "database" : "workbook",
								text.blob,
							],
							{
								stdio: ["ignore", "pipe", "pipe"],
								env: { ...process.env, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "1" },
								windowsHide: true,
							},
						);
						let output = "",
							errors = "",
							failure: Error | undefined;
						const stop = (error: Error) => {
							failure ??= error;
							child.kill("SIGKILL");
						};
						const abort = () => stop(new Error("Document preview cancelled"));
						const timer = setTimeout(() => stop(new Error(text.timeout)), 5000);
						signal.addEventListener("abort", abort, { once: true });
						if (signal.aborted) abort();
						child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
							if (output.length + chunk.length > 16 * 1024 * 1024) stop(new Error(text.outputLarge));
							else output += chunk;
						});
						child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
							if (errors.length < 4000) errors += chunk;
						});
						child.on("error", (error) => {
							failure = error;
						});
						child.on("close", (code) => {
							clearTimeout(timer);
							signal.removeEventListener("abort", abort);
							if (failure || code !== 0) {
								reject(failure ?? new Error(errors || text.invalid));
								return;
							}
							try {
								resolve(JSON.parse(output) as Sheets);
							} catch {
								reject(new Error(text.invalid));
							}
						});
					});
				} finally {
					await rm(dir, { recursive: true, force: true });
				}
			},
		} satisfies DocumentsApi);
	},
} satisfies Plugin;
