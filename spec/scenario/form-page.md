# 表单和设置页

管要用户填写、选择、提交的页面：设置页的各章节（模型、外观……）。控件本身的规则见 [`tech/components.md`](../tech/components.md)。

## 开发准则

### 版式

- 设置页用 `apps/desktop/src/renderer/settings/controls.tsx` 的版式：`PageHeader`（页标题和介绍）→ 设置卡片（`Card`）→ 卡片里一行一个设置（`Row`：名字和说明在左，控件在右）；要整行宽的输入框用 `Field`（标签在上、控件在下，可带 `hint`）。页与页的标题位置、介绍行宽都由它定，章节里不另写。
- 代码外观是一张带实时预览的连续卡片：统一 `p-4 space-y-4`，项目标题用 `label`、说明用 `caption`，项目顶部细线下留 `pt-3`；描边和紧接的行内代码示例之间不插分割线，不套普通 `Row` 的整行内边距。
- 布尔设置用 `Toggle`，两三个互斥选项用 `Segmented`，选项多的用 `InlineSelect`。

### 控件

- 单行输入一律用 `Input`，不写裸 `<input>`；输入框和旁边的按钮放一行时，输入框 `className="flex-1"`。
- `name` 属性保留：冒烟按 `name` 找输入框。
- 密钥类字段：`type="password"`、`autoComplete="off"`；已保存的不回显，占位写“已保存，留空则不修改”。

### 提交

- 底部一行，primary 在前（保存、创建），取消在后（ghost）。必填项为空时 primary 禁用。
- 提交中用 `loading`，不让同一个请求发两次。
- 失败：用 `Notice tone="danger"`，写在按钮上方，内容是能读懂的错误文字（`errorText`）。成功后要么离开页面，要么把提交按钮换成勾加“已保存”，两秒后换回（个性化页的写法），同时给读屏一个 `role="status"` 的“已保存”（按钮上的字换了读屏不一定念）。
- 改了任何字段，“已保存”提示要消失。

### 边界态

- 长路径、长 URL：输入框内横向滚动，不撑宽页面。
- 窄窗口：设置页的 `Row` 按自身宽度（容器查询）把控件换到下一行，不按窗口宽度判断。

## 检查点

- 没有裸的 `<input>`、`<textarea>`；按钮只用 `Button`。
- Tab 能依次走到每个控件，键盘焦点可见（全局焦点环，见 [`tech/styling.md`](../tech/styling.md)）。
- 冒烟依赖的 `name`、`data-screen` 和按钮文字不变。

## 事实来源

- `apps/desktop/src/renderer/settings/controls.tsx`、`apps/desktop/src/renderer/settings/pages.tsx`
- `apps/desktop/src/renderer/app/SettingsScreen.tsx`、`apps/desktop/src/renderer/settings/models/ModelSettings.tsx`、`apps/desktop/src/renderer/settings/personalization.tsx`（“已保存”）
- `apps/desktop/src/main/smoke.ts`
