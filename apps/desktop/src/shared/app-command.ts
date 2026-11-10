/**
 * 主进程叫主窗口的界面做的事：菜单栏图标的菜单（main/tray.ts）和 `plume://` 链接（main/deep-link.ts）都落到这几条上。
 *
 * 主进程不知道界面里有哪些页，界面也不知道菜单长什么样，两边只认这个名字。打开会话是唯一带对象的一条，
 * 会话 id 跟在名字后面，还是一个字符串。`updates` 打开设置 › 关于并马上查一次更新。
 */
export type AppCommand = "new-session" | "settings" | "updates" | `open-session:${string}`;
