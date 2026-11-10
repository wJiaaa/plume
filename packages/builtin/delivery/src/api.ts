import type { FileChangesSummary, FileContents } from "@plume/contract";

export interface TurnDelivery extends FileChangesSummary {
	reportPath: string | null;
}

export interface DeliveryApi {
	get(sessionId: string, timestamp: number): Promise<TurnDelivery>;
	undo(sessionId: string, timestamp: number, path: string | undefined): Promise<TurnDelivery>;
	report(sessionId: string, timestamp: number): Promise<{ path: string; contents: FileContents }>;
}
