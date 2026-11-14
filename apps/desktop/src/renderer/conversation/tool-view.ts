/**
 * 转录里的工具调用画成哪一种：新的工具组（`ToolGroup`：标题 + 带框的卡片，一次调用一行），还是旧的流水行（`WorkStep`、`ToolCard`：
 * 一行一个图标，点开挂在竖线上）。旧的先留着，新的用着不顺手时改成 `true` 换回去。
 */
export const LEGACY_TOOL_ROWS: boolean = false;
