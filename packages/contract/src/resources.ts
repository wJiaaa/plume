/**
 * 资源地址：`scheme://路径`，模型在 read（和 ls）里像文件路径一样用它读技能正文、会话转录、插件说明、被折叠的大输出。
 *
 * 一个命名空间一个工具的话，每多一类可读的东西就多一个工具、一份参数、一段提示词；这些其实都是「从某个命名空间读一样东西」，
 * 所以模型只学一次 `read`，能读的东西随地址变多，工具表不变。
 *
 * 由内置插件 plume.tools 提供服务 `resources`：它自己有 `scratch://`（会话的临时目录，唯一可写的）、`artifact://`、
 * `session://`、`plugin://`，别的插件经 `register` 加自己的 scheme（技能插件的 `skill://`）。
 */

/** 拆开的地址。 */
export interface ResourceAddress {
	/** 小写。 */
	scheme: string;
	/** `<scheme>://` 后面的全部，去掉了末尾的行范围。 */
	path: string;
	/** `path` 按 `/` 拆开，去掉空段。 */
	segments: string[];
	/** 末尾的 `:10-40` 或 `:7`，要的是这几行；切行由服务做，scheme 不用管。 */
	range?: { from: number; to?: number };
	/** 原样的地址，报错和结果头用。 */
	raw: string;
}

/** 读到的东西。 */
export interface Resource {
	url: string;
	content: string;
	contentType: string;
	/**
	 * 一句话说这是什么、是不是全部（「技能“pdf”的完整正文」）。光给一段字，模型分不出是全部还是一部分，会接着去磁盘上找剩下的。
	 */
	label?: string;
	/**
	 * 内容不是这个项目、这个应用写的（第三方插件的说明、另一次会话的转录、命令的原始输出）时写明来路：read 把它包进
	 * `<resource origin="…">`，系统提示词说那里面的是数据、不是指令。
	 */
	origin?: string;
	/** 放进工具结果 `details` 的附加信息。 */
	meta?: Record<string, unknown>;
}

/** `read <scheme>://` 列出的一项。 */
export interface ResourceEntry {
	value: string;
	description?: string;
}

/** 解析地址时这次调用的环境。 */
export interface ResourceScope {
	sessionId: string;
	cwd: string;
	/** 这个会话的临时目录，见 `ModelContext.scratchDir`。 */
	scratchDir: string;
	signal?: AbortSignal;
}

/** 一个 scheme。只读：唯一可写的是服务自己的 `scratch://`，模型写不了它该遵守的技能正文。 */
export interface ResourceHandler {
	/** 小写字母开头，字母、数字、连字符。 */
	scheme: string;
	/** 系统提示词「Addresses」里这个 scheme 的那一行：有哪几种写法、各是什么。 */
	describe: string;
	/** 读一个地址。没有这样东西、越界时抛错，错误信息直接交给模型。路径为空（`scheme://`）的不走这里，走 `list`。 */
	resolve(address: ResourceAddress, scope: ResourceScope): Promise<Resource>;
	/** `read <scheme>://` 列出的东西；不给就是不能列。 */
	list?(scope: ResourceScope): Promise<ResourceEntry[]>;
	/** 这个地址在磁盘上指的目录或文件（ls 用它列目录）；不给、或返回 null 时 ls 不认这个地址。越界时抛错。 */
	locate?(address: ResourceAddress, scope: ResourceScope): Promise<string | null>;
}

/** 服务 `resources`：资源地址，见本文件开头。 */
export interface ResourcesService {
	/** 加一个 scheme，返回撤下它的函数（停用时用 `ctx.effect` 撤）。scheme 已被占用、写法不对时抛错。 */
	register(handler: ResourceHandler): () => void;
	/**
	 * 把一大块原文（被剪掉的工具结果）存起来，换回 `artifact://<id>` 地址，模型要时用 read 按窗口取回。
	 * 地址按 `tool` 和内容算：同一段原文每次换回同一个地址，从历史重建出的占位标记逐字不变。
	 * 按会话存在内存里，每个会话最多留 30 份、超了丢最旧的；重开应用、会话删掉后就没有了。
	 */
	keepArtifact(sessionId: string, tool: string, content: string): string;
}
