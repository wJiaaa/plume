/** 设置页里「浏览器」那一节：地址栏用哪家搜索、新页面的缩放、能做什么的说明、书签。 */

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Remote, UiContext } from "@plume/contract/ui";
import { IconButton, InlineSelect, Input, ScrollText, SettingsCard, SettingsRow, SettingsSectionTitle, Text, useI18n } from "@plume/ui";
import { field } from "@plume/styles";
import { ExternalLink, Trash2 } from "@plume/ui/icons";
import type { BrowserApi, SearchEngine } from "./api.ts";
import { customSearchProblem, SEARCH_ENGINES } from "./address.ts";
import { MESSAGES } from "./messages.ts";
import type { BrowserStore } from "./store.ts";

const ZOOMS = [0.75, 1, 1.25, 1.5, 2];

export function browserSettings(ui: UiContext, api: Remote<BrowserApi>, store: BrowserStore) {
	return function BrowserSettings() {
		const text = MESSAGES[useI18n().resolvedLocale];
		const { settings } = useSyncExternalStore(store.subscribe, store.get);
		const fail = (error: unknown) => ui.notify(error instanceof Error ? error.message : String(error), "error");
		const patch = (next: Parameters<BrowserStore["saveSettings"]>[0]) => void store.saveSettings(next).catch(fail);
		/*
		 * 搜索地址在放得进搜索词之前只是草稿：每敲一下就存，存下的是写了一半的地址，地址栏在写完之前一直悄悄退回必应。
		 * 失焦时才存，而且要能用。
		 */
		const [draft, setDraft] = useState(settings.searchUrl);
		const [problem, setProblem] = useState<"needsQuery" | "notWeb" | null>(null);
		useEffect(() => {
			setDraft(settings.searchUrl);
			setProblem(null);
		}, [settings.searchUrl]);
		const commit = () => {
			const found = draft.trim() ? customSearchProblem(draft) : null;
			setProblem(found);
			if (!found) patch({ searchUrl: draft.trim() });
		};
		// 引擎名是牌子；最后那个「自定义」是界面词，跟着语言走。
		const engines: { value: SearchEngine; label: string }[] = [
			...SEARCH_ENGINES.map((engine) => ({ value: engine.id, label: text.engines[engine.id] })),
			{ value: "custom", label: text.settings.custom },
		];

		return (
			<>
				<SettingsSectionTitle>{text.settings.habits}</SettingsSectionTitle>
				<SettingsCard className="plume-browser-settings-card" data-browser-settings="">
					<SettingsRow
						title={text.settings.openLinksWith}
						control={
							<InlineSelect
								value={settings.openLinks}
								options={[
									{ value: "system", label: text.settings.systemBrowser },
									{ value: "builtin", label: text.settings.builtin },
								]}
								onChange={(openLinks) => patch({ openLinks })}
							/>
						}
					/>
					<SettingsRow
						title={text.settings.addressSearch}
						detail={text.settings.addressSearchDetail}
						control={
							<InlineSelect
								value={settings.searchEngine}
								options={engines}
								onChange={(searchEngine) => patch({ searchEngine })}
								ariaLabel={text.settings.searchEngine}
							/>
						}
					>
						{settings.searchEngine === "custom" && (
							<div className="plume-browser-search-custom" data-search-custom="">
								<Text size="label" mono>
									<Input
										value={draft}
										onChange={(event) => setDraft(event.target.value)}
										onBlur={commit}
										aria-invalid={problem ? true : undefined}
										placeholder="https://example.com/search?q=%s"
										aria-label={text.settings.searchUrl}
										spellCheck={false}
										className={`${field} plume-browser-wide`}
									/>
								</Text>
								<Text as="p" size="caption" tone={problem ? "danger" : "faint"}>
									{problem ? text.settings[problem] : text.settings.searchEngineDetail}
								</Text>
							</div>
						)}
					</SettingsRow>
					<SettingsRow
						title={text.settings.zoom}
						control={
							<InlineSelect
								value={String(settings.defaultZoom)}
								options={ZOOMS.map((factor) => ({ value: String(factor), label: `${factor * 100}%` }))}
								onChange={(factor) => patch({ defaultZoom: Number(factor) })}
							/>
						}
					/>
					<SettingsRow title={text.settings.agentControl} detail={text.settings.agentControlDetail} />
					<SettingsRow title={text.settings.inspect} detail={text.settings.inspectDetail} />
					<SettingsRow title={text.settings.devtools} detail={text.settings.devtoolsDetail} />
				</SettingsCard>
				<SettingsSectionTitle>{text.bookmarks}</SettingsSectionTitle>
				<SettingsCard className="plume-browser-settings-card">
					{settings.bookmarks.length > 0 ? (
						settings.bookmarks.map((bookmark) => (
							<SettingsRow
								key={bookmark.url}
								title={<ScrollText text={bookmark.title} />}
								detail={<ScrollText text={bookmark.url} />}
								control={
									<div className="plume-browser-row-actions">
										<IconButton
											label={text.settings.openBookmark}
											icon={<ExternalLink size={14} />}
											onClick={() => void api.open(bookmark.url, null).catch(fail)}
										/>
										<IconButton
											label={text.settings.deleteBookmark}
											tone="danger"
											icon={<Trash2 size={14} />}
											onClick={() => patch({ bookmarks: settings.bookmarks.filter((item) => item.url !== bookmark.url) })}
										/>
									</div>
								}
							/>
						))
					) : (
						<div className="plume-browser-bookmarks-empty">
							<Text as="p" size="label" tone="muted">
								{text.settings.bookmarksEmpty}
							</Text>
						</div>
					)}
				</SettingsCard>
			</>
		);
	};
}
