export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const MAX_DOCUMENTS = 16;
/** 统一文档预览（plume.documents）认得的扩展名。 */
export const DOCUMENT_EXTENSION = /\.(docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|xlsb|xls|ods|pptx|pptm|ppsx|ppsm|potx|potm|sqlite|sqlite3|db)$/;
export const DOCUMENT_ID = new RegExp(`^[a-f0-9]{64}${DOCUMENT_EXTENSION.source}`);

export interface DocumentRef {
	id: string;
	name: string;
	bytes: number;
}

export function isDocumentList(value: unknown): value is DocumentRef[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= MAX_DOCUMENTS &&
		value.every(
			(item) =>
				item &&
				typeof item === "object" &&
				typeof item.id === "string" &&
				DOCUMENT_ID.test(item.id) &&
				typeof item.name === "string" &&
				item.name.length > 0 &&
				item.name.length <= 240 &&
				Number.isSafeInteger(item.bytes) &&
				item.bytes > 0 &&
				item.bytes <= MAX_DOCUMENT_BYTES,
		)
	);
}
