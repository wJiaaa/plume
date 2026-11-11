/** 界面上给人看的文字，两种界面语言写在一起；逻辑入口按 `ctx.locale()` 取，界面入口用 @plume/ui 的 useI18n() 取。 */

import type { Locale } from "@plume/contract";

/**
 * 系统废纸篓按这个平台的叫法：macOS 是废纸篓，Windows 和 Linux 桌面叫回收站（英文 Windows 是 Recycle Bin）。
 * 写成一个平台的叫法，另一个平台上的人会去找一个不存在的地方。逻辑入口里没有 navigator，那边不用这几句。
 */
const DESK = typeof navigator === "undefined" ? "mac" : /^Mac/i.test(navigator.platform) ? "mac" : /^Win/i.test(navigator.platform) ? "windows" : "other";
const BIN = { zh: DESK === "mac" ? "废纸篓" : "回收站", en: DESK === "windows" ? "the Recycle Bin" : "the Trash" };

/** 头几项，加引号；多了说一共几项。设置页给它一行，真实的技能能列十几个 `Bash(...)`。 */
function list(items: string[], more: (n: number) => string, separator: string): string {
	const shown = items
		.slice(0, 3)
		.map((item) => `\`${item}\``)
		.join(separator);
	return items.length > 3 ? `${shown}${more(items.length)}` : shown;
}
const zhList = (items: string[]) => list(items, (n) => ` 等 ${n} 项`, "、");
const enList = (items: string[]) => list(items, (n) => ` and ${n - 3} more`, ", ");

const zhCN = {
	settingsTitle: "技能",
	toolVerb: "使用技能",
	intro: "技能是一份做某类事的说明书。Agent 看到任务对得上时自己调用，也可以在输入框里敲 “/技能名” 点名用它。",
	whatIsIt: "一个技能是一个目录，里面的 SKILL.md 开头写名字和描述，正文写步骤。",
	personal: "个人",
	project: "项目",
	otherDirs: "其他目录",
	fromPlugins: "来自插件",
	bundleTag: (n: number) => `合集 · ${n}`,
	openPluginDetail: (name: string) => `查看 ${name} 的详情`,
	enableBundle: (name: string) => `启用 ${name} 带的技能`,
	collapse: "收起",
	show: "查看",
	openDir: "打开目录",
	projectSkill: "技能 · 项目",
	personalSkill: "技能 · 个人",
	pluginSkill: (plugin: string) => `技能 · ${plugin}`,
	pluginGroup: (plugin: string) => `插件「${plugin}」`,
	pluginSkillKept: "插件带来的技能随插件装卸，不想用就关掉它",
	openPersonalDir: "打开个人技能目录",
	openPersonalDirDetail: "放进去的技能下一轮就能用",
	emptyTitle: "还没有技能",
	manualOnly: "仅手动调用",
	disableAll: "全部关闭",
	enableAll: "全部开启",
	enableNamed: (name: string) => `启用 ${name}`,
	openNamed: (name: string) => `打开 ${name}`,
	deleteNamed: (name: string) => `删除技能 ${name}`,
	deleteConfirm: (name: string) => `删除技能「${name}」？`,
	deleteDetail: `整个技能目录会移到${BIN.zh}。`,
	deleteFailed: (reason: string) => `删除失败：${reason}`,
	toggleFailed: (reason: string) => `没能保存开关：${reason}`,
	readFailed: (reason: string) => `读取技能失败：${reason}`,
	delete: "删除",
	cancel: "取消",
	failedToLoad: (n: number) => `${n} 个技能没能加载`,
	warnings: (n: number) => `${n} 个技能需要留意：agent 可能在该用的时候想不到它，或者它限制的工具和你想的不一样`,
	problemLabel: {
		unclosed: "开头没闭合",
		invalidYaml: "开头写错了",
		noDescription: "缺少描述",
		longDescription: "描述太长",
		shortDescription: "描述太短",
		badName: "名字不合规矩",
		shadowed: "被同名遮住",
		allowedTools: "工具限制没按原意生效",
	},
	unclosed: "开头的 `---` 没有闭合，整个文件都被当成了正文。",
	invalidYaml: (detail: string) => `开头的 frontmatter 不是有效的 YAML：${detail}`,
	noDescription: "缺少 `description`：模型靠它决定什么时候用这个技能。",
	longDescription: "`description` 超过了 1024 个字符。",
	shortDescription: (length: string) => `\`description\` 只有 ${length} 个字符。模型靠它决定什么时候用这个技能，说清「做什么、什么情况下用」通常要 40 个以上。`,
	badName: (name: string) => `技能名只能是小写字母、数字和连字符；当前是“${name}”。`,
	shadowed: (winner: string) => `同名的技能已由 ${winner} 定义，这一个被遮蔽了。`,
	toolsNotList: (value: string) => `\`allowed-tools\` 要写成列表或字符串，这里是 \`${value}\`，已忽略：这个技能不限制工具。`,
	toolsStrays: (items: string[]) => `\`allowed-tools\` 里不是工具名的项已跳过：${zhList(items)}。`,
	toolsScoped: (widened: string[], items: string[]) => `\`allowed-tools\` 里括号中的范围在 Plume 不生效，${zhList(widened)} 按整个工具放行：${zhList(items)}。`,
	toolsUnmatched: (items: string[]) => `\`allowed-tools\` 里对应不到 Plume 工具的项不会放行任何调用：${zhList(items)}。`,
	toolsServerWide: (items: string[]) =>
		`\`allowed-tools\` 里指整个 MCP 服务的项不会放行任何调用，Plume 只认完整的工具名 \`mcp__<服务>__<工具>\`：${zhList(items)}。`,
	shadowedHeader: "被同名遮住的技能",
	shadowedBy: "被",
	shadowedBySuffix: "覆盖",
	showDiff: "看差异",
	hideDiff: "收起差异",
	useThat: "改用那个",
	nowUsing: "已改用",
	preferenceIn: "，偏好写在",
	readingBoth: "正在读两份文件…",
	identical: "两份内容一模一样——改用哪个都没有区别。",
	diffLegend: (added: number, removed: number) => `「+」是改用那份会多出来的：+${added} −${removed}`,
	preferFailed: (reason: string) => `没能改用：${reason}`,
	diffFailed: (reason: string) => `没能读出差异：${reason}`,
	notFound: (name: string) => `没有叫 /${name} 的技能了`,
	notALoadedSkill: "不是已经读到的技能",
};

export type Messages = typeof zhCN;

export const MESSAGES: Record<Locale, Messages> = {
	"zh-CN": zhCN,
	en: {
		settingsTitle: "Skills",
		toolVerb: "Used skill",
		intro: "A skill is a playbook for one kind of task. The agent uses it when a task matches, or you can name it by typing “/skill-name” in the composer.",
		whatIsIt: "A skill is a folder whose SKILL.md starts with a name and description, followed by the steps.",
		personal: "Personal",
		project: "Project",
		otherDirs: "Other folders",
		fromPlugins: "From plugins",
		bundleTag: (n) => `Pack · ${n}`,
		openPluginDetail: (name) => `See the details of ${name}`,
		enableBundle: (name) => `Enable the skills in ${name}`,
		collapse: "Hide",
		show: "Show",
		openDir: "Open folder",
		projectSkill: "Skill · Project",
		personalSkill: "Skill · Personal",
		pluginSkill: (plugin) => `Skill · ${plugin}`,
		pluginGroup: (plugin) => `Plugin “${plugin}”`,
		pluginSkillKept: "Skills from a plugin come and go with the plugin; turn it off if you don't want it",
		openPersonalDir: "Open personal skills folder",
		openPersonalDirDetail: "Skills put there work from the next turn",
		emptyTitle: "No skills yet",
		manualOnly: "Manual only",
		disableAll: "Turn all off",
		enableAll: "Turn all on",
		enableNamed: (name) => `Enable ${name}`,
		openNamed: (name) => `Open ${name}`,
		deleteNamed: (name) => `Delete skill ${name}`,
		deleteConfirm: (name) => `Delete skill “${name}”?`,
		deleteDetail: `The whole skill folder will be moved to ${BIN.en}.`,
		deleteFailed: (reason) => `Couldn't delete: ${reason}`,
		toggleFailed: (reason) => `Couldn't save the switch: ${reason}`,
		readFailed: (reason) => `Couldn't read skills: ${reason}`,
		delete: "Delete",
		cancel: "Cancel",
		failedToLoad: (n) => (n === 1 ? "1 skill failed to load" : `${n} skills failed to load`),
		warnings: (n) =>
			`${n === 1 ? "1 skill needs" : `${n} skills need`} attention: the agent may not think of it when it should, or the tools it limits are not what you meant`,
		problemLabel: {
			unclosed: "Header not closed",
			invalidYaml: "Header is invalid",
			noDescription: "No description",
			longDescription: "Description too long",
			shortDescription: "Description too short",
			badName: "Name not allowed",
			shadowed: "Shadowed",
			allowedTools: "Tool limits not applied as written",
		},
		unclosed: "The opening `---` is never closed, so the whole file is treated as body text.",
		invalidYaml: (detail) => `The frontmatter is not valid YAML: ${detail}`,
		noDescription: "`description` is required — it is how the model decides when to use this skill.",
		longDescription: "`description` exceeds 1024 characters.",
		shortDescription: (length) =>
			`\`description\` is only ${length} characters. The model decides when to use the skill from it; saying what it does and when usually takes 40 or more.`,
		badName: (name) => `Skill names may only use lowercase letters, digits and hyphens; got “${name}”.`,
		shadowed: (winner) => `A skill with the same name is already defined by ${winner}, so this one is shadowed.`,
		toolsNotList: (value) => `\`allowed-tools\` must be a list or a string; got \`${value}\`, so it is ignored and this skill does not restrict tools.`,
		toolsStrays: (items) => `Entries in \`allowed-tools\` that are not tool names were skipped: ${enList(items)}.`,
		toolsScoped: (widened, items) =>
			`Scopes in parentheses in \`allowed-tools\` have no effect in Plume, so ${enList(widened)} is allowed as a whole: ${enList(items)}.`,
		toolsUnmatched: (items) => `Entries in \`allowed-tools\` that match no Plume tool allow no calls: ${enList(items)}.`,
		toolsServerWide: (items) =>
			`Entries in \`allowed-tools\` naming a whole MCP server allow no calls; Plume only matches full tool names \`mcp__<server>__<tool>\`: ${enList(items)}.`,
		shadowedHeader: "Skills shadowed by one of the same name",
		shadowedBy: "is shadowed by",
		shadowedBySuffix: "",
		showDiff: "See the difference",
		hideDiff: "Hide the difference",
		useThat: "Use that one instead",
		nowUsing: "Now using",
		preferenceIn: " — the preference is written in",
		readingBoth: "Reading both files…",
		identical: "The two are identical — it makes no difference which one wins.",
		diffLegend: (added, removed) => `“+” is what switching would add: +${added} −${removed}`,
		preferFailed: (reason) => `Couldn't switch: ${reason}`,
		diffFailed: (reason) => `Couldn't read the difference: ${reason}`,
		notFound: (name) => `There is no longer a skill called /${name}`,
		notALoadedSkill: "Not a skill that was loaded",
	},
};
