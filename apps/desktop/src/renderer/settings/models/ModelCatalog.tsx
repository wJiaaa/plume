import { activeModelCatalog, type CatalogModel, type CatalogProvider } from "@plume/llm/model-catalog";
import { Scroller, useI18n } from "@plume/ui";
import { useMemo, useState } from "react";
import { TextInput } from "../inputs.tsx";

/** 搜索结果里排在前面的：厂商自己的条目和 OpenRouter 的参考值。 */
const PRIMARY = new Set(["openai", "anthropic", "google", "moonshotai", "zai", "deepseek", "xai", "minimax", "xiaomi", "openrouter"]);

interface Entry {
	provider: CatalogProvider;
	model: CatalogModel;
}

/**
 * 从模型目录填入：搜索 pi 的目录，选中一条就把它的值填进表单，之后和目录再无关系。
 *
 * 没搜索时，按模型 ID 和 Base URL 自动找到的那条作为建议列出来，一下就能填。
 */
export function ModelCatalog({ suggestion, onPick }: { suggestion: Entry | null; onPick: (entry: Entry) => void }) {
	const { t } = useI18n();
	const [query, setQuery] = useState("");
	const results = useMemo(() => {
		const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
		if (!words.length) return [];
		return activeModelCatalog()
			.providers.flatMap((provider) =>
				provider.models
					.filter((model) => words.every((word) => `${provider.id} ${model.id} ${model.name}`.toLowerCase().includes(word)))
					.map((model) => ({ provider, model })),
			)
			.sort((a, b) => Number(PRIMARY.has(b.provider.id)) - Number(PRIMARY.has(a.provider.id)))
			.slice(0, 30);
	}, [query]);
	const row = (entry: Entry, prefix = "") => (
		<button
			type="button"
			key={`${entry.provider.id}/${entry.model.id}`}
			onClick={() => {
				onPick(entry);
				setQuery("");
			}}
			className="block w-full rounded-lg px-2 py-2 text-left hover:bg-accent/10"
		>
			<span className="block break-all text-label text-ink">
				{prefix}
				{entry.model.id}
			</span>
			<span className="text-detail text-ink-muted">
				{entry.provider.id} · {Math.round(entry.model.contextWindow / 1000)}K ·{" "}
				{entry.model.inputPrice === undefined || entry.model.outputPrice === undefined
					? t("usage.noPrice")
					: t("catalog.price", { input: entry.model.inputPrice, output: entry.model.outputPrice })}
			</span>
		</button>
	);
	return (
		<div className="space-y-2 rounded-lg border border-line px-3.5 py-3">
			<div className="text-label font-medium text-ink">{t("catalog.fill")}</div>
			<p className="text-detail text-ink-faint">{t("catalog.fillDetail")}</p>
			<TextInput value={query} onChange={setQuery} aria-label={t("catalog.search")} placeholder={t("catalog.searchPlaceholder")} />
			{query.trim() ? (
				<div aria-label={t("catalog.results")}>
					<Scroller className="max-h-48" overscroll="auto">
						{results.length === 0 ? <p className="py-2 text-detail text-ink-muted">{t("catalog.missing")}</p> : results.map((entry) => row(entry))}
					</Scroller>
				</div>
			) : (
				suggestion && <div aria-label={t("catalog.results")}>{row(suggestion, t("catalog.suggested"))}</div>
			)}
		</div>
	);
}
