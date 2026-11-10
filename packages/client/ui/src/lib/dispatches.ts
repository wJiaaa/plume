/**
 * 一张派出去的子智能体的脸此刻的样子。
 *
 * 对话里的派发调用和子智能体登记簿怎么对上号、每一条落到哪个表情，归用到它的功能；这里只留
 * `AgentAvatar` 要的那个类型。
 */

/** 和 `AgentAvatar` 的表情一一对应（它另外还有一个 `idle`）。 */
export type DispatchState = "waiting" | "working" | "done" | "failed" | "stopped";
