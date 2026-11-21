import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

test("欢迎区原生缩放的每一步都保持居中、字号不缩放、不挡输入", { skip: process.platform !== "darwin" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "plume-welcome-zoom-"));
	try {
		const executable = join(dir, "check");
		execFileSync("xcrun", [
			"clang",
			"-fobjc-arc",
			"-framework",
			"AppKit",
			"-framework",
			"QuartzCore",
			join(import.meta.dirname, "mac-welcome-zoom.m"),
			"-o",
			executable,
		]);
		execFileSync(executable);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
