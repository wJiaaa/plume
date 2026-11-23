/**
 * 一个供应商，写成表单。
 *
 * 连上一个端点要的都在这里：叫什么、在哪、说哪种协议、key。它的模型在隔壁的 ProviderModels——那是另一个问题，
 * 这个答完了才问。
 *
 * 文本框每敲一个字就存，不等失焦：等失焦的话，敲完地址直接点「测试」测的是上一个地址，而那正是最不愿意相信答案的时候。
 * key 不下发到界面：输入框一开始是空的，已经存过 key 时提示「已保存」，填了新的才替换。
 * 插件提供的供应商（外部应用写给插件的网关）使用同一套编辑操作，agent 进程把修改交回那个插件保存。
 */

import type { ApiFormat, ProviderTestResult } from "@plume/contract";
import { ActionSpinner, DialogAction, IconButton, Input, useConfirmer, useI18n } from "@plume/ui";
import { Activity, Check, CircleAlert, CircleHelp, Pencil, Trash2 } from "@plume/ui/icons";
import { type ReactNode, useState } from "react";
import type { ModelConfig, ProviderEntry } from "../../models/store.ts";
import { Notice, SecretInput, Segmented, TextInput, Toggle } from "../controls.tsx";
import { Card, SectionTitle } from "../layout.tsx";
import { ProviderAvatar } from "./ProviderAvatar.tsx";
import { ProviderModels } from "./ProviderModels.tsx";
import type { ProviderPatch } from "./useProviders.ts";

/** 切换里用短名；每种发到哪个路径写在旁边的说明里——带上路径，三段在 420px 宽的窗格里就放不下了。 */
export const API_OPTIONS: { value: ApiFormat; label: string }[] = [
	{ value: "openai-responses", label: "Responses" },
	{ value: "openai-chat-completions", label: "Chat Completions" },
	{ value: "anthropic-messages", label: "Messages" },
];

export function ProviderEditor({
	provider,
	managedBy,
	defaultModelId,
	testResult,
	testing,
	testingModelIds,
	modelTestResults,
	fetchingModels,
	fetchModelsError,
	saveError,
	onFetchModels,
	onTest,
	onTestModel,
	onChange,
	onRemove,
	onEditModel,
	onRemoveModel,
	onRemoveModels,
	onSetDefault,
}: {
	provider: ProviderEntry;
	/** 由插件提供时是那个插件的显示名：提示改动由它保存，它的来源再同步时可能覆盖。 */
	managedBy: string | undefined;
	defaultModelId: string | null;
	testResult: ProviderTestResult | null;
	testing: boolean;
	testingModelIds?: ReadonlySet<string>;
	modelTestResults?: Record<string, ProviderTestResult>;
	fetchingModels?: boolean;
	fetchModelsError?: string | null;
	/** 最近一次没存进去的原因（比如地址还没敲完）。 */
	saveError?: string | null;
	onFetchModels?: () => void;
	onTest: () => void;
	onTestModel?: (modelId: string) => void;
	onChange: (patch: ProviderPatch) => void;
	onRemove: () => void;
	onEditModel: (model: ModelConfig | null) => void;
	onRemoveModel: (modelId: string) => void;
	onRemoveModels: (modelIds: string[]) => void;
	onSetDefault: (modelId: string) => void;
}) {
	const { t } = useI18n();
	const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
	const [apiKey, setApiKey] = useState("");

	return (
		/*
		 * 撑满窗格，让滚动的是模型列表而不是窗格：翻长长的模型列表时，名字和连接一直看得见。
		 * 在窗格的 flex 列里用 flex-1 而不是 h-full：h-full 钉在可见高度上，比窗格高的列会穿过底部内边距跑出去；
		 * 作为 flex 子项它不会小于内容的最小高度，窗格矮到连那都放不下时，滚动的是整个编辑器。
		 */
		<div className="@container flex flex-1 flex-col" data-provider-editor={provider.id}>
			<ProviderHeading provider={provider} onChange={onChange} onRemove={onRemove} />

			{managedBy && (
				<Notice tone="accent" className="mt-5" data-provider-managed="">
					{t("modelSettings.pluginManaged", { plugin: managedBy })}
				</Notice>
			)}
			{saveError && (
				<Notice tone="danger" icon={CircleAlert} className="mt-5" data-provider-save-error="">
					{saveError}
				</Notice>
			)}

			{/* 停用的供应商照样能改，只是淡一些：它不是正在用的那个。 */}
			<div className={`flex flex-1 flex-col transition-opacity ${provider.enabled ? "" : "opacity-60"}`}>
				<section className="pt-7">
					<SectionTitle>{t("provider.connection")}</SectionTitle>
					<Card data-provider-connection="">
						<FieldRow label="Base URL">
							{provider.route ? (
								<span className="min-w-0 break-all font-mono text-detail text-ink-muted">{provider.baseUrl}</span>
							) : (
								<TextInput
									mono
									value={baseUrl}
									onChange={(value) => {
										setBaseUrl(value);
										onChange({ baseUrl: value.trim() });
									}}
									placeholder="https://api.example.com/v1"
									spellCheck={false}
									data-provider-url=""
								/>
							)}
						</FieldRow>

						<FieldRow label={t("provider.apiFormat")}>
							{provider.route ? (
								<span className="text-label text-ink-muted">{API_OPTIONS.find((option) => option.value === provider.api)?.label ?? provider.api}</span>
							) : (
								<>
									<Segmented value={provider.api} onChange={(api) => onChange({ api })} options={API_OPTIONS} />
									<span
										role="img"
										aria-label={t("provider.apiFormatDetail")}
										data-plume-tip={t("provider.apiFormatDetail")}
										className="shrink-0 text-ink-faint"
									>
										<CircleHelp size={14} strokeWidth={1.8} />
									</span>
								</>
							)}
						</FieldRow>

						{/* 专用通道的凭据只在插件逻辑入口，界面不提供一个实际不会生效的密钥框。 */}
						<FieldRow
							label={provider.route ? t("modelSettings.testConnection") : "API Key"}
							// 只有失败的话要紧：有东西要修，而只有端点知道是什么。
							note={testResult && !testResult.ok ? <p className="text-detail break-words text-danger">{testResult.message}</p> : null}
						>
							{provider.route ? null : (
								<SecretInput
									value={apiKey}
									saved={provider.hasKey}
									onChange={(value) => {
										setApiKey(value);
										if (value.trim()) onChange({ apiKey: value });
									}}
									placeholder="sk-…"
								/>
							)}
							<TestButton result={testResult} testing={testing} onTest={onTest} />
						</FieldRow>
					</Card>
				</section>

				<ProviderModels
					models={provider.models}
					defaultModelId={defaultModelId}
					testing={testing}
					testingModelIds={testingModelIds}
					modelTestResults={modelTestResults}
					fetchingModels={fetchingModels}
					fetchModelsError={fetchModelsError}
					onFetchModels={onFetchModels}
					onTestModel={onTestModel}
					onEdit={onEditModel}
					onRemove={onRemoveModel}
					onRemoveMany={onRemoveModels}
					onSetDefault={onSetDefault}
				/>
			</div>
		</div>
	);
}

/** 标签和控件在一行；窗格窄到放不下两样时标签放到上面。内边距和分隔线同 Row，这张卡片和别的页面是同一种卡片。 */
function FieldRow({ label, note, children }: { label: string; note?: ReactNode; children: ReactNode }) {
	return (
		<div data-settings-item="" className="plume-settings-row grid grid-cols-1 gap-x-3 gap-y-1.5 @md:grid-cols-[84px_minmax(0,1fr)] @md:items-center">
			<span className="text-label text-ink">{label}</span>
			<div className="flex min-w-0 items-center gap-2">{children}</div>
			{note && <div className="@md:col-start-2">{note}</div>}
		</div>
	);
}

/** 结论写在问它的那颗按钮上。通过是一个延迟加一个勾，完整的话在提示里。 */
function TestButton({ result, testing, onTest }: { result: ProviderTestResult | null; testing: boolean; onTest: () => void }) {
	const { t } = useI18n();
	if (testing) {
		return (
			<DialogAction disabled className="shrink-0" data-provider-test="testing">
				<ActionSpinner size={13} />
				{t("providerModels.testing")}
			</DialogAction>
		);
	}
	if (result && !result.ok) {
		return (
			<DialogAction tone="danger" onClick={onTest} label={t("modelSettings.testConnection")} className="shrink-0" data-provider-test="failed">
				<CircleAlert size={13} strokeWidth={2} aria-hidden />
				{t("providerModels.testFailed")}
			</DialogAction>
		);
	}
	return (
		<DialogAction
			onClick={onTest}
			label={result ? `${result.message}${result.latencyMs > 0 ? ` · ${result.latencyMs} ms` : ""}` : t("modelSettings.testConnection")}
			className="shrink-0"
			data-provider-test={result ? "passed" : "idle"}
		>
			{result ? (
				// 颜色上在子元素上：次要按钮自己的颜色不在层里，压过按钮上的工具类。
				<span className="flex items-center gap-1.5 text-ok">
					<Check size={13} strokeWidth={2.2} aria-hidden />
					<span className="font-mono tabular-nums">{result.latencyMs > 0 ? `${result.latencyMs}ms` : t("providerModels.testPassed")}</span>
				</span>
			) : (
				<>
					<Activity size={13} strokeWidth={1.9} aria-hidden />
					{t("provider.test")}
				</>
			)}
		</DialogAction>
	);
}

/** 名字、它是什么，以及对整个供应商能做的事。 */
function ProviderHeading({ provider, onChange, onRemove }: { provider: ProviderEntry; onChange: (patch: ProviderPatch) => void; onRemove: () => void }) {
	const { t } = useI18n();
	const [name, setName] = useState(provider.name);
	const [renaming, setRenaming] = useState(false);
	const confirm = useConfirmer();
	const api = API_OPTIONS.find((option) => option.value === provider.api)?.label ?? provider.api;

	return (
		<div className="flex items-center gap-3">
			<ProviderAvatar name={provider.name} size="lg" className={provider.enabled ? "" : "opacity-50"} />
			<div className="min-w-0 flex-1">
				{renaming ? (
					<Input
						autoFocus
						value={name}
						onChange={(event) => setName(event.target.value)}
						onBlur={() => {
							setRenaming(false);
							if (name.trim() && name !== provider.name) onChange({ name: name.trim() });
						}}
						onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
						className="-mx-1.5 h-7 w-full max-w-[320px] rounded-md bg-card px-1.5 text-title font-semibold text-ink"
					/>
				) : (
					// 名字本身就是改名的入口：旁边再放一支笔是第二样说同一件事的东西。
					<button
						type="button"
						onClick={() => setRenaming(true)}
						data-plume-tip={t("provider.rename")}
						className="-mx-1.5 block h-7 max-w-full truncate rounded-md px-1.5 text-left text-title font-semibold tracking-tight text-ink transition-colors hover:bg-card-hover"
					>
						{provider.name}
					</button>
				)}
				<p className="text-detail text-ink-muted">{t("provider.summary", { api, n: provider.models.length })}</p>
			</div>

			{/* 开关同时说状态和动作。 */}
			<Toggle checked={provider.enabled} onChange={(enabled) => onChange({ enabled })} ariaLabel={t("provider.enable")} />
			{/* 两个动作都看得见：藏在 ⋯ 后面的话，哪个都得先打开菜单才找得到。 */}
			<span className="flex items-center">
				<IconButton label={t("provider.rename")} onClick={() => setRenaming(true)} icon={<Pencil size={14} strokeWidth={1.8} />} data-provider-rename="" />
				<IconButton
					label={t("provider.delete")}
					tone="danger"
					onClick={() =>
						confirm.ask({
							title: t("provider.deleteConfirm", { name: provider.name }),
							detail: t("provider.deleteDetail", { n: provider.models.length }),
							confirmLabel: t("common.delete"),
							onConfirm: onRemove,
						})
					}
					icon={<Trash2 size={14} strokeWidth={1.8} />}
					data-provider-delete=""
				/>
			</span>

			{confirm.element}
		</div>
	);
}
