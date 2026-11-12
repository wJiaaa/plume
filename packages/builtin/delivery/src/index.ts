import type { Plugin } from "@plume/contract";
import type { DeliveryApi } from "./api.ts";
import { MESSAGES } from "./logic-messages.ts";
import { collectDelivery, deliveryMessages, recordedChanges, rewindFiles } from "./record.ts";

export default {
	name: "plume.delivery",
	inject: ["file.changes"],
	apply(ctx) {
		const service = ctx.use("file.changes");
		async function turn(sessionId: string, timestamp: number) {
			const words = MESSAGES[ctx.locale()];
			if (typeof sessionId !== "string" || !sessionId) throw new Error(words.missingSession);
			if (!Number.isSafeInteger(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) throw new Error(words.missingTurn);
			const session = await ctx.sessions.get(sessionId);
			if (!session) throw new Error(words.missingSession);
			const messages = deliveryMessages(await ctx.sessions.messages(sessionId), timestamp, ctx.locale());
			return { session, messages };
		}
		const api: DeliveryApi = {
			async get(sessionId, timestamp) {
				const { session, messages } = await turn(sessionId, timestamp);
				return collectDelivery(service, sessionId, session.cwd, messages, ctx.locale());
			},
			async undo(sessionId, timestamp, path) {
				const { session, messages } = await turn(sessionId, timestamp);
				if (path !== undefined && (typeof path !== "string" || !path.trim())) throw new Error(MESSAGES[ctx.locale()].invalidPath);
				await service.undo(sessionId, session.cwd, recordedChanges(messages).ids, path);
				return api.get(sessionId, timestamp);
			},
		};
		ctx.serve(api);
		ctx.hook("session.rewind", async (input, next) => {
			const inner = await next(input);
			const own = await rewindFiles(service, input.sessionId, input.cwd, input.messages, input.restore, ctx.locale());
			return { files: [...inner.files, ...own.files], unrecorded: inner.unrecorded || own.unrecorded };
		});
	},
} satisfies Plugin;
