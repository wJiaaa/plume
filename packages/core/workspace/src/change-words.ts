/**
 * 改动记录、撤销给人看的话（界面语言由 `@plume/agent` 定，这个包只认键）。也有交给模型的：快照存不下时写文件的工具把它当错误交回。
 */
export interface ChangeWords {
	undoBusy: string;
	undoRunning: string;
	undoEmpty: string;
	undoInvalid: string;
	undoCommand: string;
	undoInterleaved: string;
	undoOutside: string;
	undoModified: string;
	undoFailed: string;
	changeMissing: string;
	changeSaveFailed: string;
	changeWarning(reason: string): string;
	changeLargeFile: string;
	changeBinary: string;
	changeSecret: string;
	changeManyBefore: string;
	changeManyAfter: string;
	changeLargeBefore: string;
	changeLargeAfter: string;
	changeBackground: string;
	changeObserveFailed: string;
}
