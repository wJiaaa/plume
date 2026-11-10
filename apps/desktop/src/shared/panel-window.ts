/** 面板独立窗口的启动信息；不含会话正文或凭据。 */
import type { DraftQuote } from "@plume/contract/ui";

export interface PanelWindowTarget {
	scope: string;
	tab: string;
	panel: string;
	title?: string;
	owner?: string;
	/** 文件面板交接当前路径，内容仍通过会话权限重新读取。 */
	file?: { path: string; sessionId: string };
}

export type PanelWindowReveal =
	| { panel: string; sessionId?: string }
	| { file: { path: string; sessionId: string; lines?: { from: number; to: number } } }
	/** 独立会话窗口的划词动作回到主窗口，仍只准备来源会话旁边的草稿。 */
	| { quote: { panel: string; sessionId: string; quote: DraftQuote } }
	/** 插件往输入框里放的字（`ui.draftInSession`）：面板窗口没有输入框，交给来源会话的；`send` 时输入框原本是空的就发出去。 */
	| { draft: { text: string; append: boolean; images: { data: string; mimeType: string }[]; send?: boolean } };

export interface PanelWindowsBridge {
	boot: PanelWindowTarget | null;
	open(target: PanelWindowTarget): Promise<boolean>;
	/** 收回到来源会话；关闭系统窗口则关闭该标签。 */
	dock(): Promise<void>;
	/** 面板处理关闭确认、释放资源后，允许系统窗口真正关闭。 */
	close(): Promise<void>;
	list(): Promise<PanelWindowTarget[]>;
	/** 浮在别的应用上面；不给参数是只问现在的状态。 */
	keepOnTop(enabled?: boolean): Promise<boolean>;
	/** 独立窗口中的文件签、辅助面板、引文和插件写的草稿回到来源会话，不吞掉操作。 */
	reveal(request: PanelWindowReveal): Promise<void>;
	onReveal(listener: (event: { scope: string; request: PanelWindowReveal }) => void): () => void;
	onChanged(listener: (event: { target: PanelWindowTarget; reason: "opened" | "closing" | "closed" | "docked" }) => void): () => void;
}
