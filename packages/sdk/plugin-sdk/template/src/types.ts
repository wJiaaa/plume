/** 工具结果的 details：逻辑入口写进去，界面入口的卡片读出来。会话里存的可能是旧版本写的，读之前先校验。 */
export interface GreetingDetails {
	name: string;
}

export function isGreeting(value: unknown): value is GreetingDetails {
	return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
}
