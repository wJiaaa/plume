/**
 * 编辑供应商列表：写成一组操作，而不是一份状态。
 *
 * 每个操作都是「取最新设置、算出下一份、存回」，而且各有一个在调用处容易忘的后果：删掉默认模型要换一个，
 * 第一次加模型要让它能直接用。放在一起，这些规则就在一处可查，页面只管布局。
 *
 * 存盘和校验在 agent 进程里（saveProvider 会检查地址、模型 id 等）：输入框每敲一个字就存一次，还没敲完的地址
 * 存不进去，最近一次的失败原因放在 saveError 里显示，下一次存成功就清掉。
 */

import type { CatalogSyncResult, ProviderTestResult } from "@plume/contract";
import { translate } from "@plume/ui";
import { isImageModel } from "@plume/llm/image-models";
import { activeModelCatalog } from "@plume/llm/model-catalog";
import { useEffect, useMemo, useRef, useState } from "react";
import { pullModelCatalog, useCatalogRevision } from "../../models/catalog.ts";
import {
	deleteProvider,
	type ModelConfig,
	modelsAgent,
	modelsState,
	type ProviderEntry,
	saveProvider,
	setDefaultModel as saveDefaultModel,
	setImageModel,
	updateProvider,
	useModels,
} from "../../models/store.ts";
import { applyModelChange, firstChatModelId, type ModelChange } from "./model-sync.ts";
import { uniqueProviderName } from "./provider-name.ts";

export type ProviderPatch = Partial<Pick<ProviderEntry, "name" | "baseUrl" | "api" | "enabled">> & { apiKey?: string };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function withItem(set: ReadonlySet<string>, item: string, present: boolean): ReadonlySet<string> {
	if (set.has(item) === present) return set;
	const next = new Set(set);
	if (present) next.add(item);
	else next.delete(item);
	return next;
}

export function useProviders() {
	const settings = useModels();
	const providers = useMemo(() => settings?.providers ?? [], [settings]);

	const [selectedId, setSelectedId] = useState<string | null>(providers[0]?.id ?? null);
	/*
	 * 测连接、拉列表要等好几秒，这期间可以换到别的供应商：在忙的、测出来的都按供应商记，屏幕上只取选中那一个的。
	 * 行上的模型 id 是 `供应商/模型`，本来就分得开；可以同时测几个模型，所以在测的是一组。
	 */
	const [testingProviders, setTestingProviders] = useState<ReadonlySet<string>>(new Set());
	const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});
	const [testingModelIds, setTestingModelIds] = useState<ReadonlySet<string>>(new Set());
	const [modelTestResults, setModelTestResults] = useState<Record<string, ProviderTestResult>>({});
	const [fetchingProviders, setFetchingProviders] = useState<ReadonlySet<string>>(new Set());
	const [fetchModelsError, setFetchModelsError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);

	const selected = useMemo(() => providers.find((provider) => provider.id === selectedId) ?? providers[0] ?? null, [providers, selectedId]);

	// 目录跟 agent 进程对齐（models/catalog.ts）；agent 进程每小时自己更新一次，打开这一页时对齐一次，搜索和导入用的就是最新的。
	useCatalogRevision();
	useEffect(() => {
		void pullModelCatalog();
	}, []);
	const catalog = activeModelCatalog().source;
	const catalogModels = activeModelCatalog().providers.reduce((sum, provider) => sum + provider.models.length, 0);
	const [updatingCatalog, setUpdatingCatalog] = useState(false);
	const [catalogResult, setCatalogResult] = useState<CatalogSyncResult | null>(null);

	async function updateCatalog() {
		setUpdatingCatalog(true);
		setCatalogResult(null);
		try {
			const result = await modelsAgent().updateModelCatalog();
			await pullModelCatalog();
			setCatalogResult(result);
		} catch (error) {
			setCatalogResult({ status: "failed", error: errorText(error), source: catalog });
		} finally {
			setUpdatingCatalog(false);
		}
	}

	/*
	 * 列表带着它是哪个供应商的。拉一次最多要十几秒，这期间可以换到别的供应商；只拿列表的话，它会落在那时选中的
	 * 供应商上，应用之后把 A 的模型写进 B。所以答案带着问题，和屏幕上那个对不上的丢掉。
	 */
	const [discovered, setDiscovered] = useState<{ providerId: string; models: string[] } | null>(null);
	const shown = useRef<string | null>(null);
	shown.current = selected?.id ?? null;

	function select(id: string) {
		setSelectedId(id);
		// 不等下一次渲染：紧接着拉取的结果要认得出这是屏幕上那一个。
		shown.current = id;
		// 旧结果说的是另一个端点，留着就是说错话。
		setTestResults({});
		setModelTestResults({});
		setFetchModelsError(null);
		setSaveError(null);
		setDiscovered(null);
	}

	/** 存一次并记下成败：失败不抛给调用方，输入框照常可以继续敲。 */
	async function attempt(work: () => Promise<unknown>): Promise<boolean> {
		try {
			await work();
			setSaveError(null);
			return true;
		} catch (error) {
			setSaveError(errorText(error));
			return false;
		}
	}

	async function update(id: string, patch: ProviderPatch) {
		await attempt(() => updateProvider(id, (provider) => ({ ...provider, ...patch })));
	}

	/** 弹窗里填好的那一份。`fetch` 为真时存好就去拉模型列表，结果照常落到拉取弹窗里。 */
	async function add(draft: Pick<ProviderEntry, "name" | "baseUrl" | "api"> & { apiKey: string }, fetch: boolean) {
		let id: string | undefined;
		const ok = await attempt(async () => {
			id = await saveProvider({
				id: "",
				...draft,
				name: uniqueProviderName(
					providers.map((one) => one.name),
					draft.name.trim() || translate("providers.newProvider"),
				),
				enabled: true,
				models: [],
			});
		});
		if (!ok || !id) return;
		select(id);
		if (fetch) await fetchModelsFromEndpoint(id);
	}

	async function remove(id: string) {
		await attempt(() => deleteProvider(id));
		// 经 select：删掉的那个的测试结果、拉取报错不能留在新选中的上面。
		const next = modelsState()?.providers[0]?.id;
		if (next) select(next);
		else setSelectedId(null);
	}

	/** 答没存成的原因，由编辑弹窗自己显示：弹窗开着，原因写在页面上会被它挡住。 */
	async function saveModel(providerId: string, model: ModelConfig, original: ModelConfig | null): Promise<string | null> {
		try {
			await updateProvider(providerId, (provider) => ({
				...provider,
				models: original ? provider.models.map((one) => (one.id === original.id ? model : one)) : [...provider.models, model],
			}));
			return null;
		} catch (error) {
			return errorText(error);
		}
	}

	/** 删一个和删一批是同一件事，走拉取弹窗「取消勾选就移除」的同一条规则。 */
	async function removeModels(providerId: string, modelIds: readonly string[]) {
		const provider = modelsState()?.providers.find((one) => one.id === providerId);
		if (!provider) return;
		const ids = new Set(modelIds);
		await applyChange(providerId, { add: [], remove: provider.models.filter((model) => ids.has(model.id)).map((model) => model.modelId) });
	}

	const removeModel = (providerId: string, modelId: string) => removeModels(providerId, [modelId]);

	/** 行菜单里的「设为默认」：生图模型设的是默认生图模型，别的是默认对话模型。 */
	async function setDefaultModel(modelId: string) {
		const model = modelsState()
			?.providers.flatMap((provider) => provider.models)
			.find((one) => one.id === modelId);
		await attempt(() => (model && isImageModel(model) ? setImageModel(modelId) : saveDefaultModel(modelId)));
	}

	/** 改一个供应商的模型列表。被删的是默认模型、又加了新的，默认换成新加的第一个；只删不加时由 agent 进程落到下一个可用的。 */
	async function applyChange(providerId: string, change: ModelChange) {
		// 用应用那一刻的设置，不用这次渲染的：弹窗可能开着跨过了一次保存。
		const current = modelsState();
		const provider = current?.providers.find((one) => one.id === providerId);
		if (!current || !provider) return;
		const { provider: next, added, removedIds } = applyModelChange(provider, change);
		if (next === provider) return;
		const lostDefault = current.defaultModelId === null || removedIds.has(current.defaultModelId);
		await attempt(async () => {
			await saveProvider(next);
			const firstChat = firstChatModelId(added);
			if (lostDefault && firstChat) await saveDefaultModel(firstChat);
		});
	}

	async function test(modelId?: string) {
		if (!selected) return;
		const providerId = selected.id;
		if (modelId) {
			setTestingModelIds((current) => withItem(current, modelId, true));
			try {
				// 行上的 id 是 `供应商/模型`，测的是发给供应商的那个。
				const model = selected.models.find((one) => one.id === modelId);
				const result = await modelsAgent().testProvider(providerId, model?.modelId ?? modelId);
				setModelTestResults((previous) => ({ ...previous, [modelId]: result }));
			} catch (error) {
				setModelTestResults((previous) => ({ ...previous, [modelId]: { ok: false, latencyMs: 0, message: errorText(error) } }));
			} finally {
				setTestingModelIds((current) => withItem(current, modelId, false));
			}
		} else {
			setTestingProviders((current) => withItem(current, providerId, true));
			setTestResults(({ [providerId]: _old, ...rest }) => rest);
			let result: ProviderTestResult;
			try {
				result = await modelsAgent().testProvider(providerId, undefined);
			} catch (error) {
				result = { ok: false, latencyMs: 0, message: errorText(error) };
			} finally {
				setTestingProviders((current) => withItem(current, providerId, false));
			}
			setTestResults((previous) => ({ ...previous, [providerId]: result }));
		}
	}

	/** 默认拉当前选中的；刚加好的那个还没进这一次渲染的 `selected`，由 `add` 直接点名。 */
	async function fetchModelsFromEndpoint(providerId = selected?.id) {
		if (!providerId) return;
		setFetchingProviders((current) => withItem(current, providerId, true));
		setFetchModelsError(null);
		try {
			const result = await modelsAgent().fetchModels(providerId);
			if (shown.current !== providerId) return;
			if (!result.ok) {
				setFetchModelsError(result.error || translate("providers.fetchFailed"));
				return;
			}
			// 空列表也打开弹窗：中转可能提供它不列出的模型，弹窗里能手动输入名字、也能删已配置的，一条报错横幅两样都做不了。
			setDiscovered({ providerId, models: result.models });
		} catch (error) {
			if (shown.current === providerId) setFetchModelsError(errorText(error));
		} finally {
			setFetchingProviders((current) => withItem(current, providerId, false));
		}
	}

	async function applyDiscoveredChange(change: ModelChange) {
		const providerId = discovered?.providerId;
		setDiscovered(null);
		if (providerId) await applyChange(providerId, change);
	}

	return {
		providers,
		selected,
		defaultModelId: settings?.defaultModelId ?? null,
		testing: selected ? testingProviders.has(selected.id) : false,
		testResult: (selected && testResults[selected.id]) ?? null,
		testingModelIds,
		modelTestResults,
		fetchingModels: selected ? fetchingProviders.has(selected.id) : false,
		fetchModelsError,
		saveError,
		discoveredModels: discovered && discovered.providerId === selected?.id ? discovered.models : null,
		fetchModelsFromEndpoint,
		applyDiscoveredChange,
		closeDiscoveredModal: () => setDiscovered(null),
		select,
		add,
		update,
		remove,
		saveModel,
		removeModel,
		removeModels,
		setDefaultModel,
		test,
		catalog,
		catalogModels,
		updatingCatalog,
		catalogResult,
		updateCatalog,
	};
}
