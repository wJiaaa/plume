/**
 * A request to draw, and what comes back — independent of which endpoint does the drawing.
 */

import type { RetryPolicySource } from "../config/retry-policy.ts";
import type { RequestOptions } from "../types/provider.ts";

/** The tool's name, in one place: the transcript is searched for its results by it. */
export const IMAGE_TOOL_NAME = "image_generate";

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

/**
 * What `image_generate` hands the window: once as the call starts, so the place can be held at the
 * right shape before anything arrives, and again in the result.
 */
export interface ImageGenerateDetails {
	kind: typeof IMAGE_TOOL_NAME;
	/** As asked, `"16:9"`; absent for `auto`. */
	aspectRatio?: string;
	count: number;
	/**
	 * The pictures that went in, by `session-media` name, in the order they were given.
	 *
	 * What makes a picture's history drawable in the gallery: the dog, the dog in a hat, the girl
	 * holding it. Absent on results written before it existed; those are traced back from the call's
	 * own `#1`/path arguments instead (`lineage.ts`).
	 */
	sources?: string[];
	/**
	 * The shape the picture will most likely come back in, when none was asked for: an edit keeps the
	 * shape of the picture it starts from. Width over height.
	 *
	 * Without it the place was a square, and an edit of a wide picture landed as a square snapping to
	 * its real shape — the card, and everything under it, jumping on the frame the picture arrived.
	 */
	shapeHint?: number;
	/** Which model, by id and by the name the card shows; with the two below, what the estimate is timed against. */
	model?: string;
	modelName?: string;
	quality?: string;
	/** Pictures went in: an edit, which takes a little longer. */
	edit?: boolean;
	startedAt?: number;
	/** The wait the call is in, while it is in one: the card says so instead of a stage that is not happening. */
	retry?: { attempt: number; delayMs: number; reason: string };
	/** Why it failed, for the card: a spent quota or a key without the model is something the user acts on. */
	error?: { summary: string; detail?: string; hint?: string; retryAfterMs?: number };
	/** The rest is there once it has drawn. */
	/** Where each picture was saved, in the order of the pictures. */
	paths?: string[];
	/** The same pictures by `session-media` name, with the size read from their headers: what `#N` and the card read. */
	images?: { media: string; mimeType: string; width?: number; height?: number }[];
	references?: number;
	route?: ImageRoute;
	revisedPrompt?: string;
	failures?: string[];
}
