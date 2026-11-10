/** 会话独立窗口（会话菜单的「新窗口」）：主窗口开、列，会话窗口取自己的会话、置顶、回到主窗口。只传会话 id。 */
export interface SessionWindowsBridge {
	/** 这个窗口是哪段会话的独立窗口；主窗口、面板窗口是 null。 */
	boot: string | null;
	/** 已经开着的就拿到前面来。 */
	open(sessionId: string): Promise<void>;
	list(): Promise<string[]>;
	onChanged(listener: (sessionIds: string[]) => void): () => void;
	/** 会话窗口点了「在主窗口中打开」：主窗口把那段会话放到屏上。 */
	onShow(listener: (sessionId: string) => void): () => void;
	/** 回到主窗口，关掉这个窗口。 */
	openInMain(): Promise<void>;
	/** 不给参数是只问；返回现在置顶没有。 */
	keepOnTop(enabled?: boolean): Promise<boolean>;
}
