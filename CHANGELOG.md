# 更新日志

这个文件由 `pnpm release` 生成，条目来自提交信息。写得含糊的提交在这里也含糊，所以值得在提交时就写清楚。

## [0.9.7] - 2026-11-27

<!-- plume:notes en -->
### Changes

- **Browser screenshots from hidden tabs no longer hang, and the browser stops instantly.** Taking a browser screenshot while the panel tab was hidden—after switching tabs, collapsing the panel, or leaving the conversation page—could hang forever: Electron stops producing frames for hidden `<webview>` guests, and the capture had no timeout while ignoring the stop button, so a stuck capture also left the session busy with no way out. Captures now briefly make the target webview visible while they run (restoring it right after, so nothing flashes on screen), wait two frames so background tabs—freshly resized or never shown—commit their new layout, and time out after 15 seconds or on page destruction or crash. All browser tools now honor the stop button immediately, including wait and hold steps inside page scripts.
- **"Send now" no longer drops messages on busy sessions.** Clicking "Send now" on a queued message while the session was still finishing its previous turn used to remove the message from the queue before that turn actually ended; when the turn was slow or stuck—and especially when you pressed stop—the message vanished from both the queue and the transcript. A queued message sent on a busy session now stays in the queue and only enters the conversation after the previous turn finishes cleanly; stopping, deleting, or canceling during the wait neither sends it by mistake nor loses it.

<!-- plume:notes zh-CN -->
### 改动

- **后台标签网页截图不再卡死，浏览器工具支持按停立即中止。** 把面板切到别的标签、收起面板或切出对话页后再截图，截图会永久挂起：Electron 对处于隐藏状态的 `<webview>` 停止出帧，而截图既没有超时也不理会按停，一旦卡住会话就停不下来。现在截图期间临时把目标 webview 恢复可见（结束后立即还原，画面不闪）、先等两帧让后台标签（包括刚改过视口的和从未展示过的）提交新画面，并加上 15 秒超时和页面销毁 / 崩溃中止；所有浏览器工具都响应按停立即中止，页面脚本里的等待步骤也一样。
- **会话忙时点「现在就发」不再丢消息。** 以前会话还在收尾上一轮时点「现在就发」，消息会在上一轮真正结束前就从队列里删掉；上一轮收尾慢或卡住时——尤其是按停的时候——这条消息会同时从排队条和对话记录里消失。现在会话忙时消息先留在队列里，等上一轮正常收尾后再出队进入对话；等待期间按停、删除或取消都不会误发，消息也不丢。

### 修复

- **core**: 会话忙时点「现在就发」不再提前出队丢消息 (`0457d04`)
- 后台标签网页截图不再卡死，浏览器工具支持按停立即中止 (`cc57cba`)

## [0.9.6] - 2026-11-27

<!-- plume:notes en -->
### Changes

- **Tighter window chrome on Windows and Linux.** Previously, Windows and Linux kept an extra top row below the window header bar to mirror macOS traffic-light spacing, wasting vertical room and splitting Plugin Market breadcrumbs or plugin page titles onto a separate row. The header bar now matches the activity rail's background while the sidebar and main cards start right beneath it: conversation headers and panel tabs sit cleanly as the first row inside their cards, and Plugin Market breadcrumbs and plugin page titles move into the header bar right next to the navigation buttons.
- **Let the agent install and load local plugins for you.** Asking the agent to install a plugin you just built used to end with it handing you a terminal command to run yourself, because the rule against shell-editing `~/.plume` was read too broadly. Plume's built-in prompt now explicitly allows running `~/.plume/bin/plume-plugin install` and `dev` directly—requesting escalated approval if sandboxed—while still requiring file tools with a visible diff for editing files under `~/.plume`.
- **Flexible custom styling for third-party plugins.** Running `plume-plugin check` used to enforce Plume's first-party design tokens across the board, blocking custom colors, font sizes, radii, and transitions. Scoped custom CSS is now allowed by default, while `plume-plugin check` focuses on catching broken Tailwind classes and unscoped selectors that could leak into the host UI; pass `--strict-style` whenever you want full Plume design-system enforcement.

<!-- plume:notes zh-CN -->
### 改动

- **Windows 与 Linux 窗口顶栏更紧凑。** 以前在 Windows 和 Linux 上，顶部标题带下面还会多占一行卡片外顶行，既浪费垂直空间，也让插件市场面包屑和插件页标题与导航按钮拆在两行。现在顶部带子与活动栏底色连成一体，侧栏和卡片紧贴带子下方开始：对话标题栏与面板标签行收进卡片第一行并用细线隔开，插件市场面包屑和插件页标题直接放进顶部带子，紧跟在后退、前进和页面按钮之后。
- **Agent 会直接帮你执行 `plume-plugin install` / `dev`。** 以前让 Agent 开发或安装本地插件时，它常把「不许用 shell 改 `~/.plume`」理解成连装插件也不能跑，把安装命令推给你自己去终端里敲。现在系统提示词在继续禁止用 shell 直接改写 `~/.plume` 文件的同时，明确放行了 Plume 自带的 `plume-plugin install` 和 `dev`；若被沙箱拦截，Agent 会直接发起提权审批由你放行。
- **第三方插件默认放行自定义样式，新增全局 CSS 污染检查。** 以前写外部插件时，`plume-plugin check` 会套用 Plume 内置插件的严格规范，禁止写自定义颜色、字号、圆角和动效时长。现在默认允许带作用域的自定义样式，检查聚焦于拦截会静默失效的产品 Tailwind 类名以及可能污染宿主界面的全局选择器；如需严格对齐 Plume 设计系统，可通过 `--strict-style` 开启完整规则检查。

### 新功能

- **desktop**: Windows 与 Linux 窗口收紧顶栏布局，插件市场与插件页标题并入顶部带子 (`b17d1d8`)
- 外部插件默认允许自定义样式，新增全局 CSS 污染检查与 --strict-style 开关 (`2e3ee19`)

### 修复

- **core**: 系统提示词放行 plume-plugin install 与 dev，不再把装插件推给用户 (`6325378`)

### 文档

- 更新设置文档中 Magpie 用的 Agent 插件目录路径 (`d9103fe`)

## [0.9.5] - 2026-11-26

<!-- plume:notes en -->
### Changes

- **Revert messages—and file edits—directly in side chat.** Side chat used to only offer "Edit & resend," leaving no way to pull a message back or undo files edited from a side thread. Every message in side chat now has a Revert action that puts your text, attachments, and session references back into side chat's own composer without touching the main input. When reverted or re-asked turns changed files, you get the same option to roll those files back—and if a file change previously reported to the main session gets rolled back, the main session is reminded to re-read those files on its next turn.
- **Follow up with existing sessions and get reports back from side chat dispatch cards.** Starting a new session from a side chat dispatch card used to mean tracking its progress manually—and follow-up tweaks could easily spin up another duplicate session. Dispatch cards now list active sessions already opened from that side chat so you can hand follow-up work straight back to them, and "Open new session" now defaults to "Report back when done" so each completed turn delivers its summary right back to the side chat and wakes it up. Plugin sub-sessions can also use `spawnedFrom.callIn` together with `reportBack`.
- **Refreshed model catalog.** Updated the bundled model catalog snapshot shipped with the app.

<!-- plume:notes zh-CN -->
### 改动

- **侧边聊天支持撤回任意消息，并可连文件一起回退。** 以前侧边聊天只有「编辑并重新提问」，发出去的消息撤不回，侧边聊天改过的文件也退不回去。现在侧边聊天里的每一句提问都可以直接撤回，原文、附件与会话引用会回到侧边聊天自己的输入框，不影响主对话输入框；撤回或编辑重问涉及文件改动时，可与主对话一样选择连同文件一起退回。如果被截掉的轮次曾把文件改动通知过主会话，主会话下一问前也会再次收到重读提醒。
- **侧边聊天交办卡片支持选已有会话接着做，开新会话默认「做完送回」。** 以前从侧边聊天交办卡片开出新会话后，后续想继续改容易重复开新会话，也收不到对方做完后的汇报。现在卡片会直接列出这段侧边聊天开过且未归档的会话，一键即可让它接着做；「开新会话」新增默认开启的「做完送回」开关，对方每做完一轮就会把汇报交回这段侧边聊天并唤醒它（插件子会话也同步支持 `spawnedFrom.callIn` 搭配 `reportBack`）。
- **刷新模型目录快照。** 更新了随应用分发的模型目录快照。

### 新功能

- **core**: 侧边聊天交办卡片支持选已开会话接着做，开新会话默认做完送回 (`1effbd4`)
- **core**: 带 callIn 的关联会话支持把每轮汇报交回对应子会话 (`3475f71`)
- **desktop**: 侧边聊天里能撤回任一句，字和附件回到侧边聊天自己的输入框 (`27a4811`)
- **core**: 侧边聊天这类插件子会话也能撤回，撤回和编辑重发都能连文件一起退 (`4f3b52c`)

### 修复

- **core**: 侧边聊天说过的改动被撤回截掉后，主会话下一问再提醒一次那几个文件 (`c890f08`)

### 文档

- 架构、多会话功能、冒烟和插件 skill 同步侧边聊天交办与做完送回 (`76fdfbb`)
- 功能说明、冒烟和插件 skill 跟上侧边聊天的撤回 (`416fa43`)

## [0.9.4] - 2026-11-26

<!-- plume:notes en -->
### Changes

- **Readable diffs, highlighted commands, and safer layout in approval cards.** Reviewing file edits, shell commands, or tool arguments used to mean reading plain gray monospace text—and long file paths in narrow panels could push the action buttons right out of the card. Approval cards now render file changes with line numbers, add/remove highlights, and syntax coloring matching tool cards, highlight shell commands and JSON arguments, and clamp long titles to two lines (with the full title on hover) so the buttons stay visible.
- **One-click choice cards when the agent offers options.** When a turn wraps up with a few approaches to choose from, you no longer need to type out "go with option A." The agent can now finish with a choice card: click an option to send it as your message, dismiss the card, or simply type your own reply. Card actions that fail to queue now report the error and let you retry instead of appearing as sent.
- **Smoother side chat and sub-agent workflows.** Approvals triggered in a side chat now appear right above its own composer while the tab is visible, falling back to the main composer only when the panel is hidden or in the background so requests are never missed. Panel tabs also show a waiting dot when a sub-agent needs approval or input, and side chats can now message other active top-level sessions in the same project or Git repository.
- **Eliminated white flashes when toggling the sidebar on 5K 120Hz displays.** On high-refresh 5K screens with long transcripts and an open side panel, opening or closing the sidebar could still exhaust tile memory and flash blank bands. Isolating edge layers, using lightweight edge fades on solid backgrounds, and avoiding unnecessary re-layouts during sidebar transitions sharply reduces tile memory and keeps slides smooth.
- **Quick pin in the sidebar, fixed draft cursor placement, and refreshed model catalog.** Hovering a session row restores the one-click pin button, ordered Pin, Archive, and "…" on the far right to match project rows. Creating a plugin or pre-filling a draft now places the cursor at the end of the text rather than the beginning, and the bundled model catalog snapshot has been updated.

<!-- plume:notes zh-CN -->
### 改动

- **审批卡支持 diff 与语法着色，窄面板不再挤出按钮。** 以前审批改文件、跑命令或调用工具时，正文只有一段灰色纯文本，很难一眼看清改了哪几行，长路径标题在窄面板里还会把按钮挤出卡片。现在文件修改直接按工具卡片同款的 diff 视图展示（带行号、增删色条和按文件类型上色），命令与 JSON 参数也按语法着色；长标题最多显示两行（悬停可看全文），操作按钮始终留在卡片内。
- **回复末尾新增方案选择卡。** Agent 做完一轮并列出几个待选方案时，不再需要手动打字回复，回复末尾会直接出现选择卡，点选一项即可当成你的消息发出（也可以关闭或直接打字跳过）。同时修复了卡片中点击发送的消息未能入队时仍误显示为已发送的问题。
- **侧边聊天与子 Agent 协作更顺手。** 在侧边聊天里触发的审批卡现在直接画在侧边聊天的输入框上方，只有面板收起或标签在后台时才回退到主输入框上方提醒；子 Agent 等待批准或回答时，面板标签图标上会亮起等待点；侧边聊天也可以直接向同项目或同一 Git 仓库内的其他未归档顶层会话发消息。
- **5K 120Hz 大屏开合侧栏不再闪白。** 修复了高刷大屏同时打开长对话和右侧面板时，开合侧栏仍可能打满图块显存导致整条闪白的问题；通过边沿控件独立提层、纯色底面轻量化渐隐以及减少滑动期间的重排与纹理分配，显著降低显存峰值，切换更稳。
- **侧栏恢复悬停置顶，修复草稿光标位置并刷新模型目录。** 侧栏会话行悬停时恢复一键置顶按钮，按「置顶、归档、⋯」排列并与项目行对齐；新建插件或预填、恢复草稿聚焦输入框时，光标现在会落在内容末尾而非行首；同时更新了随应用分发的模型目录快照。

### 新功能

- **desktop**: 审批卡正文按声明画成 diff，命令和参数按语法上色，和工具卡片一个样子 (`641d077`)
- **core**: 审批请求可以声明正文是一个文件的 diff、一条命令还是 JSON 参数 (`6a53b0f`)
- **core**: agent 给出几个方案时回复末尾出一张选择卡，点一项就当人的消息发出去 (`272ec5e`)
- **desktop**: 子 Agent 等人批准时，面板标签上亮等待点 (`0449edb`)
- **desktop**: 侧边聊天的审批卡画在侧边聊天里，看不见时才压到主输入框上方 (`bf82c57`)
- **desktop**: 恢复侧栏会话行悬停时的置顶按钮，并将「⋯」移至最右端 (`b330ed4`)
- **core**: 侧边聊天可直接向同项目或同 Git 仓库的其他顶层会话发消息 (`fd2e129`)

### 修复

- 5K 120Hz 开合侧栏时不再打满图块显存导致整屏闪烁 (`3f6ee86`)
- **desktop**: 卡片里点的消息没排上时报失败，不再显示成已发送 (`0b59758`)
- **ui**: 审批卡标题最多两行，窄面板里按钮不再被挤出卡片 (`383feba`)
- **desktop**: 新建插件和预填草稿聚焦输入框时，光标落在内容末尾而非行首 (`e826bd2`)

### 重构

- **desktop**: 工具卡片详情里的命令框和参数框抽成共用组件 (`5adbcc3`)

## [0.9.3] - 2026-11-25

<!-- plume:notes en -->
### Changes

- **Expand linked-session reports in place.** Clicking a "From linked session" row now expands the returned report right inside your current conversation instead of jumping away immediately. A dedicated arrow button at the end of the row opens the linked session when you want to switch over. Session names are now highlighted and left-aligned with tool rows above them.
- **No more white flashes when toggling the sidebar on large displays.** Fixed brief blank frames when opening or closing the sidebar in maximized windows on 5K and other high-resolution screens by eliminating redundant full-screen clip masks along joined pane edges.
- **Readable MCP tool labels in transcripts.** On-demand MCP lookups and calls no longer surface raw `mcp_search` or `mcp_call` tool names in the transcript, showing clear action descriptions and matching icons instead.
- **Plugin SDK testing helper and refreshed model catalog.** Plugin authors can now test logic entry points directly with `@plumeai/plugin-sdk/testing` and `plume-plugin test` (included in new plugin templates), and the bundled model catalog snapshot has been updated.

<!-- plume:notes zh-CN -->
### 改动

- **关联会话汇报支持就地展开，排版更齐整。** 点击「来自关联会话」不再直接跳走，而是原地展开查看对方交回的汇报内容；行尾新增独立的跳转图标按钮，需要时再切到对应会话。同时统一了过程行与工具行的左边缘对齐，并高亮显示会话名称。
- **大窗口下开合侧栏不再整块闪白。** 修复了 5K 等大屏最大化或面板展开时开合侧栏偶发白屏闪烁的问题，消除了贴边圆角裁剪产生的整屏显存遮罩。
- **按需 MCP 工具在转录里不再露出原始工具名。** 按需搜索和调用 MCP 工具时，对话中不再显示 `mcp_search`、`mcp_call`，改为清晰的中文动作说明（如「搜索 MCP 工具」「调用 MCP 工具」）与对应图标。
- **插件 SDK 新增单测工具并刷新模型目录。** 提供 `@plumeai/plugin-sdk/testing` 与 `plume-plugin test`，无需启动应用即可测试插件逻辑入口，新建插件模板自带测试；同时更新了随应用分发的模型目录快照。

### 新功能

- 插件 SDK 提供单测工具与测试命令，skill 接口参考改为从源码自动生成 (`3b817e9`)
- 「来自关联会话」一行改为点开查看汇报，行尾新增图标按钮跳转 (`5dccba0`)

### 修复

- 「来自关联会话」对齐工具组标题行并高亮会话名称 (`521d95d`)
- **core**: 按需搜索的 mcp_search、mcp_call 在转录里说中文，不再露出工具名 (`bb84b33`)
- **desktop**: 各栏身子的圆角改成四角同半径，贴边处不再生成整屏遮罩 (`4a2b27b`)
- **desktop**: 大窗口最大化时开合侧栏不再整块闪白 (`43167d7`)

## [0.9.2] - 2026-11-24

<!-- plume:notes en -->
### Changes

- **Cleaner, wrapped-by-default code blocks.** Code blocks in chat no longer take up an extra header bar for the language label. Long lines wrap automatically, while Copy (and Run in terminal for shell commands) sit cleanly in the top-right corner—centered alongside single-line commands and tucked out of the way for multi-line blocks.
- **Skins can carry their own chat backdrop.** Themes can now include a dedicated background image and effect without touching your global wallpaper settings. Turning the skin off automatically brings your original backdrop back.
- **Better contrast inside overlays with custom skins.** Fixed question-card options, fenced code blocks in the composer, and Git branch loading states blending into the card background under custom skins.
- **Tighter chat alignment and delivery cards.** Wide windows now keep the transcript column and composer aligned flush on both edges so delivery cards no longer jut out to the right. Delivery card headers and file rows are more compact, and hovering or focusing a file link underlines the text instead of filling a heavy gray pill.
- **Side-panel image and menu fixes.** Switching away from an image tab in the side panel no longer leaves the image visible over other tabs. Git and Project files entries in the side-panel menu now also show localized descriptions.

<!-- plume:notes zh-CN -->
### 改动

- **代码块去掉标题栏，默认自动换行。** 对话里的代码块不再单占一行显示语言名和换行开关，长代码默认折行；复制按钮（可执行 shell 命令还带「在终端运行」）收在右上角，单行命令与按钮同行垂直居中，多行代码时也不遮挡正文。
- **皮肤可自带独立会话背景，不覆盖原有壁纸。** 皮肤现在可以附带专属会话背景与滤镜效果，不会改写你的全局背景设置；撤下皮肤后自动回到你原来的壁纸。
- **换肤后浮层内元素层次更分明。** 修复了使用换肤工坊或自定义皮肤时，提问卡选项、输入框代码块以及 Git 分支菜单加载骨架容易融进浮层背景的问题。
- **宽窗排版对齐，交付卡与文件签更轻盈。** 宽窗下正文列与下方输入框严格左右对齐，交付卡不再向右探出；文件交付卡收紧了顶栏与文件行高度，减少回复底部占位；文件签悬停与聚焦时改为淡入文字下划线，不再铺整块灰底。
- **侧边面板看图与菜单细节修复。** 修复了在侧边面板打开图片后切到其他标签页时图片仍穿透残留的问题；为侧边面板菜单里的「Git」和「项目文件」补全了中英文描述。

### 新功能

- **desktop**: 代码块去掉标题栏并默认自动换行，操作按钮收在右上角 (`dbd3794`)
- 皮肤可携带独立会话背景并保留全局图片 (`507b336`)

### 修复

- **desktop**: 宽窗下转录列与输入框左右对齐，交付卡不再向右探出 (`63b9c33`)
- 侧边面板的 Git 与项目文件项补充中英文描述 (`78c83ec`)
- **core**: 收紧文件交付卡片的头部与文件行尺寸，减少回复底部占位 (`db12153`)
- **desktop**: 文件签悬停与聚焦时改为文字下划线，不再铺灰色底色 (`00b6ec8`)
- 换肤后提问卡选项等浮层内元素不再融进卡片背景 (`e80ab3d`)
- **desktop**: 侧边面板查看图片后切到其他标签不再残留显示图片 (`f213bce`)

### 文档

- 同步换肤工坊细粒度 token 覆写与 Clawd 预设说明 (`7a5e393`)

## [0.9.1] - 2026-11-24

<!-- plume:notes en -->
### Changes

- **Unified multi-file diff for delivery reviews.** Reviewing changes from a delivery card now shares the same multi-file diff experience as the Git panel, complete with the sticky toolbar, unified or split comparison, and expand/collapse controls.
- **Cleaner diff and file preview scrolling.** Enabling word wrap in diff view now wraps long lines properly instead of letting left-column lines spill into the right pane in split view. Horizontal scrollbars are also hidden in diff and file previews while trackpad gestures and Shift+scroll continue to pan horizontally.
- **Open right-side panels in one step.** Clicking `+` in the right panel area now opens a panel menu directly instead of creating a throwaway start-page tab first.
- **New Pixel grid chat backdrop effect.** Choose Pixel grid in chat background settings to overlay crisp grid lines right on top of your wallpaper. It applies instantly via CSS without resampling the image, so animated GIFs keep playing.
- **More reliable cross-session handbacks and code block layout.** Handing results back from spawned sessions at the end of each turn is now handled by core, ensuring the originating session still wakes up even when mid-turn or batched messages arrive. Code blocks in chat also restore the language label to the top-left header with action buttons on the right and code cleanly below.

<!-- plume:notes zh-CN -->
### 改动

- **交付审核用上统一的多文件 diff 视图。** 现在打开交付卡的审核面板，和 Git 面板一样支持顶部工具栏、全部展开/折叠以及统一/分栏对比，一次审完多个文件改动更顺手。
- **diff 换行与横向浏览更利落。** 修复了差异视图开启自动换行后长行未真正折行、分栏模式下左栏内容画进右栏的问题；diff 和文件预览也去掉了视觉上多余的横向滚动条，触控板和 Shift+滚轮仍可照常横滚。
- **右侧面板区点「+」直接选面板。** 以前点右侧面板区的「+」会先多开一个开始页标签再挑选，现在直接弹出面板菜单，点选后即可打开对应面板。
- **会话背景新增「像素网格」效果。** 新的像素网格效果直接在原图上叠一层随底色自适应的规则格线，不需要重新采样图片，切换立即生效，动态 GIF 背景也能照常播放。
- **跨会话交回更可靠，代码块标题栏归位。** 开出来的会话每轮结束后的结果交回改由本体统一接管，即使一轮中途或同批多信里读到来处的消息，收尾交回也能准确叫醒来处；对话里的代码块恢复为左上角显示语言名、右侧放操作按钮、代码紧接在标题栏下方的布局。

### 新功能

- **desktop**: 会话背景新增「像素网格」效果，叠在原图上且保留 GIF 动画 (`3aed2eb`)
- **desktop**: 右侧面板区「+」改为弹出面板菜单，不再新开开始页标签 (`70e4713`)
- **ui**: MenuItem 透传 data-* 属性，与 Button 和 IconButton 保持一致 (`757ee73`)
- **core**: 开出来的会话每轮交回改由本体做，插件按 reportBack 选要不要交、读 session.cause 认这一轮是谁引起的 (`80cd8ac`)
- **desktop**: diff 和文件预览不再显示横向滚动条，触控板和 Shift+滚轮照样横滚 (`d56b734`)
- **core**: 交付卡的审核面板改成和 Git 面板一样的多文件 diff，可切换左右分栏对比 (`e7a8c43`)
- **ui**: 新增公共的多文件 diff 组件，Git 面板和交付审核面板共用一套工具栏和文件行 (`287e100`)

### 修复

- **core**: 开出来的会话在一轮中途或同批多信里读到来处的信，收尾交回照样叫醒来处 (`032f2e8`)
- **desktop**: 代码块的语言名回到左上角的标题栏，按钮在右，代码在标题栏下面 (`cc9a922`)
- **desktop**: diff 开了自动换行后长行真的折行，分栏时左栏的长行不再画进右栏 (`6754bcf`)

## [0.9.0] - 2026-11-24

<!-- plume:notes en -->
### Changes

- **Spot active chats and pending approvals at a glance.** When projects are folded in the sidebar, you used to have to open them one by one to find out which sessions were running or waiting for approval. A new "In progress" section above Pinned mirrors every running, waiting-for-approval, errored or unread finished chat with its project name. Collapsed project and section headers now also show the most urgent status inside the group instead of just a count.
- **Faster sidebar actions and cleaner renaming.** The one-click archive button is back on hover next to "…", and renaming a session now opens a centered dialog instead of a cramped sidebar popover that could accidentally trigger row hover cards.
- **Run project scripts from the environment card.** A new built-in Project Scripts plugin lets you run common dev, test or build commands in one click from the top of the environment card, import scripts from `.plume/scripts.json`, and run setup commands automatically whenever a new worktree is created.
- **Collapsible, better-organized environment card.** The environment card now groups version control, sub-agents and linked sessions into distinct sections with clean outlines. Click any section title to fold or unfold it so long lists of sub-agents or background tasks no longer take over the card.
- **Rebuilt Git diff view.** The Git panel now renders syntax-highlighted diffs with word-level emphasis and a sticky toolbar for file counts, expand/collapse all, unified or split view, word wrap and flat or tree file lists. Added or deleted files stay full-width in split view, while side-by-side edits scroll independently.
- **Clearer planning and document-style plan reading.** Plan approval cards now appear right below the turn's reply instead of covering the input bar. The plan panel uses centered document typography, expands raw Markdown without a height cap, and shows the plan file's path in its header. Plan mode also pushes the agent to inspect the codebase thoroughly and write concrete file-level changes.
- **Separate `$` skills from `/` commands.** Typing `/` in the composer now lists only commands, while `$` opens the skill picker and highlights `$skill` mentions anywhere in your message so skills and commands no longer collide.
- **Refreshed settings and batch archive management.** Settings returns to a full-height left sidebar with a breadcrumb header and centered card groups. Archived chats are now grouped into collapsible cards with batch restore and delete, and dialog action buttons have clearer fill and hover states.
- **Polish and fixes.** Refined Markdown spacing, body font size and inline code contrast; fixed the text-selection quote menu jumping to the top-left corner when switching sessions; cleared finished handed-off sessions from above the composer; and localized sub-agent status lines.

<!-- plume:notes zh-CN -->
### 改动

- **一眼看出哪些会话在跑、哪些在等批准。** 以前项目一折起来，想知道里面有没有会话卡在等批准或已经跑完，得一个个展开翻。现在侧栏置顶上方新增「进行中」分组，把正在运行、等待批准以及跑完或出错还没看的会话多列一份并标明所属项目；折起来的项目和分区标题也不再只显示数字，直接亮出组里最要紧的状态。
- **侧栏操作更顺手。** 悬停在会话行上恢复了排在「⋯」右侧的一键归档按钮；重命名会话改成居中的标准对话框，长标题更好改，打开时也不会误触侧栏悬停预览卡。
- **新增内置项目脚本，工作树可自动初始化。** 常用的启动、测试、构建命令现在可以直接配进项目脚本，在环境卡片顶上一键运行，也支持从仓库的 `.plume/scripts.json` 导入，并可在新建工作树后自动执行环境准备脚本。
- **环境卡片分组更清楚，也能按组收起。** 版本控制、子智能体与关联会话按节排布，卡片去掉多余阴影只留细描边；点击分组标题就能折叠或展开，子智能体和后台任务多时不再把整张卡片撑满。
- **重做 Git 差异视图。** Git 改动视图现在支持按文件语言的语法高亮与词级改动强调，顶部常驻工具栏集合了文件数、增删统计、全部展开/折叠、统一/分栏切换、自动换行以及扁平/树状列表切换；分栏下纯新增或纯删除文件自动通栏展示，双侧改动左右独立横滚，深浅色代码配色更清晰。
- **计划卡不挡输入框，计划面板像文档一样好读。** 计划审批卡移到当前一轮回复的下方；右侧计划面板改用居中文档排版，切到 Markdown 原文时直接完整摊开不限高，顶栏改为显示计划文件路径。计划模式也会引导模型先读透代码、落到具体改法再提交方案。
- **技能改用 `$` 触发，和 `/` 命令彻底分开。** 输入框里敲 `/` 只弹命令菜单，敲 `$` 弹技能菜单；行首和句中提到的 `$技能名` 都会高亮并生效，不再和同名命令互相遮挡。
- **设置页与已归档聊天更好管。** 设置浮层回到左侧通顶导航配面包屑顶栏、右侧居中卡片分组的布局；「已归档的聊天」改成可折叠分组卡片，支持批量恢复和批量删除；对话框底部按钮改用更醒目的实体色块样式。
- **排版与细节修复。** 调整了中文 Markdown 排版、正文字号和行内代码底色；修复切换会话时划词引用菜单甩到窗口左上角的问题；交出去的会话跑完或失败后会自动从输入框上方收走；子智能体提交结果行同步随界面语言切换。

### 新功能

- **desktop**: 折起来的项目和分区标题显示组里最要紧的状态，等批准、出错、跑完没看不再只剩一个数字 (`70bc069`)
- **desktop**: 侧栏置顶上方新增「进行中」，在跑、等批准和跑完没看的会话多列一份 (`b6c63d1`)
- **core**: 环境卡片的分组可以点标题收起，子智能体多时不再把卡片撑满 (`7f7a2c7`)
- **core**: 计划面板顶栏改为显示计划文件路径 (`5e8762a`)
- **desktop**: 重命名会话改为居中对话框，避免打开对话框时误触侧栏悬停卡 (`ef715c6`)
- **desktop**: 恢复侧栏会话行悬停时的归档按钮，排在「⋯」右侧 (`994fbce`)
- **ui**: 重设计对话框底部按钮的实体色块样式，浅色悬停与按下反馈清晰可见 (`90118f3`)
- **ui**: Segmented 新增紧凑模式与分组无障碍名 (`d430548`)
- **core**: 新增内置项目脚本插件，支持环境卡片一键运行与工作树自动初始化 (`7764b1c`)
- **core**: 新增 terminal.exec 服务与工作树创建完成回调 session.worktree.onCreated (`715b734`)
- 改版会话环境卡片为按节分组布局，补齐版本控制、子智能体与关联会话入口 (`c43de0b`)
- **desktop**: 设置页已归档聊天改为可折叠分组卡片并支持批量恢复与删除 (`4f979f8`)
- **core**: 计划模式先读透代码再定方案，计划写到具体改法 (`9d93bad`)
- 计划卡接在转录里这一轮的回复后面，计划面板改为文档排版、正文居中 (`6fb012d`)
- 重做 Git 差异视图与代码配色，支持语法高亮、智能分栏与常驻工具栏 (`0e2b783`)
- 输入框技能改用 $ 触发，与 / 命令分开 (`deaacf5`)
- **ui**: 设置浮层改回左侧通顶导航与面包屑顶栏，右侧改用居中卡片分组 (`36ff091`)
- **desktop**: 调整回复 Markdown 中文排版与行内代码底色 (`c3403de`)

### 修复

- **core**: 补全计划面板顶栏显示计划文件路径的接入与文档同步 (`968fe3f`)
- **desktop**: 交出去的会话在跑完或失败后从输入框上方收走 (`58d3847`)
- **core**: 环境卡片去掉阴影，只留描边 (`29fef98`)
- **ui**: 正文字号改为与界面基准字号一致，不再比控件大 1px (`3e8c53e`)
- **core**: 子智能体提交结果一行随界面语言切换并区分进行中与已完成 (`d10ffc6`)
- **desktop**: 切换会话时划词菜单立即收起，不再甩到窗口左上角 (`db2a5d1`)

### 重构

- 替换 Git、项目脚本与已归档设置页中手写样式为公共组件 (`51129c2`)

## [0.8.0] - 2026-11-23

<!-- plume:notes en -->
### Changes

- **Use your ChatGPT plan in Plume.** Install the new ChatGPT plugin, sign in with your ChatGPT account and its available models appear as a provider without an API key. Requests follow OpenAI's plan-specific Responses API rules. When the plan limit is reached or the account is not eligible, Plume stops retrying and pauses the provider instead of failing again on every message.
- **Streaming replies are easier to read and stay visually stable.** Text now fades in by phrase, while code blocks and tables grow smoothly as content arrives. Completed blocks remember their real layout while off screen, so returning to a long chat no longer causes a full-page reflow. Syntax highlighting is ready on the first frame when you switch back.
- **Fast replies no longer make the page lurch.** Bottom-following now spreads bursty layout changes into a continuous movement, keeps the final lines in view and avoids the jump that could happen when returning to a reply still in progress.
- **Settings is denser and more consistent.** The settings window now has a shared header, grouped navigation and full-width content. Built-in and plugin settings use the same rows, inputs, spacing and section hierarchy. Menus, dialogs, tooltips and overlays share the same motion and visual states in light and dark themes.
- **Agent instructions are safer and more decisive.** Plume now states exactly which instruction wins when user, project and global guidance conflict. It stops reopening settled decisions, checks before overwriting or deleting, and does not put personal details or private project content into outside search or fetch requests unless you asked for it.
- **Conversation controls are easier to reach.** A single “…” button on each session row opens the session menu, including delete for active sessions. Persona settings also have a direct “Create new” entry instead of requiring you to duplicate an existing preset first.
- **Tool use is more reliable.** File search handles ignored folders, scratch resources and path variants more accurately; reads and edits give clearer recovery instructions; compressed or single-line files can be inspected in smaller windows; and background-output delivery no longer floods the conversation.
- **Prompt caching survives more mid-turn work.** Steering a running turn no longer needlessly changes the prompt prefix or tool table, and request recovery trims only results added after the last request that model accepted.

<!-- plume:notes zh-CN -->
### 改动

- **ChatGPT 套餐额度可以直接给 Plume 用。** 安装新的 ChatGPT 插件，用 ChatGPT 账号登录后，账号能用的模型直接出现在供应商列表里，不需要 API key。请求按 OpenAI 套餐通道的 Responses API 规则发送；额度用完或账号不适用时不再反复重试，而是暂停供应商，避免之后每条消息都撞同一个错误。
- **流式回复更好读，版面也更稳。** 文字按句段淡入，代码块和表格随着内容平滑长宽；写完的块在屏幕外记住真实布局，切回长对话不会整页重新排版，语法高亮首帧就有，不先闪一下纯文本。
- **快速回复时页面不再一顿一顿地追。** 贴底滚动会把一批批到达的版面变化摊成连续移动，最后几行一直留在视野里；切回仍在输出的会话，也不会先到底、再往回跳一下。
- **设置页更紧凑，也更统一。** 设置窗口改成共用标题栏、分组导航和铺满右栏的内容；本体和插件设置使用同一套行、输入框、间距与章节层级。菜单、对话框、悬停提示和浮层在浅色、深色下也统一了动效和状态。
- **Agent 的指令更安全，也更果断。** 现在明确用户当次要求、近处项目指令、远处项目指令、全局指令和内置准则冲突时听谁的；已经定下来的事不再反复讨论，覆盖或删除前先看现状，未经要求也不会把个人信息、私有项目名或代码带进搜索词和抓取网址。
- **会话操作更顺手。** 每条会话行用一个「⋯」打开完整菜单，未归档会话也能直接删除；身份与准则设置里新增「新建一套」，不必先复制已有预设。
- **文件工具更可靠。** 搜索能正确处理忽略目录、scratch 资源和不同路径写法；读写失败时会说明该怎么恢复；压成一行的文件也能按命中或字符窗口分段查看；后台输出送达不再把刷屏内容原样塞进历史。
- **一轮中间继续交代事情时，提示词缓存不再无故作废。** 插话不再改掉提示词前缀和工具表；请求恢复也只裁掉同一模型最后一次接受请求后新增的大结果。

### 新功能

- **core**: 接入 ChatGPT 套餐专用模型通道 (`cff2f07`)
- **ui**: 重做流式 Markdown 排版与跟随滚动 (`8ded5f0`)
- **ui**: 统一设置页与浮层的视觉层级 (`407c3d2`)
- **desktop**: 会话行悬停改成一个「⋯」打开会话菜单，未归档的会话也能直接删除 (`6707d7c`)
- **core**: 身份与准则列表末尾多一行「新建一套」，不用先复制一套再改 (`611127e`)

### 修复

- **agent**: 明确指令优先级并保护私密上下文 (`50a165a`)
- **core**: 连续 20 步没说话时的进度提醒改成要发现，不再要模型播报下一步 (`c85503d`)
- **core**: 内置准则补回 a22d9d1 合并时丢掉的防过度设计、答复自足和不以预告收尾 (`c3c8caa`)
- **core**: 内置准则不再教「最小的改动」，改成修根因、先复现再修 (`a22d9d1`)
- **ui**: 菜单、提示、悬停卡、对话框和提示条进出同一个节奏，淡出放完才消失 (`c4afb87`)
- **core**: ls 把指向目录的软链列成目录，模型不再去 read 一个目录 (`457688c`)
- **core**: read 的大纲按文件自己的缩进认声明，两个空格缩进的文件照样折 (`dbad259`)
- **core**: bash 里跑的命令也找得到随包的 rg，不再退到慢得多的 grep -r (`420ff8e`)
- **core**: bash 改道到工具只拦工具做得到的，并认出 cd 前缀和 sed -n 读一段 (`ff176fc`)
- **core**: write、edit 被拒时说清是没读过、只读了一部分还是读后被改了，以及该怎么重发 (`a441610`)
- **core**: grep、glob 在 scratch:// 地址、被忽略的目录、./ 与绝对路径的模式上不再答「没有匹配」 (`8065ea8`)
- **core**: monitor 的命令自己结束时，那次送达也照 4000 字上限和清洗，不再把刷屏的输出原样送进历史 (`9bfbb97`)
- **core**: 请求被拒收后只剪同一个模型最后一次接受之后进来的大结果 (`a33e054`)
- **core**: 压缩只给留下的尾部里剪过的结果存原文，不再挤掉还在被指着的原文 (`50972f0`)
- **core**: edit 按缩进宽松匹配上之后，new_string 换成文件里的缩进，\u 转义也还原成字 (`6e0fbe7`)
- **core**: 压缩成一行的文件里，grep 每处命中各给一段，read 能用 char_limit 一次读宽一段 (`8648925`)
- **desktop**: 大文本附件超过 3 万字时只带开头并给出路径，不再整份跟着每一轮重发 (`aa4250f`)
- **core**: prompt.submit 钩子慢时，刚发出去的消息照样演气泡入场 (`63381d5`)

### 性能

- **core**: 循环在一轮中间补的话不再触发提示词增量和换工具表，缓存不从中间作废 (`962840c`)

### 文档

- 打包、发版和冒烟怎么跑从 AGENTS.md 搬进 docs/，命令表只留一行 (`61ebb50`)
- docs/features 跟上这一批工具、压缩和附件的行为 (`7a7ea97`)

## [0.7.8] - 2026-11-21

<!-- plume:notes en -->
### Changes

- **Compaction no longer throws away your prompt cache again and again.** When a long chat neared its limit, Plume first trimmed old tool output on its own. That usually bought only a little room, so it trimmed again later and then wrote a summary anyway. Each trim changed the start of the history, so the next request paid full price for almost the whole conversation again. Plume now writes the summary as soon as the chat reaches the limit, and the history is rewritten only that one time.
- **Summaries don't count unconfirmed claims as done.** A compaction summary used to treat what the model said the same way as what tools actually returned. A sub-session the model only claimed to have started, or a background task it made up, could end up in the summary as a real blocker. Now only things backed by a tool result count as done or running. Claims that only the model made are marked as unverified, and claims that were later corrected are dropped.
- **Sessions that message each other stop when you tell them to.** Two busy sessions writing back and forth could keep each other going past the limit of 10 wake-ups in a row, and a message could restart a session you had just stopped. Messages no longer wake a session you stopped, and the limit now also counts messages read at the end of a turn. Messages that can't wake the other session wait until its user next speaks. The sender is told about this, so its model doesn't assume the other side has taken over.
- **Sub-session reports arrive on time.** A sub-session woken by its own background work sometimes held its report until you next spoke in the parent chat, even though the parent was idle. Reports now wake the parent right away. A sub-session that finishes first waits at most a minute for its siblings before reporting.
- **Archived sessions stay quiet.** An archived session could still be woken by a message, a sub-session's report or a finished background task, and run more turns that cost money without showing in the sidebar. Archiving now settles all of these, and messages sent to an archived session are refused.
- **Undo still covers files changed before a question.** If a tool changed files and then asked you something, and you stopped it while it was waiting, those changes weren't recorded. Undo couldn't revert them and the delivery card didn't list them. They are now recorded like any other change.
- **"Test connection" works with more relay services.** Some relay services return their model list in a format "Test connection" didn't recognise, so it said no models could be listed even though "Fetch models" worked. Both now read the same formats.
- **Smoother while replying.** Long chats re-render much less while a reply streams in or tool results arrive. The panel area, the tool rows at the end of a turn and the input bar do less work, and the session database stores messages faster.
- **The session summary at the top of the environment card is gone.** The session summary plugin has been removed from the plugin market. The environment card now shows just the folder at the top.
- **Smaller fixes.** The retry countdown no longer stays on screen after a failed retry. Writing credentials or an exported Markdown file no longer leaves temporary files behind when the write fails. Changing an unrelated setting no longer rewrites the credentials file. API keys typed by hand into settings.json are now ignored; enter them in Settings instead.

<!-- plume:notes zh-CN -->
### 改动

- **压缩不再一次次让缓存作废。** 原来长对话快满时，Plume 先自己剪掉一些旧的工具输出，往往只腾出一点地方，过一阵又剪一次，最后还是要写摘要。每剪一次，历史的开头就变了，下一次请求几乎整段对话都要重新按全价算。现在到线就直接写摘要，历史只在这一次改写。
- **摘要不再把没证实的事当成做完了。** 原来压缩摘要里，模型自己说的和工具真实返回的分量一样：模型只是说开了子会话、或者编出一个后台任务，摘要里就可能写成真的待办和阻塞。现在只有工具结果能证明的事才算做完、在跑；只有模型说过的标成未核实，后来被纠正过的直接去掉。
- **互相发信的会话，按了停就停。** 原来两个都在忙的会话互相回信，可以绕过「接连叫起 10 轮」的上限一直跑下去；刚按停的会话，下一封信又把它叫起来。现在信不叫醒按停的会话，一轮收尾时读到的信也算进上限。叫不醒对方的信留到对方的人下次开口时读，发信的一方会被告知，不会以为对方已经接手。
- **子会话的汇报按时送到。** 原来子会话被它自己的后台任务叫起来做完一轮后，汇报有时一直排着，等你在主会话里开口才出现，哪怕主会话早就闲着。现在汇报当场叫醒主会话；先做完的子会话最多等兄弟会话一分钟，到点就先送。
- **归档的会话不会再悄悄跑起来。** 原来归档的会话还会被信、子会话的汇报或后台任务的结果叫起，侧栏里看不到，却在调模型花钱。现在归档时把这些一并结掉，寄给归档会话的信直接拒收。
- **问你之前改过的文件，撤回照样能退。** 原来工具先改了文件、再停下来问你，你在它等答复时按了停，那几处改动就没记下：撤回退不掉，交付卡上也看不到。现在和别的改动一样记上。
- **「测试连接」认得出更多中转站。** 有些中转站返回模型列表的格式「测试连接」不认，明明「拉取模型」拉得到，它却说列不出模型。现在两边认的格式一样。
- **回复时更流畅。** 流式输出和工具结果落地时，长对话里写完的旧消息不再整片重画；面板区、一轮收尾时的工具行和输入框那一排也少做了很多无用功，会话库存消息更快。
- **环境卡片顶上不再有会话摘要。** 会话摘要插件已经从插件市场撤下，环境卡片顶上只写目录名。
- **几处小修。** 重试失败后，界面上的重试倒计时不再一直挂着。写凭据或导出 Markdown 失败时不再留下临时文件；改别的设置时也不再重写凭据文件。手写进 settings.json 的 API key 不再生效，请在设置里填。

## [0.7.7] - 2026-11-21

<!-- plume:notes en -->
### Changes

- **Settings opens on top of what you're doing.** Opening settings used to take you away from your chat, the plugin market or a plugin's page, and you had to find your way back afterwards. Settings is now a large card over the current screen, with what's behind it softly blurred. Press Esc, click outside it or use the close button to go straight back to where you were. It also closes by itself when you open a chat or go somewhere else from inside settings. Section titles now sit in a breadcrumb at the top, and the descriptions under each setting are the same size on every page, including sections added by plugins.
- **A tidier environment card.** The card used to have a separate heading and row style for each plugin, and in wide windows it docked as a column that pushed the conversation aside. It now always floats in the top-right corner without moving the conversation. Its contents are grouped by role: the folder and session summary at the top, then "Background" (running commands, watches, checks and scheduled tasks), "Output" (approved plans, sub-sessions, new sessions and the pull request for this branch), references, and compaction history at the bottom. Every row looks the same. Right-click the card to choose what it shows. Suggested sessions you haven't started stay in the conversation and no longer light up the environment button.
- **Choose a spinner for running chats.** Settings › Appearance has a new "Running indicator" option. A running chat in the sidebar can show a spinner instead of the breathing dot.
- **Smart titles work with models that always think.** Some models keep thinking even when asked not to, for example DeepSeek through Magpie. Their thinking used up the space meant for the title, so the chat quietly kept the start of your message as its name. These models now get a proper title too.
- **`/` commands in the side chat.** Typing `/` in the side chat never opened the command menu. It now opens, even before your first message. A new side chat tab also puts the cursor in its input box, so you can start typing right away. Plan mode is only available in the main chat, so `/plan` is no longer listed in side chats and sub-agents.
- **No more "read the file first" after a restart.** When a chat carried on after Plume restarted, editing a file it had just read was refused until it read the file again. Files it has read are now remembered across restarts. A file that changed after it was read still has to be read again.
- **Smaller fixes.** With the frosted grain on, the side chat now has the same grain as the main chat. In dark mode, the top edge of glass panels no longer looks thicker than the other edges. On macOS, dialogs and settings close normally again after the window is brought back from the Dock by another window.

<!-- plume:notes zh-CN -->
### 改动

- **设置盖在当前界面上打开，关掉就回到原处。** 原来打开设置会离开正在看的对话、插件市场或插件页面，关掉后还得自己找回去。现在设置是盖在当前界面上的一张大卡片，背后的界面柔和地糊开。按 Esc、点卡片外面或点关闭，就回到原来的地方；在设置里打开会话、去别的界面时，它也会自己收起。章名放在顶上的面包屑里；每一页设置项下的说明文字都一样大，插件加的分区也一样。
- **环境卡片更整齐了。** 原来卡片里每个插件各画一层小标题、各用一种行，宽窗口下还会停靠成一列、把对话挤到一边。现在卡片总是浮在右上角，不挤对话。内容按用途分块：顶上是目录和会话摘要，然后是「后台」（在跑的命令、监视、检查和定时任务）、「产出」（批准的计划、子会话、开出来的新会话和当前分支的拉取请求）、引用，压缩记录在最下面。每一行都是同一个样子。在卡片上右键选显示哪些内容。还没开始的新会话建议只留在对话里，不再点亮环境开关。
- **在跑的会话可以用转圈表示。** 设置 › 外观新增「运行指示」，侧栏里正在运行的会话可以用转圈代替呼吸点。
- **关不掉思考的模型也能起好标题。** 有的模型叫它别思考也照样想，比如经 Magpie 用的 DeepSeek。思考占掉了留给标题的篇幅，会话就悄悄沿用消息开头当名字。现在这些模型也能起出正经的标题。
- **侧边聊天能用 `/` 命令了。** 原来在侧边聊天里敲 `/` 不会弹出命令菜单，现在能弹，第一句之前就能用。新开的侧边聊天标签，光标直接落在输入框里，打开就能打字。计划模式只在主会话里用，侧边聊天和子 Agent 的菜单里不再列出 `/plan`。
- **重开 Plume 后不再被要求先重读文件。** 原来 Plume 重开以后接着跑的会话，改它刚读过的文件会被拦下，要它再读一遍。现在读过哪些文件重开后还记得；读完以后被改过的文件，仍然要重新读。
- **几处小修。** 开了磨砂时，侧边聊天也有和主会话一样的颗粒。深色下玻璃浮层的顶边不再比另外三边粗。macOS 上窗口被别的窗口从程序坞里拿出来后，对话框和设置又能正常关掉了。

## [0.7.6] - 2026-11-20

<!-- plume:notes en -->
### Changes

- **The side chat works like the main input box while it's replying.** While the side chat was answering, its input box only had a stop button, and `/` commands didn't work there. Now Return steers the current turn: the model reads your message after the step it's on. ⌘Return queues the message to send after the turn finishes. With the input box empty, the button stops the reply. Messages the model hasn't read yet are listed in the strip above the input box. From there you can send a queued message now, take it back into the input box, or delete it. Queued messages aren't kept after a restart. Typing `/` opens the command menu, and commands apply to that side chat; `/clear` and `/btw` aren't listed.
- **Unread dot on side chat tabs.** When a side chat finishes replying in a background tab, or while the panel is collapsed, a small dot lights up on its tab icon. It goes away once you switch to that tab.
- **Split view shows which side has focus.** Before, only the title bar of the other side was dimmed, so the two sides looked almost the same. Now the whole side without focus is dimmed, and clicking it moves focus there as usual.
- **No more flicker when sending in the side chat.** The send button no longer dims for a moment before turning into the stop button. When you send the first message in a new side chat, the input box no longer fades out, and the model you picked stays shown.

<!-- plume:notes zh-CN -->
### 改动

- **侧边聊天在回复时，输入框也能像主输入框那样用。** 原来侧边聊天回答时输入框只有停止键，也用不了 `/` 命令。现在按回车是插话：模型做完手上这一步就会读到。按 ⌘回车是排队：等这一轮结束再发。输入框空着时，按钮是停止键。模型还没读到的话会列在输入框上方那一条里，排着的可以现在就发、撤回到输入框，或者删掉。排着的话重开应用后不保留。输入 `/` 会弹出命令菜单，命令作用于这段侧边聊天；菜单里没有 `/clear` 和 `/btw`。
- **侧边聊天标签亮未读点。** 侧边聊天在后台标签里，或面板收起时回复完，它的标签图标上会亮一个小点，切过去就灭。
- **分屏时看得出焦点在哪一屏。** 原来只有焦点不在的那一屏标题栏淡一点，两屏看起来差不多。现在焦点不在的那一屏整屏压淡一档，点它照常换过去。
- **侧边聊天发送时不再闪。** 发送键不会再先暗一下才变成停止键。新开侧边聊天发第一句时，输入框不再整块变淡，选好的模型也不会跳回默认。

## [0.7.5] - 2026-11-20

<!-- plume:notes en -->
### Changes

- **Smooth zoom and full screen on the welcome page (macOS).** On a new chat, double-clicking the title bar to zoom or restore the window, or using the green button to enter or leave full screen, made the greeting and input box jitter, flicker or show a ghost image while the window resized. They now stay in place relative to the window for the whole animation. This applies when the welcome page fills the window without wrapping. In a narrow window, with a full-image background, or when switching full screen from the keyboard or menu, macOS animates as before.
- **Lower memory use while scrolling.** Scroll areas that don't need a fade at their edges no longer keep an extra full-size layer, which saved memory and made scrolling lighter.

<!-- plume:notes zh-CN -->
### 改动

- **欢迎页放大、还原、进出全屏不再抖（macOS）。** 原来在新对话的欢迎页双击顶行放大、还原，或点绿色按钮进出全屏时，问候和输入框会一顿一顿地跳，还会闪一下或出现重影。现在整个动画过程中，它们一直稳稳地待在窗口里该在的位置。欢迎页一屏放得下、不用折行时生效；窗口很窄、背景用了整张图片，或用键盘、菜单切全屏时，仍是系统原来的动画。
- **滚动时更省内存。** 两端不需要渐隐的滚动区不再多挂一层铺满视口的遮罩，省下一块合成缓冲，滚动也更轻。

## [0.7.4] - 2026-11-19

<!-- plume:notes en -->
### Changes

- **Split view for two chats.** The main window used to show one chat at a time. Choose "Open with › Split view" from a chat's menu to open it on the right, next to the current one. Each side has its own title bar, input box and panels. Drag the divider to resize, double-click it to split evenly, and close a side from its title bar. If the window is too narrow, Plume tells you instead of squeezing both in. Split view isn't kept after a restart.
- **The shimmer on running tools is back to how it was.** In the last version, the text of a running tool group stayed still most of the time, then briefly dimmed in a short band. It is a steady highlight sweeping across the text again, so you can tell at a glance what's still running.
- **Sending your first message no longer flickers.** When you sent the first message from a new chat, the input box and the model button blinked for a moment. Now the cursor stays put and the model button keeps showing the model you picked.

<!-- plume:notes zh-CN -->
### 改动

- **主窗口能左右分屏看两段对话。** 原来主窗口一次只能看一段对话。现在在对话菜单里选「打开方式 › 分屏」，它就开在右边，和当前这段并排。每一屏有自己的标题栏、输入框和面板区；中间的分隔条可以拖动调宽度，双击两边各占一半，在标题栏上可以关掉一屏。窗口太窄时会提示放不下，不硬挤成两屏。分屏不跨重启保留。
- **工具在跑时的扫光恢复成原来的样子。** 上个版本里，跑着的工具组标题大半时间不动，只偶尔有一小段字暗一下。现在又是一道亮光一直从字上扫过，一眼就能看出哪些还在跑。
- **在空白页发第一句时不再闪一下。** 原来按回车发出第一句时，输入框和模型按钮会闪一下。现在光标留在原处，模型按钮一直显示你选的那个模型。

## [0.7.3] - 2026-11-19

<!-- plume:notes en -->
### Changes

- **Wider conversations on large screens.** Settings › Appearance has a new "Conversation width" option. The Wide setting lets the conversation and input box grow past 864px, up to 1200px depending on the window width, so tables, code blocks and long commands wrap less.
- **Images in replies open in the image viewer.** Clicking an image in a reply's text used to do nothing. It now opens the viewer, and you can page through the other images in the same reply.
- **The running line says what is running.** While a tool group is collapsed, the line under it names the call in progress. Inside the card, running rows show a spinner and timer, and finished rows are dimmed.
- **Context usage drops right after compaction.** The usage ring and breakdown used to keep showing the pre-compaction numbers until the next reply. They now update as soon as compaction finishes.
- **Compaction keeps what matters.** Summaries keep the conclusions and reasons you were already given (comparisons, recommendations), even after the task changes direction. The summary header no longer carries an outdated task list when a newer one was kept.
- **Plume uses less memory when idle.** Chats you only open to read are no longer kept in memory. The screenshot overlay is only kept ready while a plugin has a global screenshot shortcut. Without one, it closes after each capture, so a capture started from a button takes a moment longer.
- **Smaller fixes.** Checking the same background task's output a few times in a row now shows as one line, not a group. The side chat describes reading or controlling the main chat in plain words instead of showing tool names. The "no model available yet" banner above the input box is gone; the model menu already links to adding a provider.

<!-- plume:notes zh-CN -->
### 改动

- **宽屏下对话可以更宽。** 设置 › 外观新增「对话宽度」，选「宽」后对话和输入框不再卡在 864px，随窗口宽度最宽到 1200px，表格、代码块和长命令少折行。
- **回复里的图片能点开看。** 原来点回复正文里的图片没有反应，现在用看图器打开，同一条回复里的图可以左右翻。
- **运行行说出正在跑的调用。** 工具组收着时，下面那行说出此刻在跑哪一次调用；卡片里在跑的行转圈、计秒，跑完的行淡一档。
- **压缩后上下文用量马上降下来。** 原来压缩完、下一条回复回来之前，圆环和分段还显示压缩前的数，现在压完就更新。
- **压缩留下该留的。** 已经答给你的对比、推荐，摘要里留下结论和依据，任务转向后也不再压成一句；保留的原文里有更新的任务清单时，摘要头不再带那份过时的。
- **空闲时更省内存。** 只是打开看看的对话不再留在内存里。截屏浮层只在有插件注册了截屏快捷键时提前备好；没有快捷键时每次截完就关掉，所以点按钮截屏会稍慢一点。
- **一些小修正。** 连着查看同一个后台任务的输出几次，现在显示为一行，不再套一层组；侧边聊天翻看、控制主会话时用中文说明，不再露出工具名；输入框上方去掉了「还没有可用的模型」提示，模型菜单里本来就有添加供应商的入口。

## [0.7.2] - 2026-11-18

<!-- plume:notes en -->
### Changes

- **Plume shows a start screen while it loads.** The main window used to stay blank until the background process was connected and plugins were ready. Now it shows the Plume logo and a loading bar right away, then switches to the main window. If startup fails, the start screen tells you to restart the app instead of staying empty.
- **Each chat keeps its own panel width.** Dragging the panel area wider in one chat no longer changes the width in your other chats. A chat you haven't resized opens its panel at four tenths of the workspace, and widths are remembered after a restart.
- **Multi-line commands run in the terminal in one go.** "Run in terminal" with a `for` loop or heredoc used to show a continuation prompt for every line and echo the command letter by letter. In shells that support bracketed paste (zsh, recent bash) the whole command now goes in at once and runs as a single command.
- **The terminal keeps up with the shell.** The screen no longer types out output character by character seconds after the shell has moved on. When you reopen a terminal, its last screen appears at once instead of the history scrolling past from the top.
- **On-demand MCP calls are grouped.** When there are many MCP tools and the agent alternates between searching for and calling them, those calls now collapse into one group in the transcript instead of one line each.

<!-- plume:notes zh-CN -->
### 改动

- **启动时先显示启动页。** 原来主窗口要等连上后台、装好插件才有画面，这段时间一片空白。现在一打开就显示 Plume 的标志和加载条，准备好后再进主界面；启动失败时启动页会提示重启应用，不再一直空着。
- **每个对话记自己的面板宽度。** 在一个对话里把面板区拖宽，别的对话不再跟着变。没拖过的对话，面板区第一次打开时占工作区的四成；宽度重启后照旧。
- **多行命令在终端里一次执行。** 「在终端运行」带 `for` 循环或 heredoc 的命令时，原来每行出一个续行提示、一个字一个字地回显。现在在支持括号粘贴的 shell（zsh、新版 bash）里整段一次进去，作为一条命令执行。
- **终端画面跟得上 shell。** 不再出现 shell 早已往下走了、屏幕上还在一个字一个字补输出的情况。重新打开终端时直接看到离开前那一屏，不再看着历史从头往下刷。
- **按需调用的 MCP 工具会合成一组。** MCP 工具多时，Agent 搜一次、调一次交替着用，转录里原来一次一行；现在连着的这些调用合成一组。

## [0.7.1] - 2026-11-17

<!-- plume:notes en -->
### Changes

- **The Marketplace has search.** Plugins, Skills and Connectors each have a search box at the right of the page header, matching names, descriptions, keywords and authors; each tab keeps its own search, and Esc clears it. Installed skills and connectors are filtered too.
- **The Marketplace header is tidier.** "Create plugin" and the other plugin buttons moved from the window's top bar to the page header, the same place as the Skills and Connectors buttons. The top bar now always shows where you are, such as "Marketplace › Skills › name"; clicking the middle part takes you back to the tab you came from, with your filter kept.
- **The sidebar and panel area open and close more smoothly.** Closing is now quicker than opening and eases in and out, so the chat column no longer stops with a jolt at the end. Their contents fade in and out with them instead of being cut off at the edge.
- **"Toggle sidebar" is no longer in the command palette.** Use ⌘B (Ctrl+B on Windows) or the sidebar button in the top bar.
- **The Magpie agent plugin comes with the Magpie plugin.** Magpie plugin 0.1.2 puts it in `~/.plume/plugin-data/plume.magpie/magpie-agent`; add that folder under Settings → Plugins in Magpie. You no longer need to copy it from `integrations/magpie`.

### For plugin authors

- **Marketplace sections receive the search text.** `ExtensionsSectionProps` has a new optional `query`: when your plugin draws an "Installed" list under Skills or Connectors, filter it by this text. Without it, the section works as before.

<!-- plume:notes zh-CN -->
### 改动

- **插件市场能搜索了。** 插件、技能、连接器三类的页头右端各有一个搜索框，按名字、说明、关键词、作者匹配；三类各记各的搜索词，按 Esc 清空。已安装的技能和连接器也一样能筛。
- **插件市场的页头更整齐。** 「创建插件」等插件那一类的按钮，从窗口顶行挪到了页头右端，和技能、连接器的按钮在同一个位置。顶行一直显示你在哪，比如「插件市场 › 技能 › 名字」；点中间那一节回到你点进来的那一类，筛选照旧。
- **侧栏和面板区开合更顺。** 收起比展开快，起步和收尾都放缓，对话那一栏收尾不再顿一下；里面的内容跟着淡入淡出，不再是被边缘直接切掉。
- **命令面板里不再有「开合侧栏」。** 用 ⌘B（Windows 上是 Ctrl+B）或顶行的侧栏开关。
- **Magpie 用的 Agent 插件由「Magpie」插件带来。** Magpie 插件 0.1.2 会把它放在 `~/.plume/plugin-data/plume.magpie/magpie-agent`，在 Magpie 的「设置 → 插件」里添加这个文件夹就行，不用再从 `integrations/magpie` 拷。

### 给插件作者

- **插件市场的分区能拿到搜索词。** `ExtensionsSectionProps` 新增可选的 `query`：你的插件在技能或连接器下画「已安装」列表时，按它筛选。不读它的话，分区和原来一样。

## [0.7.0] - 2026-11-17

<!-- plume:notes en -->
### Changes

- **Chats on a Magpie model can be sent again.** In 0.6.0, sending in a chat on a Magpie model could fail with "NOT NULL constraint failed: spend.cost", because Magpie's prices aren't in the format Plume uses. Plume now ignores those prices and uses reference prices from its own model catalog to record costs; models not in the catalog are recorded without a cost.
- **Magpie now connects through the "Magpie" plugin.** Install "Magpie" from the Marketplace; only then does Magpie list Plume as an agent. Update the Plume agent plugin in Magpie (`integrations/magpie`), then choose a model for Plume again. The old `magpie` entry in `settings.json` is no longer read. The Magpie provider still appears in Settings › Models and can be edited, tested, disabled or removed, and your changes are saved by the plugin. When Magpie picks a model it becomes your default; when you disconnect in Magpie, your previous default comes back unless you've chosen another one in Plume since.
- **Magpie's global instructions and MCP servers come through the same plugin.** Instructions are added as their own section before project instructions. MCP servers show up under Marketplace › Connectors marked "Managed by Magpie", and reconnect as soon as Magpie changes them, without restarting Plume. Disabling the plugin removes them.
- **The model list updates without a restart.** When a plugin adds, changes or removes a provider, or switches your default model, Settings › Models and the model picker update right away.

### For plugin authors

- **Plugins can provide model providers.** SDK 0.7.0 adds `ctx.providers`: `provide({ list, save, remove })` adds the providers your plugin stores to Settings › Models (edits and deletions are handed back to you), `changed()` tells the UI to refresh, and `defaultModel()` / `setDefaultModel()` read and set the default model. Plume validates them, fills in catalog prices, and never writes them to its own settings or exports.
- **Plugins can register MCP servers for an external app.** The built-in MCP plugin offers the `mcp.servers` service: `offer(owner, label, servers)` registers a group of Claude-format `mcpServers`, shown as "Managed by <label>" and reconnected when you offer them again.

<!-- plume:notes zh-CN -->
### 改动

- **用 Magpie 的模型又能发消息了。** 0.6.0 里用 Magpie 的模型发消息，可能报「NOT NULL constraint failed: spend.cost」：Magpie 带的价格不是 Plume 认的格式。现在不用它的价格，花销按 Plume 自己模型目录里的参考价记，目录里没有的模型不记金额。
- **Magpie 改由插件「Magpie」接入。** 先在插件市场装上「Magpie」，Magpie 才会把 Plume 列成可接的 Agent；再在 Magpie 里更新 Plume 的 Agent 插件（`integrations/magpie`），重新给 Plume 选一次模型。`settings.json` 里旧的 `magpie` 那一块不再读。「模型设置」里照样有 Magpie 供应商，能改、测试、停用或删除，改动由插件保存。Magpie 选了模型就设成你的默认模型；在 Magpie 里断开时换回原来的默认模型，你之后在 Plume 里另选过就不动。
- **Magpie 的全局指令和 MCP 服务也经这个插件。** 全局指令作为单独一段，排在项目指令前面；MCP 服务出现在「插件市场 › 连接器」里，标着「由 Magpie 管理」，Magpie 改了当场重连，不用重启 Plume。停用插件，它们就都撤下。
- **模型列表不用重启就会更新。** 插件加上、改动或撤下供应商，或替你换了默认模型时，「模型设置」和模型菜单当场跟着变。

### 给插件作者

- **插件能提供模型供应商。** SDK 0.7.0 新增 `ctx.providers`：`provide({ list, save, remove })` 把你插件存着的供应商放进「模型设置」（人在设置页的改和删交回给你），`changed()` 让界面重新取，`defaultModel()` / `setDefaultModel()` 读、设默认模型。Plume 照常校验、按模型目录补价格，不写进自己的设置，也不导出。
- **插件能替外部应用登记 MCP 服务。** 内置的 MCP 插件开放服务 `mcp.servers`：`offer(owner, label, servers)` 登记一组 Claude 格式的 `mcpServers`，连接器页标「由 <label> 管理」，再登记一次就当场重连。

## [0.6.0] - 2026-11-17

<!-- plume:notes en -->
### Changes

- **Deleting a chat cleans up what it left behind.** Worktrees, chat branches, panel tabs, drafts and attachments now go with the chat, along with images and thumbnails no other chat still uses; running chats are stopped with their sub-agents and background commands before deletion.
- **Each chat remembers its panel area.** Switching chats or restarting Plume now restores whether that chat's panel area was open, instead of sharing one open/closed setting across the window.
- **New chats start on your default model.** A temporary model choice in one chat no longer carries over to the next new chat, including after switching projects or using `/clear`.
- **Magpie providers can be edited in Plume.** You can now change their connection, key and models, test them, disable them or remove them; a later Magpie sync will still replace the connection, key and model list.
- **Panel transitions no longer end with a jump in text width.** Chat text follows the conversation column throughout opening and closing, while finished rounds outside the viewport skip layout and painting to keep long chats responsive.
- **Long code and diffs are smoother to expand and collapse.** Highlighting is reused and applied to visible sections instead of rebuilding the entire block, so repeated toggles during a reply do less work without dropping the last lines or their highlighting.
- **Background notifications have room to breathe.** Adjacent notifications delivered in the same record now have spacing between them, without changing the gaps around single notifications or tool summaries.
- **Unreadable key files no longer erase saved keys.** Plume reports a key-store read failure instead of treating it as an empty store, and MCP call cards hide secret values in command arguments and environment variables.
- **Search asks before returning secret-file contents.** Approving a folder no longer silently approves grep results from private keys and credential files inside it, while glob now distinguishes a missing folder from an empty result.
- **Web pages and terminal paths work in more cases.** Reading a page follows same-site redirects between bare and `www` hosts or from HTTP to HTTPS, older page encodings are recognized, and files dropped into a terminal are quoted for that tab's shell, including PowerShell and cmd.

### For plugin authors

- **Settings and live state have shared host APIs.** SDK 0.6.0 adds `ctx.settings`, `ctx.store` and `ctx.sessionStore`, with matching UI subscriptions, so plugins no longer need their own settings files or state-push loops; session state is removed with its chat, and values loaded only for display are released after the last subscriber leaves.
- **Plugin builds are easier to share and diagnose.** `plume-plugin pack` produces a folder for local upload, builds record their SDK version for load-error messages, and plugin logs and window warnings are collected in Plume's rotating log file.

<!-- plume:notes zh-CN -->
### 改动

- **删对话时，留下的东西一起清理。** 工作树、会话分支、面板标签、草稿和附件现在随对话一起删除，没有其他对话再用到的图片和缩略图也会清掉；还在运行的对话会先停下子 Agent 和后台命令，再删除。
- **每个对话各记各的面板区开合。** 切回对话或重启 Plume 后，面板区会恢复这个对话上次开着或收着的状态，不再整个窗口共用一份。
- **新对话回到默认模型。** 在某个对话里临时换的模型不再被下一个新对话沿用，切换项目或执行 `/clear` 后也用设置里的默认模型。
- **Magpie 接管的供应商可以直接改。** 在 Plume 里就能改连接、密钥和模型，测试、停用或删除；Magpie 再次同步时，仍会覆盖连接、密钥和模型列表。
- **面板收起时，正文不再到最后才突然变宽。** 对话文字在整个开合过程中跟随栏宽排版，已经结束且滚出屏幕的轮仍跳过布局和绘制，减少长对话的排版开销。
- **长代码和 diff 收放更顺。** 高亮结果会复用，只给可见部分上色，不再每次收放都重建整段高亮，回复还在生成时反复展开也能看全末行和高亮。
- **一起送达的后台通知不再挤成一团。** 同一条记录里的相邻通知之间补上间距，单条通知和上下工具摘要的间距保持不变。
- **密钥文件读不到时，不再把已存密钥写空。** 读取密钥库失败会直接报错，不再当作空库保存，MCP 调用卡片里的命令参数和环境变量也会遮住密钥值。
- **搜索命中密钥文件时会单独问你。** 批准过一个目录，不再意味着里面的私钥和凭据内容也能直接出现在 grep 结果里，glob 遇到不存在的目录也会明确提示，不再混作没有匹配。
- **读网页和往终端拖文件少些意外。** 网页读取能跟随同站点有无 `www`、HTTP 升 HTTPS 的跳转，并识别老网页的编码；拖进终端的路径按该标签实际使用的 shell 加引号，PowerShell 和 cmd 也能正确处理。

### 给插件作者

- **设置和实时状态由本体统一管理。** SDK 0.6.0 提供 `ctx.settings`、`ctx.store`、`ctx.sessionStore` 及对应的界面订阅，不必再自己写设置文件和推送循环；会话状态随对话删除，只为显示而加载的值在最后一个订阅者离开后释放。
- **构建结果更容易分享，加载失败也更好排查。** `plume-plugin pack` 可以打出供本地上传的文件夹，构建会记下 SDK 版本并在加载失败时提示，插件日志和窗口告警统一写进 Plume 的轮转日志。

## [0.5.6] - 2026-11-16

<!-- plume:notes en -->
### Changes

- **Pick a model when you start a new chat from a card.** When the assistant asked whether to take something to a new chat, or the side chat handed work off, the new chat always started on your default model and you had to change it afterwards. Both cards now let you choose the model and thinking level right next to "New chat". The side chat's hand-off card is now a simple list of destinations (hand to the main chat, new chat, do it here); click a row to send it there.
- **"Approve for me" asks less.** Looking at another project, checking a config file on your Mac, or saving a result to the Desktop all used to need a click, so it was easy to start approving without reading. Now reading anywhere is allowed except secret files like API keys, SSH keys and cloud credentials, and writing outside the project only asks for system folders, key folders, shell startup files and Plume's own data folder.
- **Changing Plume's own settings always asks you.** Edits to `~/.plume` (settings, permissions, plugins, chats) used to be refused outright, so the assistant could never change a setting for you, and in Full access it could still slip a shell command past. Now every such change asks you first, in every mode, with no "don't ask again". In Full access, a shell command that plainly writes there asks before it runs.
- **Files outside the chat folder open in the file panel.** If the assistant saved a file somewhere else, like your Desktop, clicking its link in the reply said it couldn't be read. Any file on your Mac now opens read-only in the file panel, with buttons to open it in its default app or show it in Finder.
- **Smoother sidebar and panel animations.** With the browser panel open and a long chat, opening or closing the sidebar or the panel area stuttered because the whole conversation was re-laid out on every frame. The text now slides and is laid out only at the start and end, and if you had scrolled up, the line you were reading stays put.
- **`/review` stays in your chat.** Code review used to open a separate "Review · …" chat in the sidebar that wrote back and forth with yours. It now sends review sub-agents from the chat you're in, lists every finding as they wrote it, and that chat decides what to fix and fixes it. Update the Review plugin from the Plugin Market to get this.

<!-- plume:notes zh-CN -->
### 改动

- **从卡片开新会话时能选模型了。** 助手问要不要另开会话、侧边聊天把事交出去时，开出来的会话总用默认模型，想换只能开出来再改。现在两张卡上「开新会话」旁边就能选模型和思考档位。侧边聊天的交出卡改成一列去处：交给主会话、开新会话、在这里做，点哪一行就交到哪。
- **「帮我批准」问得少了。** 看一眼别的项目、查一下本机的配置、把结果存到桌面，原来都要人点，点多了就容易不看就点。现在读哪里都不问，只有 API key、SSH 私钥、云凭据这类密钥文件要批准；写项目外的地方只在系统目录、钥匙目录、shell 启动文件和 Plume 自己的数据目录时才问。
- **改 Plume 自己的设置，每次都问你。** 原来改 `~/.plume`（设置、权限、插件、会话）一律拒绝，想让助手帮你改个设置做不到，完全访问下它却能用命令绕过去写。现在任何权限下改这里都先问你，也没有「以后不再问」；完全访问下，命令里写明要改这里的，跑之前先问。
- **会话目录外的文件也能在文件面板里打开。** 助手把文件存到桌面这类别处时，点回复里的链接只提示「读不到」，像是文件不存在。现在本机任何文件都能在文件面板里只读打开，顶上还能用默认应用打开、在访达中显示。
- **侧栏和面板区开合更顺了。** 开着浏览器面板、对话又长时，开合侧栏或面板区会卡，因为每一帧都要把整段对话重新排一遍。现在正文只跟着平移，开头和结尾各排一次；滚上去读着的那一行也留在原处。
- **`/review` 就在当前对话里审。** 原来代码审阅会在侧栏另开一个「审阅 · …」会话，和你的对话来回写信。现在由你正在用的对话派审阅子智能体，发现照它们写的原样列出来，由这个对话决定修哪几条、自己修。去插件市场把「代码审阅」插件更新一下就能用上。

## [0.5.5] - 2026-11-16

<!-- plume:notes en -->
### Changes

- **The task panel shows only what's running in the background.** It used to mix background work with the to-do list and a log of every tool run, which was hard to read. Now called "Background jobs", it lists background commands and sub-agents together in Running and Finished groups, one card each. A running card shows how long it has been going and a stop button; click a sub-agent's card to open it. Tool runs are still in the call trace, and the to-do list stays above the input box.
- **The sidebar no longer says a chat is done while it's still waiting.** When a turn ended but a sub-agent or background command hadn't come back yet, the chat was marked done, then started running again once the result arrived. It now keeps showing as running ("Waiting on background work" on hover) until everything is back.
- **No warning the moment you send a message.** The "waiting" hint used to appear right away, even though a short wait before the first word is normal. Now nothing shows until the model has been silent for 15 seconds, and then the hint appears in a warning color.
- **Plugin Market moved up in the activity bar.** It now sits right under Chats instead of at the bottom with Search, Notifications and Settings. Number badges on the bar are no longer cut off on the right.
- **Cards that start a new chat look alike.** The card suggesting a new chat and the side chat's hand-off card now share one layout, with the main button last. The card asking whether to start a new chat, above the input box, has the same buttons as approval cards.

### For plugin authors

- New: a code block's `send(text, event, displayText?)` takes an optional third argument. The model gets the full text and the user's bubble shows `displayText`, the same as on tool cards.
- New: the UI service `subagents.tasks` (provided by plume.subagents) lists a chat's sub-agents with `watch`, and can `open` or `stop` one.
- New: `proposal` in `@plume/styles`, for cards that wait in the transcript for a click.

<!-- plume:notes zh-CN -->
### 改动

- **任务面板只放后台在跑的事。** 原来后台任务、待办清单和每次工具调用的记录挤在一起，读着很乱。现在它叫「后台任务」，后台命令和子 Agent 列在一起，分「运行中」「已结束」两组，一项一张卡片。还在跑的写着跑了多久，能直接停下；点子 Agent 的卡片就打开它。工具调用的记录在调用轨迹里看，待办清单还在输入框上方。
- **会话还在等结果时，侧栏不再说它做完了。** 一轮停下、子 Agent 或后台命令还没回来时，侧栏先亮「已完成」，结果回来又跑起来。现在它一直显示在跑（悬停写「等待后台任务」），全都回来了才算完。
- **消息一发出去不再马上提示在等。** 第一个字到之前等一会儿本来正常，原来却立刻挂上「静候回音」。现在模型满 15 秒没出声才提示，一出来就是警示色。
- **插件市场在活动栏里往上挪了。** 紧挨在「对话」下面，不再和搜索、通知、设置挤在底部；活动栏上的数字角标也不再被切掉右边一截。
- **能开新会话的几张卡长得一样了。** 建议新会话的卡和侧边聊天交出去的卡用同一种排法，主按钮在最后；输入框上方问要不要另开会话的那张卡，按钮和审批卡一样。

### 给插件作者

- 新增：回复里代码块的 `send(text, event, displayText?)` 可以给第三个参数。模型收到全文，用户气泡里显示 `displayText`，和工具卡片一样。
- 新增：界面服务 `subagents.tasks`（由 plume.subagents 提供），用 `watch` 拿到一个会话的子 Agent，能 `open` 打开、`stop` 停下其中一个。
- 新增：`@plume/styles` 的 `proposal`，给转录里等人点的卡片用。

## [0.5.4] - 2026-11-15

<!-- plume:notes en -->
### Changes

- **Command rows say what they're for.** Some models never added a short description when running a shell command, so the chat showed only the raw command, and checking on a background command just said "Read output" without saying which one. The assistant is now asked for a description every time, and if one is still missing, the "Read output" row names the command it's checking.

<!-- plume:notes zh-CN -->
### 改动

- **命令那一行说清在做什么。** 有的模型跑命令时从不写一句说明，对话里只剩命令原文；查看后台命令的进度时只写「查看输出」，看不出查的是哪一个。现在每次都要求模型写说明；万一还是没写，「查看输出」那一行会带上它查的那条命令。

## [0.5.3] - 2026-11-15

<!-- plume:notes en -->
### Changes

- **A new activity bar on the far left.** Plugin pages, the Plugin Market and Settings no longer share one sidebar with your chats; they open from a narrow bar at the left edge of the window.
- **You can edit the built-in identity and guidelines.** Open them in a dialog, change them, and restore the defaults any time. In Settings you can also pick which identity and guidelines new chats start with.
- **Calmer dialogs and page headers.** Dialog buttons now sit on the right instead of crowding the left, and the header of a plugin page no longer drags the window around when you press on it.
- **Smoother chat switching.** The area under the title bar no longer flashes bright and then dims when you switch chats, and the "waiting" hints while a reply is on its way read more clearly.

### For plugin authors

- Removed: the `topRow` option of `ui.page` and the `start` prop of `PageTopRow`.
- New: `ui.usePageToolbar(items)` puts your own icon buttons at the top-left of the window, right after Back and Forward.
- New: a logic entry can look up the projects the user has registered, and receives the assistant's reply as a draft while it is being generated.

<!-- plume:notes zh-CN -->
### 改动

- **窗口最左边多了一列活动栏。** 插件的页面、插件市场、设置不再和会话挤在同一根侧栏里，从窗口左边这条窄栏打开。
- **内置的身份与准则能直接改了。** 在弹窗里查看和编辑，随时可以恢复默认；设置里还能选新会话用哪一套身份和准则。
- **对话框和页面栏头更顺手。** 对话框底下的按钮靠右排，不再挤在左边；插件页面的栏头按住也不会再拖着窗口走。
- **切换会话更稳。** 标题栏底下的内容不再先亮一下再暗下去，等回复时的提示也说得更清楚。

### 给插件作者

- 删掉了 `ui.page` 的 `topRow` 和 `PageTopRow` 的 `start`。
- 新增 `ui.usePageToolbar(items)`：在窗口左上角、后退和前进后面放自己的图标按钮。
- 新增：逻辑入口能查到用户登记过的项目，也能在助理回复生成的过程中收到草稿。

## [0.5.2] - 2026-11-15

<!-- plume:notes en -->
### Changes

- **A plugin can look after your chats for you, if you let it.** Turn on "Let it manage sessions" on a plugin's page in the Plugin Market (you confirm once, and can turn it off any time). That plugin can then send instructions into your chats, answer the approval and question cards they're waiting on, and stop a running turn. Every answer it gives is marked "Answered by …" under the call. Only one plugin holds this at a time, and a project's config can't turn it on.
- **Plugins can ask you to pick a folder.** A plugin that needs a folder, such as an assistant's working folder, now opens the system folder picker, where you can also create a new folder.

### For plugin authors

Rebuild with SDK 0.5.2:

- Removed: `ui.screen.pickDirectory`. Use `ui.pickFolder(title?)` instead; it returns the absolute path, or `null` if the user cancels.
- New: `manage: "sessions"` on a plugin asks to manage the user's chats. Once the user turns it on, `ctx.sessions.post`, `respond`, `answer` and `stop` work on every top-level chat no other plugin stewards, and `observe` sees them. `ctx.sessions.approval(sessionId)` reads the card a chat is waiting on right now.

<!-- plume:notes zh-CN -->
### 改动

- **插件能替你照看会话，前提是你允许。** 在插件市场里点开一个插件，打开「让它管理会话」（会先确认一次，随时可以关掉）。这个插件就能往你的会话里交代事情、答它们弹着的审批卡和提问卡、停下正在跑的一轮。它答的每一张卡，调用底下都写着「由 … 代答」。同一时间只有一个插件拿着这份授权，项目配置打不开它。
- **插件能让你选文件夹。** 插件要一个文件夹时（比如助理的工作文件夹），会弹出系统的选文件夹对话框，也能当场新建一个。

### 给插件作者

请用 SDK 0.5.2 重新构建：

- 删掉了 `ui.screen.pickDirectory`，改用 `ui.pickFolder(title?)`：交回绝对路径，人取消时是 `null`。
- 新增：插件声明 `manage: "sessions"`，申请管理人的会话。人打开以后，`ctx.sessions.post`、`respond`、`answer`、`stop` 对所有没被别的插件代管的顶层会话都能用，`observe` 也看得到它们。`ctx.sessions.approval(sessionId)` 现读会话弹着的那张卡。

## [0.5.1] - 2026-11-15

<!-- plume:notes en -->
### Changes

- **The terminal comes with the app.** "Open in the terminal" in the file tree and "Run it in the terminal" on code blocks used to ask you to install the terminal plugin first. The terminal is now built in, so both work out of the box. If you installed it from the marketplace, the built-in one takes its place.
- **Auto approve is stricter in a few places.** With your home folder (`~`) open as a project, writing `~/.zshrc` or a file under `~/.ssh` now asks you first, the same as doing it with a shell command. A plugin tool named something like `command` or `create` is no longer waved through as if it were a harmless command or a new file. And a plugin can no longer change what a permission card says, or turn your "No" into a yes, when the agent asks to leave the sandbox.
- **Long chats keep what the model just read.** When a conversation outgrew the model's context, large tool results, often the file it had just opened, were cut down to one line before anything older was summarised. Now the history is compacted first, and results are only cut if that still isn't enough. Compaction also stops dropping a test or build run as a "duplicate" when its output had changed, so the error that prompted a fix stays in the summary.
- **Fixes.** A new side chat uses the default model you saved for it again. After restarting the app, the context usage popover is broken down by part again instead of showing a single "Last request" line. The last words of a reply no longer flicker away and back as the turn ends, and the page no longer jolts while tool rows stream in at the bottom.

### For plugin authors

Rebuild with SDK 0.5.1:

- `ui.remote()` methods must have a fixed number of parameters. A method with optional or rest parameters is now a type error on the remote proxy, because the caller's `CallContext` would land in the missing argument. Write values that may be absent as `x: T | undefined` and pass `undefined`.
- New: `ctx.sessions.configure(id, { model?, thinking?, project?, cwd? })` changes the model, thinking level and working folder of a session your plugin created. `ResizeHandle` from `@plume/ui` lets a plugin page have draggable column edges.

<!-- plume:notes zh-CN -->
### 改动

- **终端随应用一起装好。** 文件树里的「在终端中打开」、代码块上的「在终端运行」，以前要先去市场装终端插件。现在终端是内置的，装好就能用；从市场装过的那份由内置的顶替。
- **帮我批准在几处收紧了。** 把主目录（`~`）当项目打开时，写 `~/.zshrc` 或 `~/.ssh` 下的文件会先问你，和用命令写一样。叫 `command`、`create` 这类名字的插件工具，不会再被当成普通命令或新建文件直接放行。agent 申请离开沙箱时，插件不能再改审批卡上写的内容，也不能把你点的「拒绝」翻成放行。
- **长对话不再剪掉模型刚读到的东西。** 以前对话超出模型的上下文时，会先把大的工具结果剪成一行（往往是刚打开的那个文件），再去总结更早的历史。现在先压缩历史，还放不下才剪。压缩时也不再把输出变了的测试、构建当成「重复」清掉，引出这次修改的那段报错会留在摘要里。
- **修好的几处。** 新开的侧边聊天重新用上你给它存的默认模型。重开应用后，上下文用量照样按各部分分开列，不再只剩「上一次请求」一行。一轮收尾时回复最后几个字不再闪一下；贴着底部看工具行一行行进来时，页面不再一顶一停。

### 给插件作者

请用 SDK 0.5.1 重新构建：

- `ui.remote()` 调的方法参数个数要写死。带可选参数或剩余参数的方法，在远端代理上调用会报类型错误：调用方少传一个参数时，`CallContext` 会落进那个参数里。可能不传的值写成 `x: T | undefined`，调用时传 `undefined`。
- 新增：`ctx.sessions.configure(id, { model?, thinking?, project?, cwd? })`，改插件自己建的会话的模型、思考档位和工作目录；`@plume/ui` 的 `ResizeHandle`，插件页面的栏能拖动改宽度。

## [0.5.0] - 2026-11-15

<!-- plume:notes en -->
### Changes

- **Enter now steers the turn that's running; ⌘Enter queues after it.** Before, anything you typed while the agent worked waited for the whole turn to finish. Now Enter slips your message in: the model reads it after its current step, without being interrupted. Until then it sits at the top of the queue above the input, where you can take it back, and stopping the turn keeps it rather than throwing it away. ⌘Enter (Ctrl+Enter on Windows) still waits for the turn to end.
- **The agent can hand work to a separate chat.** When you bring up an unrelated task, it can ask whether to open a new chat for it, open one right away when you ask, or leave a suggestion card you can start later with your own choice of model. A chat started this way reports back to the one it came from after each turn. Chats now message each other one way, and each sent message shows whether it was delivered and replied to.
- **You can tell when the model is stuck.** The line under a running turn used to look busy even when nothing was arriving. It now says whether it's waiting for the first word or has gone quiet for N seconds, turning yellow after 15 seconds. While text is arriving it shows the tokens written, the speed and a small live trace.
- **Tool calls are easier to follow.** A group of calls is titled by everything it did and counts up while it runs. Each row has its icon back. Rows for checks, scheduled tasks and polling follow what the background work is doing, and schedules read in plain words ("Every 5 minutes").
- **A question you skip or that times out no longer shows as a red failure.** It's marked "Cancelled" or "Unanswered".
- **Smoother and lighter.** Opening and closing the sidebar or panels no longer jumps or stutters. Expanding or collapsing a group of tool calls keeps the row you clicked in place. Dismissed notices slide away. Spinners and glows step on a shared beat instead of redrawing every frame, so a running chat costs much less CPU.
- **Fixes.** Switching the app language updates the conversation right away. Right-clicking or opening a menu while a reply is streaming no longer stops it following to the bottom. The token count no longer drops at the end of each step. A chat forked from another no longer offers that chat's suggestions a second time.

### For plugin authors

Breaking changes; rebuild with SDK 0.5.0:

- Messages between chats are one way. `LetterInput` is `from`, `text` and optional `guide`; `request`, `answer`, `re` and `recipient` are gone, and so are `LetterReceipt.answer` and `answered`. `LetterReceipt.queued` says whether the message waits for the recipient's next step.
- `LaunchedSession.reportBack(text, delivery)` is now `ctx.sessions.reportBack(sessionId, text, options)` with `ReportBackOptions` (`delivery`, `frame`, `wake`), so a chat you started can report back on every turn, including after a restart.

New: `SessionLaunch.fork` and `spawnedFrom.name`; `UnansweredDetails` on a tool result marks it "Cancelled" or "Unanswered" rather than failed; `ToolLine.verbFor`, `ToolLine.fields` (`ToolField`) and a `details` argument for `ToolLine.subject`; `SessionView.backgroundCalls` (`BackgroundCallState`); `QueuedMessage.steered` and `AgentService.steerQueued`.

<!-- plume:notes zh-CN -->
### 改动

- **跑着的时候按回车是插话，⌘回车排到这一轮之后。** 以前 agent 干活时打的话都要等整轮做完。现在回车把话插进正在跑的这一轮，模型做完手上这一步就读到，不打断它。读到之前它排在输入框上方那条队的最前面，可以撤回；按停也不会把它吞掉。⌘回车（Windows 上 Ctrl+回车）照旧等这一轮做完再发。
- **agent 能把事交给另一个会话去做。** 你提了一件和手上无关的事时，它可以先问你要不要另开会话；你明说要单开时当场开；它自己发现的事只留一张建议卡，你挑好模型再点开始。开出来的会话每做完一轮都会向原对话汇报。会话之间改成单向发消息，发出的那一行写着送到没有、回了没有。
- **模型卡住时看得出来。** 以前一个字没回，运行行照样转得很忙。现在它会直说是在等第一个字，还是已经几秒没有新输出，过了 15 秒变黄；字在来时显示这一轮写了多少 token、多快，和一条跟着字跳动的小心电图。
- **工具调用更好读。** 几次调用合成的一组，标题说的是这一组做了什么，跑着时数字跟着长；每一行前面的图标回来了。检查、定时任务、轮询那几行跟着后台的实际状态走，频率写成人话（「每 5 分钟」）。
- **提问卡没答、到时没人答时，不再标红成「失败」。** 改标「已取消」「没人回答」。
- **更顺、更省。** 侧栏、面板开合不再跳、不再卡；点开、收起一组工具调用时，点的那一行留在原处；关掉的提示条滑走。转圈、扫光改成跟着同一个节拍走，不再每帧重画，有会话在跑时 CPU 占用低了不少。
- **修好的几处。** 切换界面语言后对话里的字当场换过来；回复写着时右键、打开菜单不再让它停止跟随到底部；token 数不再在每一步收尾时往回跳；从别的会话分出来的会话，不会再把原对话的建议卡开第二次。

### 给插件作者

有不兼容的改动，请用 SDK 0.5.0 重新构建：

- 会话之间的信改成单向：`LetterInput` 只有 `from`、`text` 和可选的 `guide`，删掉 `request`、`answer`、`re`、`recipient`，`LetterReceipt` 删掉 `answer`、`answered`。新增 `LetterReceipt.queued`，说明这封信是不是要等收件方下一步才读到。
- `LaunchedSession.reportBack(text, delivery)` 改成 `ctx.sessions.reportBack(sessionId, text, options)`，选项是 `ReportBackOptions`（`delivery`、`frame`、`wake`）：开出来的会话每一轮都能交回，重开应用后也一样。

新增：`SessionLaunch.fork`、`spawnedFrom.name`；工具结果带 `UnansweredDetails` 时画成「已取消」「没人回答」，不算失败；`ToolLine.verbFor`、`ToolLine.fields`（`ToolField`），`ToolLine.subject` 多了 `details` 参数；`SessionView.backgroundCalls`（`BackgroundCallState`）；`QueuedMessage.steered`、`AgentService.steerQueued`。

## [0.4.0] - 2026-11-14

<!-- plume:notes en -->
### Changes

- **Tool calls now sit together in an expandable card.** Consecutive calls share a heading that shows the current action while running and a summary when done; expand it to see each call, its output or file diff, with failures marked even when the group is collapsed.
- **File links only become file chips when the file exists on this machine.** Paths from a remote server or files that haven't been created stay as text, and remembered lookups keep existing files from repeatedly switching from text to chips when you reopen a conversation.

<!-- plume:notes zh-CN -->
### 改动

- **连着做的工具调用放进同一张卡片。** 标题在执行时说正在做什么，结束后汇总做过的事，点开后一次调用一行，再点开看输出或文件差异，组内有失败时收起也看得见。
- **文件在本机找到了，回复里才画成文件签。** 远程服务器上的路径、还没创建的文件保持原来的文字，查找结果会记住，重新打开会话时不再反复从文字跳成文件签。

## [0.3.0] - 2026-11-14

<!-- plume:notes en -->
### Changes

- **In Full access, the model looks things up instead of guessing.** The system prompt used to say that reading or writing outside the workspace needs approval, even in Full access where it doesn't. Models took that as off-limits and guessed instead, for example picking a server by hand rather than reading `~/.ssh/config`. In Full access the prompt now says the whole machine can be read and written without asking; in the other modes it adds that needing approval is no reason to guess.
- **The "+/-" diff markers now cover expanded tool cards too.** With Settings › Appearance › Diff markers set to "+/-", only the Git panel used symbols; the diffs inside expanded tool cards and in plugins were still told apart by red and green alone. They now mark added and removed lines with + and − as well.
- **Run diagnostics show which plugins a call went through.** The call trace details list every plugin hooked into a tool call or model request, from outside in: whether each one passed it on, changed the input or result, answered on its own or failed, and whether Plume itself ran the call in the end.
- **A plugin's details show the services it provides.** When two plugins provide a service with the same name, the details say which one is in effect and which it replaced, so you can tell which plugin changed a built-in behaviour.
- The model list bundled for first launch and offline use is up to date.

### For plugin authors

Breaking changes to `UiContext`; rebuild with SDK 0.3.0:

- `ui.approvalCard` is gone: the approval card is Plume's own. Cards for `run.request` still go through `ui.requestCard`.
- `ui.openMediaFile`, `ui.revealMediaFile` and `ui.revealMediaLabel` are gone. Open or reveal a saved image with `ui.openFile` / `ui.revealPath` and the path `ctx.media.save` returned.
- `ui.stopSession` is gone, and `ui.ComposerSend` takes `sessionId` instead of `onStop`: Plume stops that session when the person presses the button.
- The `@` menu's agent entries now have `kind: "agent"` (was `"subagent"`).

New: `PluginStatus.provides` (`ProvidedService`), and `hooks` events (`HookTrace`) in `ctx.sessions.observe`.

<!-- plume:notes zh-CN -->
### 改动

- **完全访问下，模型会去本机查，不再瞎猜。** 以前系统提示词不分权限档，一律说读写工作区以外要批准，完全访问下其实不用。模型把这句当成禁区，宁可猜：比如要连服务器时不去读 `~/.ssh/config`，而是让你从几台机器里挑。现在完全访问下提示词说本机哪里都能直接读写；其他档位补了一句：要批准不是改用猜的理由。
- **「+/-」差异标记也管工具卡片里的 diff 了。** 设置 › 外观 › 差异标记选「+/-」后，以前只有 Git 面板换成符号，工具卡片展开后的 diff 和插件画的 diff 还是只靠红绿区分。现在也用 + 和 − 标出增删的行。
- **运行诊断里看得到一次调用经过了哪些插件。** 调用轨迹的详情里，从外到内列出挂在这次工具调用或模型请求上的插件：每个是往里交了、改了参数或结果、自己给了结果还是出错，最后 Plume 本身有没有执行。
- **插件详情写出它提供哪些服务。** 两个插件提供同名服务时，详情里写明哪个在生效、替换了谁，装了插件后内置的某样行为变了，看得出是谁换的。
- 首次启动和离线时用的模型列表更新到了最新。

### 给插件作者

`UiContext` 有不兼容的改动，请用 SDK 0.3.0 重新构建：

- 删掉 `ui.approvalCard`：审批卡只有 Plume 自己的一张。`run.request` 的卡照旧经 `ui.requestCard` 画。
- 删掉 `ui.openMediaFile`、`ui.revealMediaFile`、`ui.revealMediaLabel`。打开、指出存好的图用 `ui.openFile`、`ui.revealPath`，路径取 `ctx.media.save` 交回的那个。
- 删掉 `ui.stopSession`；`ui.ComposerSend` 不再收 `onStop`，改收 `sessionId`，人按下按钮时由 Plume 停下那个会话。
- `@` 菜单里智能体那类的 `kind` 从 `"subagent"` 改成 `"agent"`。

新增：`PluginStatus.provides`（`ProvidedService`），`ctx.sessions.observe` 里的 `hooks` 事件（`HookTrace`）。

## [0.2.1] - 2026-11-13

<!-- plume:notes en -->
### Changes

- **Turning on Full access from Settings asks first.** The "Full access" switch in Settings › General used to turn it on with one click; now it shows the same confirmation as the permission chip. Turning it off still happens right away.
- **The Git panel no longer runs programs set by the repository.** Its automatic refresh and background fetch used to run programs a repository's Git config can name (such as fsmonitor, filters or an external diff) on your machine, even when you hadn't clicked anything. They now run in an isolated copy. Actions you start yourself (commit, push, pull, switch branch) work as before.
- **Disabled plugins really stay off.** A disabled plugin's code used to be loaded at startup anyway; now it isn't loaded until you enable it. Plugins you disabled before this update are enabled once more; disable them again if you still want them off.
- The permission chip catches up as soon as you switch back to Plume after editing a project's `.plume/config.json`.
- Long tool results that were cut short can still be read in full after restarting Plume.
- Conversations using MCP tool search no longer briefly switch back to listing every tool after a restart, which made the model re-read the whole conversation.
- When you stop a turn while a tool is waiting for your answer, the model is no longer told the tool never ran.
- After a plugin is updated or disabled, its panels and other UI no longer linger.
- Screen readers announce "Saved" after saving on the Personalization page.

### For plugin authors

No breaking changes. New: `run.files.spill(tool, content)` saves a truncated result's full text and returns an `artifact://` address that survives restarts (declare it with `SpillDetails`); `ctx.workspace.git(root, work)` reads a repository in an isolated view that doesn't run its configured programs.

<!-- plume:notes zh-CN -->
### 改动

- **在设置里开完全访问也要先确认。** 以前设置 › 常规里的「完全访问」开关一点就打开，现在和输入框的权限签一样，先弹确认框。关掉照旧直接关。
- **Git 面板不再执行仓库配置的程序。** 以前就算你什么都没点，Git 面板自动刷新和后台获取时，也会在你的电脑上执行仓库的 Git 配置指定的程序（比如 fsmonitor、过滤器、外部 diff）。现在这些读取在隔离的副本里做。提交、推送、拉取、切分支这些你自己点的操作照旧。
- **停用的插件真的不再运行。** 以前停用的插件启动时代码照样会被加载，现在要等你启用才加载。这次更新前停用过的插件会重新启用一次，还想关着的话请再停用一下。
- 在编辑器里改了项目的 `.plume/config.json`，切回 Plume 时权限签马上跟上。
- 被截断的长工具结果，重开应用后仍然能读到全文。
- 用了 MCP 工具搜索的会话，重开应用后不会再短暂地变回列出全部工具，模型也就不会因此把整段对话重读一遍。
- 工具在等你回答时按了停，模型不会再被告知那个工具从没运行过。
- 插件更新或停用后，它的面板和别的界面不会再残留。
- 在个性化页保存后，读屏软件会念出「已保存」。

### 给插件作者

没有不兼容的改动。新增：`run.files.spill(tool, content)` 把截断前的全文存下，换回重开应用后仍然有效的 `artifact://` 地址（结果上用 `SpillDetails` 声明）；`ctx.workspace.git(root, work)` 在隔离视图里读仓库，不执行仓库配置的程序。

## [0.2.0] - 2026-11-13

<!-- plume:notes en -->
### Changes

- **A repository can no longer loosen your permissions.** A `.plume/config.json` committed to a repository used to be able to switch you to Full access or pre-approve "Don't ask again" for you, just by being opened. Now it can only make permissions stricter (for example, require approval for every change in that project). Settings it can't apply are listed in the project config card in Settings › General, and you get a notice once in the conversation.
- **The permission chip shows what actually applies.** When a project's config makes permissions stricter than yours, the chip above the input shows the stricter level with a lock icon and says it comes from the project, instead of your own setting.
- **"Don't ask again" can be reviewed and undone.** Settings › General › Permissions lists everything you approved with "Don't ask again"; revoke one or all, and Plume asks again next time. Approvals are remembered per plugin, so another plugin asking for the same thing is asked about separately.
- **Stop everything in one click.** The environment card has "Stop all", which stops a conversation's background tasks, watches and scheduled wake-ups together.
- **Conversations no longer look busy forever.** A conversation that only has a dev server, a watch or a scheduled wake-up left counts as done; only background work that will report back keeps it running.
- **Chinese text is counted properly.** The context meter, usage statistics and compaction used to count Chinese at about a third of its real size, so long Chinese conversations hit the limit unexpectedly. Compaction summaries of Chinese conversations no longer take up a fifth of the window.
- The context meter shows one color per part when opened, with how full it is at the top.
- The file panel previews PowerPoint and more Office formats page by page; binary files it can't preview open in their default app.
- On the plan card, ⌘↵ accepts the plan; ⇧⌘↵ accepts it and switches to auto approval.
- Plugins can run a conversation for you (for example from a chat app). Such conversations are marked in the title bar, messages and approvals passed in by the plugin say so, and "Stop managing" in the conversation menu takes it back.
- Finding files for the file panel and for file links in replies no longer runs programs configured by the repository (such as fsmonitor or filters) on your machine. Pages shown in the main window can't open new windows or navigate it away.
- Reinstalling or reordering plugins no longer makes the model re-read the whole conversation. Signing in to an MCP server can be cancelled while waiting.
- Installing or updating a plugin while the @ menu is closed no longer crashes the window.

Marketplace plugins have moved to the new plugin interface; installed ones update automatically. Plugins built for 0.1 need rebuilding.

### For plugin authors

Rebuild with `@plumeai/plugin-sdk` 0.2.0. The interface changed in ways that break 0.1 plugins:

- What a tool does to this machine now goes through Plume: run commands with `run.exec` / `run.shell` (sandbox level picked by the permission mode, `run.escalate` to leave it), read and write files with `run.files`, register addresses with `ctx.resources`, and reach the workspace and change records through `ctx.workspace` and `ctx.changes`. The `plume.sandbox` and `plume.secrets` services are gone; secrets are `ctx.secrets`.
- Background work and wake-ups are registered with `run.track` and `run.schedule` (`TrackedJob.stand()` for long-running servers).
- Plume no longer recognizes tools or prompt sections by name. Tools declare `kind` and `category` (including `delegate` and the progress checklist); sections declare a category. File diffs, cancellation and changed files have public shapes: `FileDiffDetails`, `CancelledDetails`, `ChangeHunk`, `ToolOutput.changes`.
- To wait for a person's answer, use `run.request`; `userOnly` and plugin-supplied waiting states are removed. A person's rejection text is `run.rejection`.
- `ctx.sessions.observe` only reports sessions related to your plugin unless you declare `observe: "all"`. Plugins can manage a conversation with `launch({ steward: true })` and `ctx.sessions.post`.
- Requests between conversations are paired and answered by Plume; `run.letter` throws once a chain of replies grows too long.
- New: `ui.openPath`, `ui.revealPath`, `ctx.appDataDir`. The tool list sent to the model is in a fixed order.

<!-- plume:notes zh-CN -->
### 改动

- **仓库不能再替你放宽权限。** 以前，仓库里提交的 `.plume/config.json` 只要一打开，就能把你切到完全访问，或者替你点好「以后不再问」。现在它只能把权限往严了收，比如要求这个项目里每次改动都先问你。被忽略的项会列在设置 › 常规的项目配置卡里，对话里也会提示一次。
- **权限签显示实际生效的那一档。** 项目配置把权限收得比你的设置更严时，输入框上的权限签显示更严的那一档，换成带锁的图标，并写明是项目要求的，不再显示你自己的设置。
- **「以后不再问」能查看、能撤销。** 设置 › 常规 › 权限里列出所有点过「以后不再问」的批准，可以逐条撤销，也可以全部撤销，撤销后下次会重新问你。批准按插件分开记，换一个插件来要同样的东西，会单独问你。
- **一键全部停止。** 环境卡片里有「全部停止」，一个会话的后台任务、监视和定时唤醒一起停掉。
- **会话不会一直显示在忙。** 只剩开发服务器、监视或定时唤醒挂着的会话算已完成，只有之后还会回来报结果的后台任务才让它保持运行中。
- **中文按实际大小计算。** 以前上下文用量、使用统计和压缩把中文估成实际的三成左右，长的中文对话会出乎意料地撞到上限。中文对话压缩后的摘要也不再占掉五分之一的窗口。
- 上下文用量点开后一段一种颜色，顶上写着用了多少。
- 文件面板能逐页预览 PowerPoint 和更多 Office 格式；预览不了的二进制文件可以用默认应用打开。
- 计划卡上 ⌘↵ 是接受计划，⇧⌘↵ 是接受并切到自动批准。
- 插件可以替你代管一个会话，比如从聊天软件里接进来的对话。这类会话在标题栏上有标记，插件转来的话、代答的卡都写明出处，会话菜单里「停止代管」随时收回。
- 文件面板和回复里的文件签找文件时，不再在你的电脑上执行仓库配置的程序（比如 fsmonitor、过滤器）。主窗口里打开的页面不能再弹出新窗口，也不能把主窗口带到别的地址。
- 重装插件、调整插件后，模型不会再把整段对话重读一遍。登录 MCP 服务时，等授权的过程中可以取消。
- 输入框的 @ 菜单收着时装上或更新插件，窗口不会再崩掉。

插件市场里的插件都已换成新的插件接口，装过的会自动更新。按 0.1 构建的插件需要重新构建。

### 给插件作者

请用 `@plumeai/plugin-sdk` 0.2.0 重新构建。这一版接口有不兼容的改动，0.1 的插件不能直接用：

- 工具在这台机器上做的事都经 Plume 本体：跑命令用 `run.exec`、`run.shell`（沙箱档按权限模式定，要离开沙箱用 `run.escalate`），读写文件用 `run.files`，登记资源地址用 `ctx.resources`，工作区和改动记录经 `ctx.workspace`、`ctx.changes`。`plume.sandbox`、`plume.secrets` 两个服务删了，密钥改用 `ctx.secrets`。
- 后台任务和定时唤醒经 `run.track`、`run.schedule` 登记；一直开着的服务用 `TrackedJob.stand()` 标出来。
- 本体不再按名字认工具和提示词段。工具在定义上声明 `kind` 和 `category`（包括派子智能体的 `delegate` 和进度清单），段声明类别。diff、人按了停、改了哪些文件都有公开的形状：`FileDiffDetails`、`CancelledDetails`、`ChangeHunk`、`ToolOutput.changes`。
- 要等人给答案，用 `run.request`；`userOnly` 和插件自己给的等待状态删了。人拒绝调用后交给模型的话是 `run.rejection`。
- `ctx.sessions.observe` 默认只报和你的插件有关的会话，要全部得声明 `observe: "all"`。插件可以经 `launch({ steward: true })` 和 `ctx.sessions.post` 代管会话。
- 会话之间的请求由本体配对、兜底代答；往来链太长时 `run.letter` 会抛错。
- 新增 `ui.openPath`、`ui.revealPath`、`ctx.appDataDir`。发给模型的工具表按固定顺序排。

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
