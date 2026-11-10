/** A JSON object: not `null`, not an array. What every reader of parsed config and wire bodies checks first. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
