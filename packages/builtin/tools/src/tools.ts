/**
 * 工具：read、write、edit、ls、glob、grep、bash、bash_output、monitor，各自在 `tools/` 下。路径按会话的工作目录解析；
 * write、edit、bash 标为 mutating，在 execute 里校验完参数、动手之前经 `run.ask` 问用户（问不问由宿主定）：
 * 写文件给 diff，命令给原文，能证明只读的命令不问；读工作区外的位置和密钥也经 `run.ask` 问。
 * bash 经本体的 `ToolRun.exec` 跑，沙箱档由本体按权限模式定；monitor 跑命令的那一套全用 bash 的，只是边跑边把新输出送给模型。
 */

import { bashOutputTool, bashTool } from "./tools/bash.ts";
import { editTool } from "./tools/edit.ts";
import { globTool } from "./tools/glob.ts";
import { grepTool } from "./tools/grep.ts";
import { lsTool } from "./tools/ls.ts";
import { monitorTool } from "./tools/monitor.ts";
import { readTool } from "./tools/read.ts";
import type { Tool } from "./tools/types.ts";
import { writeTool } from "./tools/write.ts";

export const TOOLS: Tool[] = [readTool, writeTool, editTool, lsTool, globTool, grepTool, bashTool, bashOutputTool, monitorTool] as Tool[];
