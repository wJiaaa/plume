/**
 * 本插件交回的结果在对话里那一行带的 `details`（`DeliveredReport.details`）：宿主不读，原样留给界面入口画那一行（`ui.tsx`）。
 * 后台命令结束、监视送来一批输出是 `job`，定时唤醒到点是 `wakeup`。
 */
export type DeliveryDetails =
	| {
			kind: "job";
			/** 完整命令，只在悬停时出现：那串 shell 不是写给人读的。 */
			command: string;
			/** 命令结束时的退出码，null 是被信号终止；监视送来的一批没有。 */
			exitCode?: number | null;
			/** 这不是命令结束，是 `monitor` 送来的一批新输出：`lines` 行；达到上限自己停了的，最后一批带着 `stopped`。 */
			monitor?: { lines: number; stopped?: "max_events" | "idle" };
	  }
	| {
			kind: "wakeup";
			/** cron 表达式，一次性唤醒没有。 */
			cron?: string;
	  };
