/**
 * 什么算危险，写成数据。
 *
 * 和判断的逻辑分开放，是为了这几张表能单独读、单独争：它们决定了审批卡是在该弹的时候弹，还是弹到人学会不看就点。
 *
 * 每一项都是收不回来的事。写文件不在表上：写就是 agent 的活。
 *
 * 表里只写规则的代码；每条在各种语言里怎么说不在这里定，见 `messages.ts`。
 */

import type { RiskCode } from "./messages.ts";

/** 不管参数是什么都危险的程序。 */
export const NEVER_UNATTENDED = new Map<string, RiskCode>([
	["sudo", "run-as-admin"],
	["doas", "run-as-admin"],
	["su", "switch-user"],
	["shutdown", "shutdown"],
	["reboot", "shutdown"],
	["halt", "shutdown"],
	["mkfs", "format-disk"],
	["fdisk", "partition-disk"],
	["diskutil", "modify-disk"],
	["dd", "raw-disk-write"],
	["shred", "shred"],
	["chown", "change-owner"],
	["launchctl", "system-service"],
	["systemctl", "system-service"],
	["crontab", "crontab"],
	["killall", "kill-all"],
	/*
	 * Windows 上同一类事的写法，按小写登记：PowerShell 和 cmd 不分大小写，查表也不分。PowerShell 在 macOS、Linux 上
	 * 也装得上，命令照样能经它跑到；不登记的话 `Format-Volume` 和 `ls` 一样无害。
	 */
	["format", "format-disk"],
	["format-volume", "format-disk"],
	["diskpart", "partition-disk"],
	["clear-disk", "clear-disk"],
	["initialize-disk", "partition-disk"],
	["remove-partition", "partition-disk"],
	["stop-computer", "shutdown"],
	["restart-computer", "shutdown"],
	["set-executionpolicy", "execution-policy"],
	["takeown", "change-owner"],
	["bcdedit", "boot-config"],
	["vssadmin", "shadow-copies"],
	["wevtutil", "event-log"],
	["cipher", "wipe-data"],
]);

/** 丢掉工作、或者改写共享历史的子命令。 */
export const RISKY_SUBCOMMANDS = new Map<string, Map<string, RiskCode>>([
	/*
	 * 只放名字本身就是危险的那两个。`reset`、`clean`、`checkout`、`push` 这些危险在参数上，`risk-git.ts` 读参数；
	 * 放在这里会让 `git reset HEAD file`、`git clean -n` 也来问。
	 */
	[
		"git",
		new Map<string, RiskCode>([
			["rebase", "rewrite-history"],
			["filter-branch", "rewrite-history"],
		]),
	],
	["npm", new Map<string, RiskCode>([["publish", "publish-package"]])],
	["pnpm", new Map<string, RiskCode>([["publish", "publish-package"]])],
	["yarn", new Map<string, RiskCode>([["publish", "publish-package"]])],
	["docker", new Map<string, RiskCode>([["system", "docker-prune"]])],
	["kubectl", new Map<string, RiskCode>([["delete", "delete-cluster-resource"]])],
	// Windows：注册表、计划任务、服务和防火墙，按第一个参数认。
	[
		"reg",
		new Map<string, RiskCode>([
			["delete", "registry-edit"],
			["add", "registry-edit"],
			["import", "registry-edit"],
			["restore", "registry-edit"],
		]),
	],
	[
		"schtasks",
		new Map<string, RiskCode>([
			["/create", "scheduled-task"],
			["/delete", "scheduled-task"],
			["/change", "scheduled-task"],
		]),
	],
	[
		"sc",
		new Map<string, RiskCode>([
			["delete", "system-service"],
			["create", "system-service"],
			["config", "system-service"],
		]),
	],
	[
		"netsh",
		new Map<string, RiskCode>([
			["advfirewall", "firewall"],
			["firewall", "firewall"],
		]),
	],
]);

/**
 * 绝不会是项目的路径，写到那里按定义就出了范围。Windows 的系统目录两种写法都认：`C:\Windows`，和 Git Bash 里的 `/c/Windows`。
 * 引号写成 `\x27\x22`，原因同下面的 `SECRET_PATH`。
 */
export const PROTECTED_PATH =
	/(^|\s|[\x27\x22])(\/(bin|sbin|usr|etc|var|System|Library|Applications)\b|~\/\.(ssh|aws|gnupg|config\/gh)\b|[A-Za-z]:[\\/](Windows|Program Files|ProgramData)\b|\/[a-z]\/(Windows|Program Files|ProgramData)\b)/i;

/**
 * 把文件放到某处的程序，和 shell 重定向相对。
 *
 * 只在命令里有 `>` 时才查 `PROTECTED_PATH` 的话，管得了 `echo x > /etc/hosts`，管不了 `cp payload /etc/hosts`、
 * `mv x /usr/local/bin/`、`tee /etc/hosts`、`ln -sf x /usr/bin/git`：效果一样，只是没用重定向。
 */
export const PLACES_FILES = new Set([
	"cp",
	"mv",
	"tee",
	"install",
	"ln",
	"rsync",
	"truncate",
	"chmod",
	"chflags",
	"xattr",
	"touch",
	"unzip",
	"tar",
	// PowerShell 和 cmd 的，按小写登记，查表时也按小写查。
	"copy",
	"xcopy",
	"robocopy",
	"move",
	"copy-item",
	"move-item",
	"new-item",
	"set-content",
	"add-content",
	"out-file",
	"rename-item",
]);

/**
 * 是某样东西的钥匙的文件，从哪里读都算。
 *
 * 写的一侧 `PROTECTED_PATH` 管着（它包括 `~/.ssh`），读的一侧以前没人管，而对凭据来说要紧的正是读：钥匙不会被读坏，
 * 读了就是交出去了。Plume 的供应商 key 加密存在 `~/.plume/credentials.json`，钥匙就在旁边的 `vault.key`，读走这两个就是拿走了全部 key；模型设置
 * `~/.plume/settings.json` 里还明文写着 Magpie 网关的 key；插件的密钥由 plume.secrets 加密，钥匙是 `~/.plume/plugin-data/plume.secrets/vault.key`
（插件数据目录下别的 `vault.key` 也算：自己加密的第三方插件多半这样叫）。所以单独点名这几个；`~/.plume` 里别的
 * （会话等）不算，规则宽到包住它们会让 agent 连自己的配置都读不了。
 *
 * 两边的边界是命令行里任何能结束一个词的字符，不只是分隔符或字符串结尾：这条既拿来匹配单个路径，也拿来匹配整条命令，
 * 只认 `[/\\]|$` 的话，路径后面跟了任何东西的命令都会放过去（`scp ~/.ssh/id_ed25519 host:`）；前面也不要求分隔符，
 * 否则在家目录里跑的 `cat .ssh/id_rsa` 就漏了。`.` 不结束词：`id_rsa.pub` 是公钥。
 * 引号写成 `\x27\x22\x60`：直接写的话，文案检查会把它当成字符串的开头。
 */
export const SECRET_PATH =
	/(?:^|[/\\\s\x27\x22\x60=@:<>(|;&])(?:\.(?:plume[/\\](?:settings\.json|credentials\.json|(?:plugin-data[/\\][^/\\\s]+[/\\])?vault\.key)|ssh[/\\]id_[A-Za-z0-9_]+|aws[/\\]credentials|gnupg\b|netrc|config[/\\]gh[/\\]hosts\.yml))(?=$|[/\\\s\x27\x22\x60;&|<>)])/i;

/**
 * shell：给它什么字符串就跑什么。
 *
 * 单独起个名字，是因为两条规则要同一份：「`bash -c` 跑的是什么」，和「`curl … |` 的另一头是什么」。
 * PowerShell 在 macOS、Linux 上也装得上，把下载的东西交给它照样是下载并执行。
 */
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "powershell", "pwsh", "cmd"]);

/** 拿到代码就跑的程序，给「管道喂给解释器」那条规则用。 */
export const INTERPRETERS = new Set([
	...SHELLS,
	"python",
	"python2",
	"python3",
	"perl",
	"ruby",
	"node",
	"deno",
	"bun",
	"php",
	"osascript",
	"Rscript",
	"lua",
	"awk",
	"tclsh",
	// PowerShell 自己的：`irm url | iex` 把下载的东西交给的就是它。
	"iex",
	"invoke-expression",
]);

/** 从网络取东西的程序，给同一条规则用；后几个是 PowerShell 的 `curl`、`wget`，按小写登记。 */
export const FETCHERS = new Set(["curl", "wget", "fetch", "invoke-webrequest", "iwr", "invoke-restmethod", "irm"]);

/**
 * 去掉自己的选项以后，参数就是另一条命令的程序。
 *
 * 不认它们的话，每一个都是把命令藏到没人看的地方的办法：`env rm -rf ~` 的第一个词是 `env`，`xargs rm -rf` 的是 `xargs`，哪张表上都没有。
 */
export const COMMAND_PREFIXES = new Set(["env", "nohup", "time", "nice", "ionice", "stdbuf", "setsid", "timeout", "command", "exec", "xargs", "watch"]);
