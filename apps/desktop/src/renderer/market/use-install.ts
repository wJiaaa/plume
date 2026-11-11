/**
 * 对一个插件能做的三件事，以及做的时候是什么状态。
 *
 * 卡片和详情页对同一个条目做同样的操作，「置忙、调用、读结果、刷新」写两份就是两处顺序会走岔。
 * 每个操作都只报告不抛错：装失败是一句要给人读的话（经市场的提示行），不是把整页卸掉的异常。
 */

import { useEffect, useState } from "react";
import { type CatalogItem, isInstalled } from "./catalog.ts";
import { installPlugin, uninstallPlugin, updatePlugins } from "./store.ts";

/** 哪个操作在进行中，或者没有。驱动转圈，也禁用控件。 */
type Busy = "install" | "update" | "uninstall" | null;

export interface Install {
	busy: Busy;
	install: () => Promise<void>;
	update: () => Promise<void>;
	/** 答卸没卸掉：没卸掉时留在详情页，失败已经报过了。 */
	uninstall: () => Promise<boolean>;
}

/**
 * 装完以后转圈多留一会儿，等目录跟上。
 *
 * 安装返回在重读目录之前：两者之间卡片还没有已装的东西可画，会闪回「安装」，像是失败了。转圈留到条目读成
 * 已装——或者到这个时长，万一重读一直不说。
 */
const SETTLE_MS = 5000;

export function useInstall(item: CatalogItem): Install {
	const [busy, setBusy] = useState<Busy>(null);
	const [settling, setSettling] = useState(false);
	const installed = isInstalled(item);

	useEffect(() => {
		if (!settling) return;
		if (installed) {
			setSettling(false);
			setBusy(null);
			return;
		}
		const timer = setTimeout(() => {
			setSettling(false);
			setBusy(null);
		}, SETTLE_MS);
		return () => clearTimeout(timer);
	}, [settling, installed]);

	return {
		busy,
		install: async () => {
			setBusy("install");
			if (await installPlugin(item)) setSettling(true);
			else setBusy(null);
		},
		update: async () => {
			setBusy("update");
			await updatePlugins([item.key]);
			setBusy(null);
		},
		uninstall: async () => {
			setBusy("uninstall");
			const ok = await uninstallPlugin(item);
			setBusy(null);
			return ok;
		},
	};
}
