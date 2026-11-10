/**
 * 添加一个模型供应商：名字、API 格式、地址、Key 一次填齐再存。
 *
 * 从前点「添加供应商」就往列表里存一个叫「新供应商」、地址是 `https://` 的空壳，再去右边一格格改；
 * 改到一半切走，空壳就留在列表里。现在填齐了才存。不再给预设的几家：地址和格式由人照着自己的服务填。
 */

import type { ApiFormat } from "@plume/contract";
import { Dialog, DialogAction, type Dismiss, useI18n } from "@plume/ui";
import { useEffect, useState } from "react";
import { SecretInput, Segmented, TextInput, Toggle } from "../controls.tsx";
import { DialogField, EnterSubmits } from "../dialog-form.tsx";
import { API_OPTIONS } from "./ProviderEditor.tsx";

interface Draft {
	name: string;
	baseUrl: string;
	api: ApiFormat;
	apiKey: string;
}

export function ProviderAddDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (draft: Draft, fetch: boolean) => void }) {
	const { t } = useI18n();
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState<ApiFormat>("openai-chat-completions");
	const [apiKey, setApiKey] = useState("");
	const [fetch, setFetch] = useState(true);

	useEffect(() => {
		document.getElementById("provider-name")?.focus();
	}, []);

	const url = baseUrl.trim();
	const badUrl = url !== "" && !/^https?:\/\/\S+$/.test(url);
	const ready = name.trim() !== "" && url !== "" && !badUrl;

	function submit(dismiss: Dismiss) {
		if (!ready) return;
		const draft: Draft = { name: name.trim(), baseUrl: url, api, apiKey: apiKey.trim() };
		dismiss(() => {
			onAdd(draft, fetch);
			onClose();
		});
	}

	return (
		<Dialog
			onClose={onClose}
			width={560}
			label={t("providerAdd.title")}
			title={t("providerAdd.title")}
			bodyClassName="max-h-[min(560px,64dvh)]"
			actions={(dismiss) => (
				<>
					<div className="flex-1" />
					<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
					<DialogAction tone="primary" disabled={!ready} onClick={() => submit(dismiss)} data-provider-add="">
						{t("modelSettings.addProvider")}
					</DialogAction>
				</>
			)}
		>
			{(dismiss) => (
				<form
					data-provider-form=""
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						submit(dismiss);
					}}
				>
					<DialogField label={t("providerAdd.name")} htmlFor="provider-name">
						<TextInput id="provider-name" value={name} onChange={setName} placeholder={t("providerAdd.namePlaceholder")} autoComplete="off" />
					</DialogField>
					<DialogField label={t("provider.apiFormat")} hint={t("provider.apiFormatDetail")}>
						{/* 分段控件按字宽排，放进整行的字段里会被撑满。 */}
						<div className="w-fit">
							<Segmented value={api} onChange={setApi} options={API_OPTIONS} />
						</div>
					</DialogField>
					<DialogField label="Base URL" htmlFor="provider-url" error={badUrl ? t("providerAdd.urlInvalid") : null}>
						<TextInput
							id="provider-url"
							value={baseUrl}
							onChange={setBaseUrl}
							invalid={badUrl}
							mono
							placeholder="https://api.example.com/v1"
							spellCheck={false}
							autoComplete="off"
						/>
					</DialogField>
					<DialogField label="API Key" htmlFor="provider-key" optional hint={t("providerAdd.keyOptionalHint")}>
						<SecretInput id="provider-key" value={apiKey} onChange={setApiKey} placeholder="sk-…" />
					</DialogField>
					<div className="flex items-center justify-between gap-4">
						<div className="min-w-0">
							<div className="text-detail font-medium text-ink">{t("providerAdd.fetch")}</div>
							<div className="mt-0.5 text-caption text-ink-faint">{t("providerAdd.fetchDetail")}</div>
						</div>
						<Toggle checked={fetch} onChange={setFetch} ariaLabel={t("providerAdd.fetch")} />
					</div>
					<EnterSubmits />
				</form>
			)}
		</Dialog>
	);
}
