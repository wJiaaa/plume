import type { FileChangesSummary } from "@plume/contract";

export interface DeliveryApi {
	get(sessionId: string, timestamp: number): Promise<FileChangesSummary>;
	undo(sessionId: string, timestamp: number, path: string | undefined): Promise<FileChangesSummary>;
}
