# 更新日志

这个文件由 `pnpm release` 生成，条目来自提交信息。写得含糊的提交在这里也含糊，所以值得在提交时就写清楚。

## [0.1.8] - 2026-11-12

<!-- plume:notes en -->
### Changes

- **Side chat, sub-agents and plan mode are built in.** You no longer install them from the Marketplace: they come with Plume, are always there and update with the app. If you installed them before, the built-in ones are used. Plan mode's limits (no file changes before you approve, commands in a read-only sandbox) no longer vanish when a plugin update fails to load.
- **Attached files reach the agent with their location.** Files you drag in or choose are sent with their path on disk, so the agent can change the original file instead of searching the workspace for it by name or pasting the edited part back to you. Pasted screenshots have no path and are sent as before.
- **Plugin updates wait until Plume is idle.** Automatic updates are applied once no conversation is running, so they no longer stop a running sub-agent or briefly lift the checks of plan mode or hook plugins. Clicking "Update" in the Marketplace still updates right away.
- A Marketplace plugin that hangs while loading no longer keeps conversations from starting: after 15 seconds it is marked as failed. Turning a failed plugin on tries again, and turning it off works.
- Fewer full re-reads of a conversation by the model, which cost time and money: installing or removing a plugin no longer resets the cache of conversations that are running, and speaking again after a conversation was compacted no longer moves the date note and re-reads everything after the summary.
- In a conversation's hover card, usage by sub-conversations is listed per plugin, under the plugin's name. A task a side chat hands to its main conversation is marked with the name of the plugin it came from.
- Skin Studio's "Follow system", "Light" and "Dark" are now the same as the three theme cards in Settings › Appearance: your colors and window material stay as they are. This needs Skin Studio 0.3.0 from the Marketplace.

### For plugin authors

- `plume.side-chat`, `plume.subagents` and `plume.plan` are built-in plugins and have left the Marketplace.
- `ModelContext` carries `parentId` and `owner`, the same as on `SessionSummary`, so a `model.context` hook can tell sub-conversations and plugin-owned conversations apart without listing every session.
- `ui.useTheme()` reads the app's theme preference and `ui.setTheme(theme)` changes it, as if the person clicked that card in Settings › Appearance. While a skin controls light and dark, the setting is read-only and `setTheme` does nothing.
- `QueuedMessage.origin` is `"child"` instead of `"side-chat"` and `sideId` is now `childId`; `UserMessage.origin` is `"child" | "parent"`. A task handed over by a sub-conversation carries `UserMessage.fromPlugin`, the plugin that owns it.
- A Marketplace plugin's `apply` must return within 15 seconds; otherwise it counts as failed and later registrations from it are ignored.
- The tool list sent to the model is fixed for a turn: tools a plugin adds mid-turn appear from the next turn, and a tool removed mid-turn stays listed until the turn ends (calling it returns an error).

<!-- plume:notes zh-CN -->
### 改动

- **侧边聊天、子智能体、计划模式随应用自带。** 不用再去插件市场装：它们随 Plume 一起提供、一直都在，跟着应用更新。以前装过的，用的是自带的这份。插件更新加载失败时，计划模式的限制（你批准之前不改文件、命令只在只读沙箱里跑）不会再悄悄没了。
- **附件带着位置交给 agent。** 拖进来或选择的文件，发出去时带上它在磁盘上的路径，agent 可以直接改原文件，不用再按名字去工作区里找、找不到就把改好的那段贴回给你。粘贴的截图没有路径，照旧。
- **插件等闲下来再更新。** 自动更新等所有对话都停下来才换，不会再打断正在跑的子智能体，也不会让计划模式、钩子插件的拦截短暂失效。在插件市场里点「更新」仍然当场更新。
- 市场插件加载时卡住，不再让对话起不来：15 秒后算它加载失败。加载失败的插件重新启用会再试一次，停用也停得掉。
- 模型重读整段对话的次数少了，省时间也省钱：装上或卸下插件，不再让正在跑的对话的缓存作废；对话压缩过之后再开口，日期提示不再挪位置、把摘要之后的内容整段重读一遍。
- 会话悬停卡里，子会话的用量按插件分开列，标的是插件的名字；侧边聊天交给主对话的任务，标着它来自哪个插件。
- 换肤工坊的「跟随系统」「浅色」「深色」，就是设置 › 外观里的那三张主题卡片，你调过的配色和窗口材质原样保留。要用插件市场里的换肤工坊 0.3.0。

### 给插件作者

- `plume.side-chat`、`plume.subagents`、`plume.plan` 改成内置插件，插件市场里不再列它们。
- `ModelContext` 带上 `parentId`、`owner`，和 `SessionSummary` 上的同名字段一样；`model.context` 钩子分辨子会话、插件自己的会话，不用再列一遍全部会话。
- 新增 `ui.useTheme()` 读应用的主题偏好，`ui.setTheme(theme)` 改它，等同人在设置 › 外观里点那张卡片。皮肤接管了深浅模式时，这个设置是只读的，`setTheme` 不起作用。
- `QueuedMessage.origin` 从 `"side-chat"` 改成 `"child"`，`sideId` 改名 `childId`；`UserMessage.origin` 是 `"child" | "parent"`。子会话交过来的任务带着 `UserMessage.fromPlugin`，是它所属的插件。
- 市场插件的 `apply` 要在 15 秒内返回，否则算加载失败，之后它再注册的东西都不算数。
- 发给模型的工具表在一轮之内不变：一轮中途插件新加的工具从下一轮起出现，中途卸下的工具留在表里直到这一轮结束（调用它会返回错误）。

## [0.1.7] - 2026-11-11

<!-- plume:notes en -->
### Changes

- **A new welcome page.** It greets you by the time of day on your computer, and the line below asks what you want to build in a project, or what you'd like to talk about outside one. The suggestions sit under the message box. A plugin can replace that line: install 每日一句 (Daily Line) from the Marketplace to get a new line written by your default model each day.
- **Replies survive a crash.** If Plume quits while a reply is being written, reopening the conversation offers "Continue" at the end. A reply recovered after a dropped connection no longer contains text from the failed attempt.
- **Long conversations stream more smoothly.** While a reply streams, the sidebar, title bar and panels no longer redraw on every update, tool results redraw only their own rows, and the question navigator no longer re-measures the whole conversation.
- When the main conversation and a side chat stream at the same time, the end of a reply no longer appears all at once.
- Opening a conversation while it is replying no longer shows messages twice.
- Undo and edit-and-resend always cut at the message you chose, even when the list on screen is out of step with the saved conversation.
- When you regenerate or edit and resend, the message being asked again no longer disappears and comes back, and re-asking the first message no longer flashes the welcome page.
- After you press Stop, "Paused" appears where the running line was instead of sliding up from below.
- A conversation with a record that can't be read no longer shows the same error over and over, and the question navigator and tool results no longer go blank because of it.
- New text in replies with Windows (CRLF) line endings fades in at the right place.
- In the built-in browser, the agent can click list rows, cards and similar elements that ignored its clicks before: the cursor moves there and a real mouse click is sent.
- Middle-click a tab in the panel area to close it.
- In Settings › Models, hover a model name to see its full model id.
- Settings › Commands, Web Search and Worktrees introduce themselves the same way as Agents. The Commands page no longer has a search box.

### For plugin authors

- `ui.welcomeLine(line)` replaces the line under the welcome page greeting. It is called with the interface locale and returns `{ text, source? }`. Only the last plugin to register it is used; returning nothing, an empty string or throwing shows the default line.

<!-- plume:notes zh-CN -->
### 改动

- **新的欢迎页。** 按本机时间跟你打招呼，下面一行问你想在项目里开发什么，不在项目里时问想聊点什么；几个建议放到了输入框下面。这一行插件可以换掉：到插件市场装上「每日一句」，每天由默认模型写一句新的。
- **应用意外退出，回复不会白写。** 回复写到一半 Plume 退出了，重新打开会话，末尾有「继续」。断线重试后恢复出来的回复，不再混进上一次没成功的那段字。
- **长对话输出更顺。** 回复往外写时，侧栏、标题栏和面板不再每一拍跟着重画；工具结果回来只重画那几行；问题导航不再一遍遍量整个对话。
- 主对话和侧边聊天同时在写时，回复最后那段字不再一下子全蹦出来。
- 打开正在回复的会话，消息不再重复出现。
- 撤回、编辑重发总在你选的那一条截断，屏幕上的列表和存下的会话一时对不上也不会截错。
- 重新生成、编辑重发时，被重问的那句不再先消失再回来；重问第一句不再闪回欢迎页。
- 按停之后，「已暂停」直接出现在原来运行那一行的位置，不再从下面滑上来。
- 会话里有读不出的记录时，不再一遍遍弹同一条报错，问题导航和工具结果也不再因此白屏。
- 用 Windows（CRLF）换行的回复，新字淡入的位置对了。
- 内置浏览器里，以前 agent 点了没反应的列表行、卡片这类元素，现在能点中了：光标移过去，发的是真实的鼠标点击。
- 面板区的标签可以用鼠标中键关掉。
- 设置 › 模型 里，把指针停在模型名上能看到完整的模型 id。
- 设置里「命令」「网页搜索」「工作树」几页的介绍和「智能体」页一个样式，「命令」页去掉了搜索框。

### 给插件作者

- 新增 `ui.welcomeLine(line)`，换掉欢迎页问候下面那一行。宿主按界面语言调用它，返回 `{ text, source? }`；只用最后注册的那一个，返回空、空串或抛错时显示默认那一句。

## [0.1.6] - 2026-11-11

<!-- plume:notes en -->
### Changes

- **The browser is built in.** You no longer install it from the Marketplace: it comes with Plume and is always there. When the agent opens a page it now waits for the content to appear before reading, so it no longer reads a half-loaded page, and it reads long pages in parts instead of stopping at the first screen. Pressing Enter in the address bar no longer flashes a blank page first, and a spinner shows while a page loads.
- **Use your Chrome sign-ins in Plume (macOS).** Turn on Settings › Browser › "Sync sign-ins from Chrome" and pages in Plume, including the ones the agent opens, are signed in as you are in Chrome, and stay in sync with it. It is off by default. macOS will then ask to read the keychain: choose "Allow". If it says Plume can't read Chrome's data, give Plume Full Disk Access in System Settings › Privacy & Security.
- **Sign-in windows work.** "Sign in with …" and payment windows that a site opens now open next to Plume and finish signing you in on the page that opened them. Before, they didn't open at all. Links that open in a new tab now open in a background tab.
- **The agent asks you to sign in or solve a captcha.** When a page needs a password or a human check (reCAPTCHA, Cloudflare and the like), the agent stops and asks you to do it, instead of trying to get past it on its own.
- Pages you signed in to in the built-in browser need signing in again once: pages were being stored together with Plume's own data instead of in the browser's own storage. Sites also can no longer use your camera or location.
- **Grain texture.** Appearance › Chat background › Texture can add a fine grain to the whole window, with or without a background image.
- **Copy and Save As work again in the image viewer.** For almost every screenshot in a conversation, Copy did nothing and Save As said the export failed.
- **Notifications** sit in the middle of the window even when the sidebar is open, and their close button is always shown on the right instead of appearing only on hover.
- Saving settings no longer fails silently: you're told when a setting couldn't be saved, and closing the model editor waits for it to save. The code font can be reset to default.
- Dragging a conversation in the sidebar switches only that project to manual order, not all of them.
- A queued message that fails to send goes back into the message box instead of disappearing.
- Approval treats command names regardless of case, so `Rscript` is judged as risky as `rscript`.
- The Git panel no longer runs programs a repository brings along (hooks, filters, fsmonitor) when it reads the repository's status.
- The web search API key is stored encrypted.
- Call traces recorded before this version still list, but their request details no longer open.
- If Plume doesn't open after updating to this version, download the installer from this page and drag Plume into Applications. Restart Now is fixed in this version, so later updates won't leave Plume broken.

### For plugin authors

- `plume.browser` is a built-in plugin and has left the Marketplace. A `popup` page event carries `window: true` when the host has opened a sign-in window itself; the plugin doesn't need to open it and can't drive it. `ctx.pages.chromeLogins("status" | "on" | "off")` reads and switches the Chrome sign-in sync; turning it on always asks the person in a system dialog.
- Skins can set `root-image` (a CSS image, `none` by default) to paint a gradient around the window.
- `PLUME_PLUGIN_PATHS` is gone. Load your own plugins with `plume-plugin dev` or `plume-plugin install`.
- `ModelContext.systemPrompt` is read-only; change the prompt through `sections`. `CompactSummary.head` is required. A `step.end` hook that returns a verdict the host doesn't know is now an error instead of "continue".
- A skill's `allowed-tools` no longer narrows the tools. `web_fetch` takes `format: "text" | "raw"`.
- Unused props and exports were removed from `@plume/ui`: `AgentAvatar.badge`, `RetainedViews.slide` and `pageClassName`, `ActionSpinner.onFill`, `Overlay.align`, `CountUp.bidirectional` and `ms`, `TextArea.fieldRef`, `ClosableTab.labelClassName`, `DiffView`, `diffLines`, `TypedText`, `AvatarStack`, `GitHubMark`, `RowDeleteButton`.

<!-- plume:notes zh-CN -->
### 改动

- **浏览器内置了。** 不用再去插件市场装，随 Plume 一起装好、一直都在。agent 打开网页后等内容出来再读，不再读到加载了一半的页面；长页面能接着往下读，不再只看第一屏。地址栏回车后不再先闪一下空白，加载时有转圈。
- **在 Plume 里用 Chrome 的登录状态（macOS）。** 打开 设置 › 浏览器 › 「从 Chrome 同步登录状态」，Plume 里的网页（包括 agent 打开的）就以你在 Chrome 里的身份访问，并随 Chrome 保持同步。默认关着。之后 macOS 会请求读取钥匙串，选「允许」。如果提示读不了 Chrome 的数据，到 系统设置 › 隐私与安全性 › 完全磁盘访问权限 里打开 Plume。
- **网站弹出的登录窗口能用了。** 「用 … 登录」、支付这类网站弹出的窗口，现在开在 Plume 旁边，登完回到原来的页面。以前它根本打不开。要在新标签打开的链接，现在开成后台标签。
- **碰到登录和验证码，agent 会叫你。** 页面要输密码或做人机验证（reCAPTCHA、Cloudflare、滑块这些）时，agent 停下来请你处理，不自己硬闯。
- 内置浏览器里登录过的网站要重新登录一次：以前网页的数据混在 Plume 自己的数据里，没存进浏览器单独的那一份。网站也不能再用摄像头、定位了。
- **磨砂质感。** 外观 › 会话背景 › 质感 可以给整个窗口加一层细颗粒，有没有背景图都行。
- **看图器里又能复制、另存为了。** 以前对话里几乎所有截图，点「复制」没反应，「另存为」提示导出失败。
- **提示条** 侧栏开着时也在窗口正中，关闭按钮一直显示在最右边，不用把指针停上去才出现。
- 设置保存失败时会告诉你，不再悄悄丢掉；关掉模型编辑器前会等它存好。代码字体可以恢复默认。
- 在侧栏拖动会话只把那一个项目改成手动排序，不再连带别的项目。
- 排队的消息发送失败时回到输入框，不会凭空消失。
- 审批判断风险时命令名不分大小写，`Rscript` 和 `rscript` 一样算高风险。
- Git 面板读仓库状态时，不再运行仓库自带的程序（钩子、过滤器、fsmonitor）。
- 网页搜索的 API key 加密存放。
- 这个版本之前记下的调用轨迹还能列出来，但点开看不到请求详情了。
- 如果更新到这个版本后 Plume 打不开，请在本页下载安装包，把 Plume 拖进「应用程序」。「立即重启」在这个版本里修好了，之后的更新不会再把 Plume 弄坏。

### 给插件作者

- `plume.browser` 改为内置插件，插件市场里不再有它。宿主自己开出登录小窗口时，`popup` 事件带 `window: true`，插件不用再开，也驱动不了它。`ctx.pages.chromeLogins("status" | "on" | "off")` 查看和开关 Chrome 登录状态同步，开启时一定由系统对话框请人确认。
- 皮肤可以设 `root-image`（CSS 图像，缺省 `none`），给窗口外圈铺渐变。
- 去掉了 `PLUME_PLUGIN_PATHS`。自己的插件用 `plume-plugin dev` 或 `plume-plugin install` 装。
- `ModelContext.systemPrompt` 改为只读，改提示词经 `sections`。`CompactSummary.head` 必填。`step.end` 钩子返回宿主不认识的判定时报错，不再当作继续。
- 技能的 `allowed-tools` 不再收窄可用工具。`web_fetch` 的 `format` 只剩 `"text"`、`"raw"`。
- `@plume/ui` 删掉了没人用的 props 和导出：`AgentAvatar.badge`、`RetainedViews.slide` 和 `pageClassName`、`ActionSpinner.onFill`、`Overlay.align`、`CountUp.bidirectional` 和 `ms`、`TextArea.fieldRef`、`ClosableTab.labelClassName`、`DiffView`、`diffLines`、`TypedText`、`AvatarStack`、`GitHubMark`、`RowDeleteButton`。

## [0.1.5] - 2026-11-11

<!-- plume:notes en -->
### Changes

- **Pick the model and thinking level before a side chat's first message.** Before, a new side chat showed no model or thinking-level picker until you had sent something, so the first message always ran on the default model. The pickers are now there from the start, and what you choose is used for that first message.
- **Skills in the Marketplace open on the marketplace's skill packs.** The Skills tab used to mix the skills on this computer and the marketplace's packs on one page. It now opens on the marketplace's packs: press "+" on a card to install one. Your own skills are under "Installed", grouped by project, personal, from plugins and other folders, and a plugin's skills appear as one card that opens the plugin's details. "Add skill" at the top either has the agent write a new skill in a new conversation or opens your personal skills folder. Skills that come with built-in plugins are no longer listed and are always on.
- **Connectors work the same way.** The Connectors tab now opens on the marketplace's connectors, and the ones you have set up are under "Installed". To add your own server, click "Add connector" at the top.
- The Skills and Connectors tabs no longer have a search box. Like Plugins, they are filtered by category, and categories that don't fit on one line go under "More".

### For plugin authors

- `ConversationProps.composer` accepts `blank: { parentId, model }`, so a child conversation's composer shows the model and thinking-level pickers before the conversation exists. The person's choice comes back as the `choice` argument of `send` and `sendMessage`; pass it to `ctx.sessions.create`.
- A plugin that manages skills or connectors can add entries to the "Add skill" and "Add connector" menus through `actions` in `ui.settingsSection` options. Its section shows under "Installed" and gets `refreshKey`, `openPlugin` and, for skills, `project` from the host, so it no longer draws its own toolbar.

<!-- plume:notes zh-CN -->
### 改动

- **侧边聊天发第一句前就能选模型和思考档位。** 以前新开的侧边聊天要先发一句才出现模型和档位选择，第一句总是用默认模型跑。现在一打开就能选，第一句就按你选的来。
- **插件市场的「技能」默认列市场里的技能合集。** 以前这一类把本机的技能和市场里的合集混在一页。现在打开先看到市场里的合集，点卡片上的「+」就能装上。本机的技能在「已安装」里，按项目、个人、来自插件、其他目录分组，插件带的技能合成一张卡片，点开是插件详情。页顶的「添加技能」可以让 agent 在新对话里写一个，也可以打开个人技能目录。内置插件带的技能不再列出，始终生效。
- **「连接器」也改成同样的样子。** 打开先看到市场里的连接器，本机配好的在「已安装」里。要自己加，点页顶的「添加连接器」。
- 「技能」「连接器」两类去掉了搜索框，和插件一类一样按分类筛选，一行放不下的分类收进「更多」。

### 给插件作者

- `ConversationProps.composer` 新增 `blank: { parentId, model }`：子会话还没建时，输入框也能画出模型和思考档位选择。人选的经 `send`、`sendMessage` 的 `choice` 参数交回，建会话时传给 `ctx.sessions.create`。
- 管技能、连接器的插件可以经 `ui.settingsSection` 选项里的 `actions` 往「添加技能」「添加连接器」里加条目。它那一节画在「已安装」里，`refreshKey`、`openPlugin`（技能还有 `project`）由宿主给，不用再画自己的工具条。

## [0.1.4] - 2026-11-11

<!-- plume:notes en -->
### Changes

- **Choose the model and thinking level for a suggested chat.** When Plume suggests running something as a separate chat, the card now has the same model and thinking-level pickers as the message box, right next to Start. Before, the new chat always started on the default model and default thinking level.
- **The file delivery card no longer has a Report button.** The report only repeated what the card and the review panel already show, and it sometimes included markers that the conversation hides. The card keeps Undo and Review.

### For plugin authors

- **Plugins you install yourself no longer get replaced by marketplace updates.** Plugins added with "Upload from this computer", `plume-plugin install` or `plume-plugin dev` now go into `~/.plume/local-plugins/`, apart from marketplace plugins. If one has the same name as a marketplace plugin, yours is the one that loads and automatic updates leave it alone; uninstall it to go back to the marketplace version. Before, it shared a folder with marketplace plugins and was overwritten as soon as the marketplace had a newer version.
- A plugin in a `PLUME_PLUGIN_PATHS` folder now takes precedence over an installed plugin with the same name. Before, the installed copy loaded and your changes didn't show up.

<!-- plume:notes zh-CN -->
### 改动

- **建议的新会话能选模型和思考档位了。** Plume 建议另开一个会话去做某件事时，卡片上「开始」旁边多了和输入框里一样的模型、思考档位选择。以前开出来的新会话总是默认模型、默认档位。
- **文件交付卡上去掉了「报告」。** 报告里的内容卡片和审核面板里本来就有，还会带上对话里隐藏掉的标记。卡片上保留「撤销」和「审核」。

### 给插件作者

- **自己装的插件不会再被市场的更新换掉。** 经「从本地上传」、`plume-plugin install`、`plume-plugin dev` 装的插件，现在放在单独的 `~/.plume/local-plugins/`，不和市场装的混在一起。和市场里的插件同名时用你装的这份，自动更新也不碰它；卸掉就回到市场版。以前它和市场装的放在一处，市场一出新版就被盖掉。
- `PLUME_PLUGIN_PATHS` 下的插件现在优先于已装的同名插件。以前加载的是已装的那份，你改的不生效。

## [0.1.3] - 2026-11-10

<!-- plume:notes en -->
### Changes

- **In-app updates on macOS work.** Updating from inside the app always failed on macOS: right after downloading it said the downloaded update had no app in it, or, if you had clicked Download twice, "ENOTEMPTY: directory not empty, rmdir". Both are fixed, starting with the update after this one. To get this version, download the installer from this page and drag Plume into Applications.
- **Menus say Plume.** The app menu's About, Hide and Quit items carried an internal name instead of Plume. Because the app now uses its real name, a few interface preferences (sidebar folding and sorting, panel layout) go back to their defaults once, and pages you signed in to in the built-in browser need signing in again; conversations, settings and plugins stay as they were.
- **The app is much smaller.** The installer no longer carries the app's source code, tests and a second copy of libraries it had already built in, so it downloads faster and takes less disk space.

<!-- plume:notes zh-CN -->
### 改动

- **macOS 上能在应用里更新了。** 以前在应用里更新总是失败：下载完说「下载的更新包里没有找到应用」，点过两次「下载」时则是「ENOTEMPTY: directory not empty, rmdir」。两处都修好了，从这个版本之后的更新起生效；要装上这个版本，请在本页下载安装包，把 Plume 拖进「应用程序」。
- **菜单里写的是 Plume 了。** 应用菜单的「关于」「隐藏」「退出」以前跟着一个内部名字，不是 Plume。应用改用自己的名字后，界面上的一些偏好（侧栏的折叠和排序、面板布局）会回到默认一次，内置浏览器里登录过的网页要重新登录；对话、设置和插件都不变。
- **应用小了很多。** 安装包里不再带应用的源码、测试，以及已经打进应用里的那些库的另一份副本，下载更快，占的磁盘也更少。

## [0.1.2] - 2026-11-10

<!-- plume:notes en -->
### Changes

- **Skills and connectors in the marketplace.** The sidebar's "Extensions" is now called "Marketplace", and besides plugins you can add skill collections and connectors (MCP servers) from it. Skills work as soon as they're installed; for a connector, fill in the values it asks for on its card and it connects. Optional values can be left empty, and anything you filled in can be changed or cleared later.
- **Links to temporary files in replies now open.** When Plume saved a report or the full output of a long command to the conversation's temporary folder, the file link in its reply did nothing. It now opens. A conversation also can no longer change or delete another conversation's temporary files without asking you.
- **The About page looks like it used to.** The app icon, version and "Check for Updates" are back at the top, and the update indicator shows a spinning arc again while an update is being prepared.
- Tooltips on the buttons of a notification banner are no longer hidden behind the banner.
- In Magpie's Agent page, the Plume icon is now the same size as the other app icons.

### For plugin authors

- The plugin SDK is on npm as `@plumeai/plugin-sdk`, so a plugin project can depend on it by version (`npm i -D @plumeai/plugin-sdk`).
- `plume-plugin check` now also checks the plugin rules besides types: imports only from the public interfaces, colors and styles only from theme tokens, and no hard-coded interface text.

<!-- plume:notes zh-CN -->
### 改动

- **插件市场里能添加技能和连接器了。** 侧栏的「扩展」改名为「插件市场」，除了插件，还能在这里添加技能合集和连接器（MCP 服务）。技能装上就能用；连接器装上后，在它的卡片里填好要求的值就能连上。可选的值可以不填，填过的也能随时改或清掉。
- **回复里指向临时文件的链接能点开了。** 以前 Plume 把报告、长命令的完整输出存进会话的临时目录后，回复里的文件链接点了没反应，现在能打开。另外，一个对话不能再不经过你就改、删别的对话的临时文件。
- **关于页恢复成原来的样子。** 顶上重新是应用图标、版本号和「检查更新」；准备更新时，更新圆点上重新有一段转动的弧线。
- 提示条上按钮的悬停说明不再被提示条挡住。
- 在 Magpie 的 Agent 页里，Plume 的图标不再比别的应用小一圈。

### 给插件作者

- 插件 SDK 发布到了 npm，包名 `@plumeai/plugin-sdk`，插件项目可以按版本依赖它（`npm i -D @plumeai/plugin-sdk`）。
- `plume-plugin check` 除了类型检查，也查插件规则：只引用公开接口，颜色和样式只用主题 token，界面文字不写死。

## [0.1.1] - 2026-11-10

<!-- plume:notes en -->
### Changes

- **macOS permissions now survive updates.** Earlier builds lost Screen Recording, Accessibility and similar permissions every time you installed a new version. Plume is now signed with a fixed certificate, so macOS treats each update as the same app. Moving from an earlier build to this one asks for those permissions one last time.
- **Updates arrive inside the app.** New versions are published on GitHub Releases, and Plume finds them for you and downloads and installs them from inside the app—no more reinstalling by hand.

The first launch after downloading is still blocked by macOS (Plume isn't notarized yet). Open System Settings › Privacy & Security and click "Open Anyway". On Windows, click "More info › Run anyway" in SmartScreen.

<!-- plume:notes zh-CN -->
### 改动

- **macOS 上更新后权限不再丢。** 之前每装一个新版本，屏幕录制、辅助功能这些权限都要重新给一遍。现在 Plume 用固定的证书签名，系统把更新后的应用认作同一个。从之前的测试版换到这一版时，还要最后再授权一次。
- **应用内就能更新。** 新版本发布在 GitHub Releases 上，Plume 会自己查到，在应用里下载、安装，不用再手动重装。

下载后第一次打开仍会被 macOS 拦下（还没有做苹果公证）：到「系统设置 › 隐私与安全性」点「仍要打开」。Windows 上 SmartScreen 提示时点「更多信息 › 仍要运行」。
