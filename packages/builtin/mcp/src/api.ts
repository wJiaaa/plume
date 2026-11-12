/** 逻辑入口经 `ctx.serve` 开给设置页和表单卡的接口，两个入口共用。 */

import type { ServerDraft, VarDraft } from "./config.ts";
import type { ServerStatus } from "./connections.ts";
import type { CallContext } from "@plume/contract";

export type { ServerDraft, VarDraft };

/** 一个环境变量或请求头。像密钥的不给值，只说填没填。 */
export interface VarView {
	name: string;
	/** 不像密钥的才有。 */
	value?: string;
	secret: boolean;
	/** 像密钥的那些填了没有。 */
	filled: boolean;
	/** 可选的空位（`${NAME:-默认值}`）：不填也能启动。 */
	optional?: boolean;
}

export interface ServerView {
	id: string;
	name: string;
	transport: "stdio" | "http" | "sse";
	command?: string;
	args?: string[];
	url?: string;
	/** stdio 是环境变量，http、sse 是请求头。 */
	vars: VarView[];
	enabled: boolean;
	trustReadOnly: boolean;
	pinned: boolean;
	perSession: boolean;
	/** Magpie 资源库分发的：名字、开关、启动方式、变量和删除都在 Magpie 里改，这里只看状态、重连、登录。 */
	managed: boolean;
	/** 插件带来的：带来它的插件的显示名。能开关、填空位的值，启动方式改不了、删不掉，卸载插件就没了。 */
	plugin?: string;
	/**
	 * 人填的 `${NAME}` 空位值：远程服务的是存着的那些（stdio 的就是 `vars`）；插件带来的是声明里的每个空位，
	 * 填没填、可不可选都列出来，随时能改（启动方式锁着，只有这里能动）。
	 */
	values: VarView[];
	/** 用 OAuth 登录（远程服务，请求头里没写 `Authorization`）。 */
	oauth: boolean;
	/** 用 OAuth 的，现在有令牌。 */
	signedIn: boolean;
	status: ServerStatus;
}

export interface McpView {
	servers: ServerView[];
	/** 配置文件的路径，给人看。 */
	file: string;
	/** 配置文件读不懂时的原因；这时列表是空的，改动会被拒绝，免得把写坏了的那份冲掉。 */
	error?: string;
}

export interface McpApi {
	readDocument(session: string, id: string, call: CallContext): AsyncGenerator<Uint8Array, void>;
	list(): Promise<McpView>;
	/** `id` 为 null 是新建。名字重复、命令或地址不对时报错（给人看的话）。 */
	save(id: string | null, draft: ServerDraft): Promise<McpView>;
	remove(id: string): Promise<McpView>;
	setEnabled(id: string, enabled: boolean): Promise<McpView>;
	/** 关掉、立刻重连，等到有结果（连上或失败）才返回。 */
	reconnect(id: string): Promise<McpView>;
	/** 填 `${NAME}` 空位的值；值是空的就是清掉。 */
	fill(id: string, values: { name: string; value: string }[]): Promise<McpView>;
	/** 在浏览器里登录，等人授权完（最多五分钟）才返回。 */
	login(id: string): Promise<McpView>;
	logout(id: string): Promise<McpView>;
}
