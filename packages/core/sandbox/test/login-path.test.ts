/**
 * 跑命令的环境里带上随包的 ripgrep：模型在 bash 里敲 `rg` 也找得到，不必退到 `grep -r`。
 */

import { expect, it } from "vitest";
import { commandEnv } from "../src/login-path.ts";

// 已经由 shell 组装过的 `PATH`（有系统目录之外的目录）：`commandEnv` 原样用它，不去问登录 shell。
const PATH = ["/opt/homebrew/bin", "/usr/bin", "/bin"].join(":");

it.skipIf(process.platform === "win32")("PLUME_RIPGREP 所在的目录接在 PATH 末尾，用户自己的 rg 先被找到", () => {
	const env = commandEnv({ PATH, PLUME_RIPGREP: "/Applications/Plume.app/Contents/Resources/ripgrep/rg" });
	expect(env.PATH).toBe(`${PATH}:/Applications/Plume.app/Contents/Resources/ripgrep`);
	// 已经在里面的不再接一遍。
	expect(commandEnv({ PATH, PLUME_RIPGREP: "/opt/homebrew/bin/rg" }).PATH).toBe(PATH);
});

it.skipIf(process.platform === "win32")("不是绝对路径的 PLUME_RIPGREP 不动 PATH：`.` 进了 PATH，工作区里的文件就能冒充命令", () => {
	expect(commandEnv({ PATH, PLUME_RIPGREP: "rg" }).PATH).toBe(PATH);
	expect(commandEnv({ PATH }).PATH).toBe(PATH);
});
