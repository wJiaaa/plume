import { translate } from "@plume/ui";
import { notify } from "../toast/store.ts";

type Opener = (directory: string, sessionId: string) => void | Promise<void>;
type Runner = (command: string, sessionId: string) => void | Promise<void>;

/** 每个插件一个处理器，最新登记的接请求；插件停用后恢复前一个。 */
function handlers<T>() {
	const entries = new Map<string, { value: T }>();
	return {
		register(plugin: string, value: T): () => void {
			entries.delete(plugin);
			const entry = { value };
			entries.set(plugin, entry);
			return () => {
				if (entries.get(plugin) === entry) entries.delete(plugin);
			};
		},
		latest: (): T | undefined => [...entries.values()].at(-1)?.value,
	};
}

const openers = handlers<Opener>();
const runners = handlers<Runner>();

export const registerTerminalOpener = openers.register;
export const registerTerminalRunner = runners.register;

/** 没有终端时提示装插件，处理器出错时说出原因：都是人刚点过的按钮，不能没有回应。 */
async function call(handle: (() => void | Promise<void>) | undefined): Promise<void> {
	if (!handle) {
		notify(translate("fileAction.noTerminal"), "warn");
		return;
	}
	try {
		await handle();
	} catch (error) {
		notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function openInTerminal(sessionId: string, directory: string): Promise<void> {
	const open = openers.latest();
	await call(open && (() => open(directory, sessionId)));
}

export async function runInTerminal(sessionId: string, command: string): Promise<void> {
	const run = runners.latest();
	await call(run && (() => run(command, sessionId)));
}
