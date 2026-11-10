/**
 * plume.status 的逻辑入口。插件只在输入框工具栏画读数（见 ui.tsx），数都从会话里现成的用量来，
 * agent 进程这边没有要做的事；逻辑入口是插件必需的，留一个空的。
 */

import type { Plugin } from "@plume/contract";

export default {
	name: "plume.status",
	apply() {},
} satisfies Plugin;
