/**
 * 每条风险规则的代码，和它在两种界面语言里的说法。
 *
 * 规则命中时只报代码（和句子要用的值），不报句子：审批卡要按界面语言说，同一个判断在中文窗口和英文窗口里得是两句话。
 * 句子由 `riskText` 按 `ctx.locale()` 取。中文是源语言，英文 `satisfies` 它，漏一条是类型错误。
 *
 * `{name}` 是句子要填的值，随判断的 `params` 一起给。
 */

import type { Locale } from "@plume/contract";

const zhCN = {
	// 命令。
	"recursive-delete": "递归删除目录",
	"download-and-run": "下载并直接执行脚本",
	"run-as-admin": "以管理员身份执行",
	"force-delete-glob": "强制删除通配匹配的文件",
	"delete-root-or-home": "删除根目录或主目录",
	"force-push": "强制推送会覆盖远程历史",
	"hard-reset": "丢弃所有未提交的改动",
	"secret-file": "读写本机密钥文件",
	"write-system-path": "写入项目之外的系统路径",
	"shell-startup": "修改 shell 启动文件",
	"upload-file": "把本机文件上传到网络",
	"launch-program": "启动其他程序，它不受沙箱约束",

	// 不管参数是什么都危险的程序：`NEVER_UNATTENDED`。
	"switch-user": "切换用户",
	shutdown: "关机或重启",
	"format-disk": "格式化磁盘",
	"partition-disk": "修改磁盘分区",
	"modify-disk": "修改磁盘",
	"raw-disk-write": "按块写设备，可能覆盖磁盘",
	shred: "不可恢复地擦除文件",
	"change-owner": "更改文件归属",
	"system-service": "改动系统服务",
	crontab: "改动定时任务",
	"kill-all": "批量结束进程",
	"clear-disk": "清空磁盘",
	"execution-policy": "改动系统的脚本执行策略",
	"boot-config": "改动系统启动配置",
	"shadow-copies": "改动系统卷影副本",
	"event-log": "改动系统事件日志",
	"wipe-data": "可能不可恢复地擦除数据",

	// 丢掉工作、或者伸到这台机器之外的子命令：`RISKY_SUBCOMMANDS` 和 git 的参数规则。
	"discard-changes": "可能丢弃未提交的改动",
	"delete-untracked": "删除未跟踪的文件",
	"rewrite-history": "重写提交历史",
	"delete-branch": "删除分支，只在它上面的提交会丢失",
	"overwrite-changes": "可能覆盖未提交的改动",
	"publish-package": "发布到公共仓库",
	"docker-prune": "可能清理镜像与卷",
	"delete-cluster-resource": "删除集群资源",
	"registry-edit": "修改注册表",
	"scheduled-task": "改动计划任务",
	firewall: "改动防火墙配置",

	// 写文件：`assessWrite`。
	"write-sensitive-path": "写入项目之外的敏感路径",
	"write-outside-project": "写入当前项目之外的位置",
};

export type RiskCode = keyof typeof zhCN;

/** 规则的句子要填的值。 */
export type RiskParams = Readonly<Record<string, string>>;

export const RISK_TEXT: Record<Locale, Record<RiskCode, string>> = {
	"zh-CN": zhCN,
	en: {
		"recursive-delete": "Deletes a folder and everything in it",
		"download-and-run": "Downloads a script and runs it straight away",
		"run-as-admin": "Runs with administrator rights",
		"force-delete-glob": "Force-deletes every file the wildcard matches",
		"delete-root-or-home": "Deletes the root or home folder",
		"force-push": "A force push overwrites the remote history",
		"hard-reset": "Discards all uncommitted changes",
		"secret-file": "Reads or writes a key file on this computer",
		"write-system-path": "Writes to a system location outside the project",
		"shell-startup": "Changes a shell startup file",
		"upload-file": "Uploads a file from this computer over the network",
		"launch-program": "Starts another program, which the sandbox does not contain",
		"switch-user": "Switches to another user",
		shutdown: "Shuts down or restarts the computer",
		"format-disk": "Formats a disk",
		"partition-disk": "Changes disk partitions",
		"modify-disk": "Makes changes to a disk",
		"raw-disk-write": "Writes raw blocks to a device, which can overwrite a disk",
		shred: "Erases files beyond recovery",
		"change-owner": "Changes who owns files",
		"system-service": "Changes system services",
		crontab: "Changes cron jobs",
		"kill-all": "Ends processes in bulk",
		"clear-disk": "Wipes a disk",
		"execution-policy": "Changes the system's script execution policy",
		"boot-config": "Changes how the system boots",
		"shadow-copies": "Changes the system's volume shadow copies",
		"event-log": "Changes the system event logs",
		"wipe-data": "May erase data beyond recovery",
		"discard-changes": "May discard uncommitted changes",
		"delete-untracked": "Deletes untracked files",
		"rewrite-history": "Rewrites commit history",
		"delete-branch": "Deletes a branch; commits only on it are lost",
		"overwrite-changes": "May overwrite uncommitted changes",
		"publish-package": "Publishes to a public registry",
		"docker-prune": "May remove images and volumes",
		"delete-cluster-resource": "Deletes cluster resources",
		"registry-edit": "Changes the Windows registry",
		"scheduled-task": "Changes scheduled tasks",
		firewall: "Changes the firewall configuration",
		"write-sensitive-path": "Writes to a sensitive location outside the project",
		"write-outside-project": "Writes outside the current project",
	} satisfies Record<RiskCode, string>,
};

/** 一条规则在这种界面语言里的句子，值填好。 */
export function riskText(code: RiskCode, params: RiskParams | undefined, locale: Locale): string {
	const sentence = RISK_TEXT[locale][code];
	if (!params) return sentence;
	return sentence.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}
