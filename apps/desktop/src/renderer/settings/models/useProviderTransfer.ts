/**
 * 供应商列表导出成文件、再导回来。
 *
 * 和 useProviders 分开，因为是另一个问题：那边是「改一个供应商是什么意思」，这边是「把整个列表带到另一台机器上
 * 是什么意思」，后果也各有各的——导出的文件值得偷，导入的文件不是这个程序写的。
 *
 * 文件由 agent 进程读写（里面有 key），这里只拿到路径（主进程的对话框）和预览。确认之前什么都不写：预览说明每一项会
 * 做什么，弹窗给人看，只有勾回来的那几项才导入。结果由全局提示条报告，切走设置页也不会漏掉。
 */

import type { ProviderImportEntry, ProviderImportPreview } from "@plume/contract";
import type { MessageKey } from "@plume/ui";
import { translate } from "@plume/ui";
import { useState } from "react";
import { modelsAgent, refreshModels, useModels } from "../../models/store.ts";
import { notify } from "../../toast/store.ts";

const PROBLEM_MESSAGE: Record<Extract<ProviderImportPreview, { ok: false }>["problem"], MessageKey> = {
	"not-json": "providerTransfer.errorNotJson",
	"not-a-bundle": "providerTransfer.errorNotBundle",
	"too-new": "providerTransfer.errorTooNew",
	"no-providers": "providerTransfer.errorNoProviders",
};

/** 文件夹里按眼睛排序的名字，所以用本地时间，不用文件里的 ISO 时间。 */
function bundleFileName(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
	return `plume-providers-${stamp}.json`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function useProviderTransfer() {
	const settings = useModels();
	const [pending, setPending] = useState<{ file: string; entries: ProviderImportEntry[]; dropped: number } | null>(null);
	/**
	 * 导入了几次，给要重建而不是重画的表单用：导入按原来的 id 替换供应商，React 看得到的 key 一个都没变，
	 * 编辑器的输入框只在挂载时取初值。数一下导入次数，页面就有一样会变的东西。用法见 ModelSettings。
	 */
	const [imports, setImports] = useState(0);
	// Magpie 的供应商不导出：它由 Magpie 管，带到别的机器上也连不上那边的网关。
	const own = (settings?.providers ?? []).filter((provider) => provider.id !== "magpie");

	/** 写文件。只在调用方问过之后调：警告要放在点击的地方，那里还能回答「不」。 */
	async function exportAll() {
		try {
			const file = await window.plume.providerFile.save(translate("providerTransfer.exportTip"), bundleFileName());
			if (!file) return;
			const result = await modelsAgent().exportProviders(file);
			notify(
				translate(result.containsSecrets ? "providerTransfer.exportedWithKeys" : "providerTransfer.exported", { n: result.providers }),
				result.containsSecrets ? "warn" : "info",
			);
		} catch (error) {
			notify(errorText(error), "error");
		}
	}

	/** 选一个文件，是供应商文件的话算出导入会做什么。 */
	async function offer() {
		try {
			const file = await window.plume.providerFile.open(translate("providerTransfer.importTip"));
			if (!file) return;
			const preview = await modelsAgent().previewProviderImport(file);
			if (!preview.ok) {
				notify(translate(PROBLEM_MESSAGE[preview.problem]), "error");
				return;
			}
			setPending({ file, entries: preview.entries, dropped: preview.dropped });
		} catch (error) {
			notify(errorText(error), "error");
		}
	}

	async function confirmImport(chosen: string[]) {
		const file = pending?.file;
		setPending(null);
		if (!file || chosen.length === 0) return;
		try {
			const n = await modelsAgent().importProviders(file, chosen);
			await refreshModels();
			setImports((count) => count + 1);
			notify(translate("providerTransfer.imported", { n }));
		} catch (error) {
			notify(errorText(error), "error");
		}
	}

	return {
		pending,
		imports,
		exportAll,
		offer,
		confirmImport,
		cancelImport: () => setPending(null),
		/** 没有可写的，写它的那个控件也就没事可做。 */
		canExport: own.length > 0,
	};
}
