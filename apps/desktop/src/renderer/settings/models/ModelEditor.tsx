/**
 * 新建或编辑一个模型：id、显示名、上限、能力、思考档位、价格。可以从模型目录一次性填值，之后和目录无关。
 */

import { isImageModel, isImageModelId } from "@plume/llm/image-models";
import { type CatalogModel, catalogFill, catalogModelFor, DEFAULT_MODEL_LIMITS } from "@plume/llm/model-catalog";
import { DEFAULT_THINKING_OPTIONS, THINKING_LEVELS, thinkingOptionsFor } from "@plume/llm/thinking-options";
import type { ModelPricing, ThinkingLevel, ThinkingOption } from "@plume/llm/types";
import { type Dismiss, DialogAction, DialogFrame, isLegalDraft, type MessageKey, Overlay, useI18n } from "@plume/ui";
import { Box, CircleAlert } from "@plume/ui/icons";
import { useState } from "react";
import type { ModelConfig, ProviderEntry } from "../../models/store.ts";
import { Field, Notice, TextInput, Toggle } from "../controls.tsx";
import { ModelCatalog } from "./ModelCatalog.tsx";

const CONTEXT = { min: 1, max: 100_000_000, step: 1 };
const OUTPUT = { min: 1, max: 100_000_000, step: 1 };
const PRICE = { min: 0, max: 1_000_000, step: 0.000001 };

type PriceKey = "input" | "output" | "cacheRead" | "cacheWrite";
type Prices = Record<PriceKey, string>;

function pricesOf(pricing: ModelPricing | undefined): Prices {
	const text = (value: number | undefined) => (value === undefined ? "" : String(value));
	return { input: text(pricing?.input), output: text(pricing?.output), cacheRead: text(pricing?.cacheRead), cacheWrite: text(pricing?.cacheWrite) };
}

export function ModelEditor({
	provider,
	model,
	onSave,
	onCancel,
}: {
	provider: Pick<ProviderEntry, "id" | "baseUrl">;
	model: ModelConfig | null;
	/** 存成了答 null，没存成答原因：存成了才关，没存成留着表单、把原因写在弹窗里。 */
	onSave: (model: ModelConfig) => Promise<string | null>;
	onCancel: () => void;
}) {
	const { t } = useI18n();
	const [modelId, setModelId] = useState(model?.modelId ?? "");
	const [name, setName] = useState(model?.name ?? "");
	const initial = model ?? DEFAULT_MODEL_LIMITS;
	const [contextWindow, setContextWindow] = useState(String(initial.contextWindow));
	const [maxOutput, setMaxOutput] = useState(String(initial.maxOutputTokens));
	const [supportsThinking, setSupportsThinking] = useState(initial.supportsThinking);
	const [thinkingOptions, setThinkingOptions] = useState(model?.thinkingOptions);
	const [supportsImages, setSupportsImages] = useState(initial.supportsImages);
	const [supportsTools, setSupportsTools] = useState(initial.supportsTools);
	/*
	 * 这个模型画不画图。没人拨过开关时跟着模型 id 走：`gemini-3.1-flash-image` 按名字就是生图模型，服务商自己起的名字
	 * （`house-artist`）不是——开关就是给这种情况的。只在和按名字判断的结果不同时才存，没人改过的模型随规则改进一起变。
	 */
	const [imageOutput, setImageOutput] = useState(model ? isImageModel(model) : false);
	const [imageTouched, setImageTouched] = useState(model?.imageOutput !== undefined);
	const [prices, setPrices] = useState(() => pricesOf(model?.pricing));
	/*
	 * 表单里这组价格对应的完整价格记录——从目录填入的（带长上下文阶梯和来源），或者已保存的。改了任何
	 * 一项价格它就作废，保存时按表单里的数字存成手动价格。
	 */
	const [storedPricing, setStoredPricing] = useState(model?.pricing);

	const trimmedId = modelId.trim();
	const suggestion = trimmedId ? catalogModelFor(provider, trimmedId) : null;
	const window_ = Number(contextWindow);
	const output = Number(maxOutput);
	const windowOk = Number.isInteger(window_) && window_ > 0 && window_ <= 100_000_000;
	const outputOk = Number.isInteger(output) && output > 0 && output <= window_;
	const parsePrice = (value: string) => {
		if (!value.trim()) return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
	};
	const parsed = [prices.input, prices.output, prices.cacheRead, prices.cacheWrite].map(parsePrice);
	const pricingComplete = parsed[0] !== null && parsed[1] !== null;
	const pricingEmpty = parsed.every((price) => price === null);
	const pricingOk = parsed.every((price) => price === null || Number.isFinite(price)) && (pricingComplete || pricingEmpty);
	const valid = trimmedId.length > 0 && windowOk && outputOk && pricingOk;

	/** 把一个目录条目的值填进表单。只是填一次，之后怎么改都行。 */
	function fill(entry: { provider: { id: string }; model: CatalogModel }) {
		const values = catalogFill(entry.model, provider);
		setContextWindow(String(values.contextWindow));
		setMaxOutput(String(values.maxOutputTokens));
		setSupportsThinking(values.supportsThinking);
		setThinkingOptions(values.thinkingOptions);
		setSupportsImages(values.supportsImages);
		setSupportsTools(values.supportsTools);
		setPrices(pricesOf(values.pricing));
		setStoredPricing(values.pricing);
	}

	function changePrice(key: PriceKey, value: string) {
		setPrices((current) => ({ ...current, [key]: value }));
		setStoredPricing(undefined);
	}

	function changeModelId(value: string) {
		// 显示名称还跟着模型 ID 走（没人改过）时一起变。
		if (!name.trim() || name === modelId) setName(value);
		if (!imageTouched) setImageOutput(isImageModelId(value));
		setModelId(value);
	}

	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	async function submit(dismiss: Dismiss) {
		if (!valid || saving) return;
		const [parsedIn, parsedOut, parsedCacheRead, parsedCacheWrite] = parsed;
		// 档位以表单为准：从一个不支持思考的目录条目填过值后，原来的档位不该留下来。
		const { thinkingOptions: _replaced, pricing: _pricing, imageOutput: _judged, ...base } = model ?? {};
		const pricing: ModelPricing | undefined =
			storedPricing ??
			(parsedIn !== null && parsedOut !== null && parsedIn !== undefined && parsedOut !== undefined
				? {
						input: parsedIn,
						output: parsedOut,
						...(parsedCacheRead != null ? { cacheRead: parsedCacheRead } : {}),
						...(parsedCacheWrite != null ? { cacheWrite: parsedCacheWrite } : {}),
						source: "manual",
					}
				: undefined);
		const next: ModelConfig = {
			...base,
			id: `${provider.id}/${trimmedId}`,
			providerId: provider.id,
			modelId: trimmedId,
			name: name.trim() || trimmedId,
			contextWindow: window_,
			maxOutputTokens: output,
			supportsThinking,
			...(thinkingOptions ? { thinkingOptions } : {}),
			supportsImages,
			supportsTools,
			...(pricing ? { pricing } : {}),
		};
		// 只在和名字的判断不同时存；改回和名字一致，之前存的也就去掉了。
		if (imageOutput !== isImageModelId(trimmedId)) next.imageOutput = imageOutput;
		setSaving(true);
		setSaveError(null);
		const failure = await onSave(next);
		setSaving(false);
		if (failure) setSaveError(failure);
		else dismiss();
	}

	const priceField = (key: PriceKey, label: string) => (
		<Field label={label}>
			<TextInput
				value={prices[key]}
				onChange={(value) => {
					if (isLegalDraft(value, PRICE)) changePrice(key, value);
				}}
				placeholder={t("common.notSet")}
				mono
				inputMode="decimal"
			/>
		</Field>
	);

	return (
		<Overlay onClose={onCancel} width={560}>
			{(dismiss) => (
				<DialogFrame
					icon={<Box size={20} className="shrink-0 text-accent" />}
					title={model ? t("modelEditor.edit") : t("modelEditor.add")}
					// 这是一张表单，不是一个问题——默认那档高度一次只露三个字段。
					bodyClassName="max-h-[min(560px,58dvh)]"
					status={
						saveError ? (
							<Notice tone="danger" icon={CircleAlert} className="mb-1" data-model-editor-error="">
								{saveError}
							</Notice>
						) : undefined
					}
					actions={
						<>
							<div className="flex-1" />
							<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
							<DialogAction tone="primary" disabled={!valid || saving} aria-busy={saving} onClick={() => void submit(dismiss)} data-model-editor-save="">
								{t("common.save")}
							</DialogAction>
						</>
					}
				>
					<div className="space-y-4" data-model-editor="">
						<Field label={t("modelEditor.id")} hint={t("modelEditor.idDetail")}>
							<TextInput value={modelId} onChange={changeModelId} placeholder="deepseek-v4-flash" mono spellCheck={false} data-model-editor-id="" />
						</Field>

						<Field label={t("modelEditor.displayName")} hint={t("modelEditor.displayNameDetail")}>
							<TextInput value={name} onChange={setName} placeholder="DeepSeek V4 Flash" />
						</Field>

						<ModelCatalog suggestion={suggestion} onPick={fill} />

						{/* 生图模型没有值得设的上下文窗口和输出上限：藏起来，不清空。 */}
						{!imageOutput && (
							<div className="grid grid-cols-2 gap-3">
								<Field label={t("modelEditor.context")}>
									<TextInput
										value={contextWindow}
										onChange={(value) => {
											if (isLegalDraft(value, CONTEXT)) setContextWindow(value);
										}}
										mono
										inputMode="numeric"
									/>
								</Field>
								<Field label={t("modelEditor.maxOutput")}>
									<TextInput
										value={maxOutput}
										onChange={(value) => {
											if (isLegalDraft(value, OUTPUT)) setMaxOutput(value);
										}}
										mono
										inputMode="numeric"
									/>
								</Field>
							</div>
						)}

						<div className="space-y-3 rounded-lg border border-line px-3.5 py-3">
							<Capability
								label={t("modelEditor.imageOutput")}
								hint={t("modelEditor.imageOutputDetail")}
								checked={imageOutput}
								onChange={(value) => {
									setImageTouched(true);
									setImageOutput(value);
								}}
							/>
							{!imageOutput && <Capability label={t("modelEditor.thinking")} checked={supportsThinking} onChange={setSupportsThinking} />}
							{!imageOutput && supportsThinking && <ThinkingLevels options={thinkingOptions} onChange={setThinkingOptions} />}
							<Capability label={t("modelEditor.images")} checked={supportsImages} onChange={setSupportsImages} />
							{!imageOutput && <Capability label={t("modelEditor.toolCalls")} checked={supportsTools} onChange={setSupportsTools} />}
						</div>

						<div className="grid grid-cols-2 gap-3">
							{priceField("input", t("modelEditor.inputPrice"))}
							{priceField("output", t("modelEditor.outputPrice"))}
							{priceField("cacheRead", t("modelEditor.cacheReadPrice"))}
							{priceField("cacheWrite", t("modelEditor.cacheWritePrice"))}
						</div>
						<p className="-mt-2 text-detail text-ink-faint">
							{pricingEmpty
								? t("modelEditor.noPriceDetail")
								: storedPricing?.source === "catalog"
									? `${t("modelEditor.catalogPrice")}${storedPricing.tiers?.length ? t("modelEditor.catalogTiers", { n: storedPricing.tiers.length }) : ""}`
									: t("modelEditor.manualPrice")}
						</p>
					</div>
				</DialogFrame>
			)}
		</Overlay>
	);
}

/**
 * 模型可选的思考档位，每档单独开关。
 *
 * 没配置过时勾着的是默认那一组，动了任何一档才写进配置。自定义档位名（导入的配置里可能有）不在
 * 这里显示，原样保留。至少留一档：一档都没有，推理强度菜单就没东西可选了。
 */
function ThinkingLevels({ options, onChange }: { options: ThinkingOption[] | undefined; onChange: (options: ThinkingOption[]) => void }) {
	const { t } = useI18n();
	const current = options ?? DEFAULT_THINKING_OPTIONS;
	const selected = current.filter((option) => THINKING_LEVELS.includes(option.id)).map((option) => option.id);
	const custom = current.filter((option) => !THINKING_LEVELS.includes(option.id));

	function toggle(level: ThinkingLevel) {
		const next = selected.includes(level) ? selected.filter((id) => id !== level) : [...selected, level];
		if (next.length + custom.length === 0) return;
		onChange([...thinkingOptionsFor(next, current.find((option) => option.isDefault)?.id), ...custom]);
	}

	return (
		<div className="space-y-1.5">
			<span className="text-label text-ink">{t("modelEditor.thinkingLevels")}</span>
			<div className="flex flex-wrap gap-0.5 rounded-lg bg-card p-0.5">
				{THINKING_LEVELS.map((level) => (
					<button
						key={level}
						type="button"
						aria-pressed={selected.includes(level)}
						onClick={() => toggle(level)}
						className={`h-[26px] rounded-lg px-3 text-label transition-colors duration-[var(--plume-t-quick)] ${
							selected.includes(level) ? "bg-elevated text-ink" : "text-ink-faint hover:text-ink"
						}`}
					>
						{t(`thinking.${level}` as MessageKey)}
					</button>
				))}
			</div>
			<p className="text-detail text-ink-faint">{t("modelEditor.thinkingLevelsDetail")}</p>
		</div>
	);
}

function Capability({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
	return (
		<label className="flex items-center justify-between gap-4">
			<span className="min-w-0">
				<span className="block text-label text-ink">{label}</span>
				{hint && <span className="mt-0.5 block text-detail text-ink-faint">{hint}</span>}
			</span>
			<Toggle checked={checked} onChange={onChange} />
		</label>
	);
}
