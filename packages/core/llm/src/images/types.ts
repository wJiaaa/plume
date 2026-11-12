/**
 * A request to draw, and what comes back — independent of which endpoint does the drawing.
 */

import type { RetryPolicySource } from "../config/retry-policy.ts";
import type { RequestOptions } from "../types/provider.ts";

/** An image going in: something to edit, or to draw after. */
export interface ImageInput {
	/** base64, no `data:` prefix. */
	data: string;
	mimeType: string;
	/** A file name for the multipart upload; some endpoints reject a part without one. */
	name?: string;
}

export interface ImageRequest {
	prompt: string;
	/** Present means an edit: these are the pictures the prompt is about. */
	images?: ImageInput[];
	/** `"16:9"` and friends; absent or `auto` leaves the shape to the model. */
	aspectRatio?: string;
	/** `max` is the largest the model offers — 4K on Gemini — and is slow to arrive over a relay. */
	quality?: "low" | "medium" | "high" | "max";
	count?: number;
	background?: "transparent" | "opaque";
}

export interface GeneratedImage {
	data: string;
	mimeType: string;
}

/** Which endpoint drew it: the Images API, or a chat completion asked for image output. */
export type ImageRoute = "images" | "chat";

export interface ImageResult {
	images: GeneratedImage[];
	/** What the provider says it actually drew from, when it rewrote the prompt. */
	revisedPrompt?: string;
	route: ImageRoute;
	usage?: { input?: number; output?: number; total?: number };
	/** Why the pictures that did not arrive did not, when only some of several did. */
	failures?: string[];
}

export interface ImageCallOptions {
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
	retryAttempts?: number;
	retryPolicy?: RetryPolicySource;
	onRetry?: RequestOptions["onRetry"];
}

/** A picture already in the conversation, not yet read: inline pixels or a file under `session-media`. */
export interface ImagePointer {
	data?: string;
	media?: string;
	mimeType: string;
}
