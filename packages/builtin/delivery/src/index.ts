import type { Plugin } from "@plume/contract";
import type { DeliveryApi } from "./api.ts";
import { MESSAGES } from "./logic-messages.ts";
import { collectDelivery, deliveryMessages, recordedChanges } from "./record.ts";

export default {
	name: "plume.delivery",
	apply(ctx) {
		async function turn(sessionId: string, timestamp: number) {
			const words = MESSAGES[ctx.locale()];
			if (typeof sessionId !== "string" || !sessionId) throw new Error(words.missingSession);
			if (!Number.isSafeInteger(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) throw new Error(words.missingTurn);
			if (!(await ctx.sessions.get(sessionId))) throw new Error(words.missingSession);
			return deliveryMessages(await ctx.sessions.messages(sessionId), timestamp, ctx.locale());
		}
		const api: DeliveryApi = {
			async get(sessionId, timestamp) {
				const messages = await turn(sessionId, timestamp);
				return collectDelivery(ctx.changes, sessionId, messages, ctx.locale());
			},
			async undo(sessionId, timestamp, path) {
				const messages = await turn(sessionId, timestamp);
				if (path !== undefined && (typeof path !== "string" || !path.trim())) throw new Error(MESSAGES[ctx.locale()].invalidPath);
				await ctx.changes.undo(sessionId, recordedChanges(messages).ids, path);
				return api.get(sessionId, timestamp);
			},
		};
		ctx.serve(api);
	},
} satisfies Plugin;
