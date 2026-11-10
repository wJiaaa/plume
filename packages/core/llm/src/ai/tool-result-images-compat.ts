/**
 * Where a tool result's image goes on the Responses API — learned from the endpoint, then kept.
 *
 * The protocol puts it inside the result: `function_call_output.output` may be a list with
 * `input_image` parts, and that is the default. Relays that translate Responses into Chat
 * Completions do not all carry that across. Measured 2026-09-27 on a relay serving `glm-5.3-flash`
 * (an MCP tool returning a screenshot), the request with the image was refused outright:
 *
 *     Upstream request failed: [invalid_value] messages[5]: tool content: part type "image_url"
 *     is not supported; only text is
 *
 * and not once: the image stays in history, so every later request in that conversation would be
 * refused the same way. Having been told, the image moves to a user message right after the
 * results — the shape Chat Completions uses anyway — and the request is sent again.
 *
 * In memory only, like the other compat axes: relearning after a restart costs one refused request.
 */

import { compatKey } from "./compat-key.ts";

/** `inline`: inside `function_call_output`. `lifted`: in a user message after the results. */
export type ToolResultImages = "inline" | "lifted";

const learned = new Map<string, ToolResultImages>();

export function toolResultImages(providerId: string, modelId: string): ToolResultImages {
	return learned.get(compatKey(providerId, modelId)) ?? "inline";
}

/** Only the refusal that names an image inside a tool message; any other 400 is not this. */
const TOOL_IMAGE_REFUSED = /tool[\s\S]{0,60}(image_url|input_image)[\s\S]{0,60}not supported/i;

/** Learn from one failure. Returns "the conclusion changed, worth resending in the new shape". */
export function learnToolResultImages(providerId: string, modelId: string, error: string): boolean {
	if (!TOOL_IMAGE_REFUSED.test(error)) return false;
	const id = compatKey(providerId, modelId);
	if (learned.get(id) === "lifted") return false;
	learned.set(id, "lifted");
	return true;
}

/** For tests: forget everything learned. */
export function resetToolResultImagesCompat(): void {
	learned.clear();
}
