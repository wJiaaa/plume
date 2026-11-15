/**
 * 设置 › 个性化里「身份与准则」那一节：列出内置的两套和自己写的，选一套给之后新开的会话用；内置的只能看、复制，自己写的能改、删。
 *
 * 编辑器开在列表下面，保存后收起。固定加上的几条只读地列在编辑器里，让人知道换准则换不掉它们。
 * 选的、写的都在逻辑入口那边（插件数据目录），经 `ui.remote()` 读写；校验也在那边，存不进去的原因按界面语言交回来。
 */

import type { Remote } from "@plume/contract/ui";
import { Button, ChoiceMark, Input, SettingsCard, SettingsNotice, SettingsSectionTitle, Text, TextArea, useConfirmer, useI18n } from "@plume/ui";
import { CircleAlert, Copy, Eye, Pencil, Trash2 } from "@plume/ui/icons";
import { field } from "@plume/styles";
import { useCallback, useEffect, useState } from "react";
import { type BuiltinId, type PresetDraft, type PresetsView, type PresetView, type PromptApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";

type Messages = (typeof MESSAGES)["zh-CN"];
type Notify = (message: string, level?: "info" | "warn" | "error") => void;

/** 正在看或改的那一套：`create` 是复制出来、还没存的；`view` 是内置的，只能看。 */
interface Editing {
	mode: "create" | "change" | "view";
	id?: string;
	draft: PresetDraft;
	original: PresetDraft;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const nameOf = (preset: PresetView, text: Messages) => (preset.builtin ? text[preset.id as BuiltinId] : (preset.name ?? preset.id));
const detailOf = (preset: PresetView, text: Messages) => (preset.builtin ? text[`${preset.id as BuiltinId}Detail`] : preset.identity.split("\n")[0]);
const draftOf = (preset: PresetView, text: Messages): PresetDraft => ({ name: nameOf(preset, text), identity: preset.identity, guidelines: preset.guidelines });

export function PresetSettings({ api, notify }: { api: Remote<PromptApi>; notify: Notify }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [view, setView] = useState<PresetsView | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [editing, setEditing] = useState<Editing | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const confirmer = useConfirmer();

	useEffect(() => {
		let live = true;
		api.view().then(
			(next) => live && setView(next),
			(cause: unknown) => live && setLoadError(reasonOf(cause)),
		);
		return () => {
			live = false;
		};
	}, [api]);

	const act = useCallback(
		(work: PromiseLike<PresetsView>) =>
			work.then(setView, (cause: unknown) => {
				notify(text.actionFailed(reasonOf(cause)), "error");
			}),
		[notify, text],
	);

	const open = (next: Editing) => {
		setError(null);
		setEditing(next);
	};

	const dirty = editing !== null && editing.mode !== "view" && JSON.stringify(editing.draft) !== JSON.stringify(editing.original);

	/** 关掉编辑器；有没存的改动先问一句。 */
	const close = (then?: () => void) => {
		const done = () => {
			setEditing(null);
			setError(null);
			then?.();
		};
		if (!dirty) return done();
		confirmer.ask({ title: text.discardTitle, confirmLabel: text.discard, cancelLabel: text.keepEditing, onConfirm: done });
	};

	const copy = (preset: PresetView) => {
		const draft = { ...draftOf(preset, text), name: text.copyName(nameOf(preset, text)) };
		close(() => open({ mode: "create", draft, original: draft }));
	};

	const remove = (preset: PresetView) => {
		const name = nameOf(preset, text);
		confirmer.ask({
			title: text.removeTitle(name),
			detail: text.removeDetail,
			confirmLabel: text.remove,
			cancelLabel: text.cancel,
			onConfirm: () => {
				if (editing?.id === preset.id) setEditing(null);
				void act(api.remove(preset.id));
			},
		});
	};

	const save = async () => {
		if (!editing || saving) return;
		setSaving(true);
		setError(null);
		try {
			setView(await api.save(editing.mode === "change" ? editing.id : undefined, editing.draft));
			setEditing(null);
			notify(text.saved);
		} catch (cause) {
			setError(reasonOf(cause));
		} finally {
			setSaving(false);
		}
	};

	if (loadError) {
		return (
			<Text as="p" size="label" tone="danger">
				{text.loadFailed(loadError)}
			</Text>
		);
	}
	if (!view) return null;

	const editDraft = (change: Partial<PresetDraft>) => setEditing((current) => current && { ...current, draft: { ...current.draft, ...change } });
	const readOnly = editing?.mode === "view";
	const titleOf = (current: Editing) =>
		current.mode === "create" ? text.newTitle : current.mode === "change" ? text.editTitle(current.original.name) : text.viewTitle(current.original.name);

	return (
		<div>
			<SettingsSectionTitle>{text.title}</SettingsSectionTitle>
			<Text as="p" size="caption" tone="muted" className="prompt-intro">
				{text.intro}
			</Text>
			{view.problem && (
				<SettingsNotice tone="accent" icon={CircleAlert} className="prompt-notice" data-prompt-preset-problem="">
					{view.problem.reason === "missing" ? text.problemMissing : text.problemInvalid}
				</SettingsNotice>
			)}
			<SettingsCard role="radiogroup" aria-label={text.title} data-prompt-presets="">
				{view.presets.map((preset) => {
					const selected = preset.id === view.selected;
					const name = nameOf(preset, text);
					return (
						<div key={preset.id} className="prompt-row" data-prompt-preset={preset.id}>
							<button type="button" role="radio" aria-checked={selected} className="prompt-choice" onClick={() => selected || void act(api.select(preset.id))}>
								<ChoiceMark kind="radio" checked={selected} />
								<span className="prompt-choice-body">
									<span className="prompt-choice-head">
										<Text size="label" weight="medium">
											{name}
										</Text>
										<Text size="caption" tone="faint">
											{preset.builtin ? text.builtinBadge : text.custom}
											{selected ? ` · ${text.inUse}` : ""}
										</Text>
									</span>
									<Text as="span" size="detail" tone="muted" className="prompt-choice-detail">
										{detailOf(preset, text)}
									</Text>
								</span>
							</button>
							<span className="prompt-actions">
								{preset.builtin ? (
									<Button
										size="sm"
										label={text.view}
										icon={<Eye size={14} strokeWidth={1.8} aria-hidden />}
										onClick={() => close(() => open({ mode: "view", id: preset.id, draft: draftOf(preset, text), original: draftOf(preset, text) }))}
									/>
								) : (
									<Button
										size="sm"
										label={text.edit}
										icon={<Pencil size={14} strokeWidth={1.8} aria-hidden />}
										onClick={() => close(() => open({ mode: "change", id: preset.id, draft: draftOf(preset, text), original: draftOf(preset, text) }))}
									/>
								)}
								<Button size="sm" label={text.copy} icon={<Copy size={14} strokeWidth={1.8} aria-hidden />} onClick={() => copy(preset)} />
								{!preset.builtin && (
									<Button size="sm" label={text.remove} icon={<Trash2 size={14} strokeWidth={1.8} aria-hidden />} onClick={() => remove(preset)} />
								)}
							</span>
						</div>
					);
				})}
			</SettingsCard>

			{editing && (
				<SettingsCard className="prompt-editor" data-prompt-editor={editing.mode}>
					<Text as="h3" size="label" weight="semibold">
						{titleOf(editing)}
					</Text>
					{!readOnly && (
						<label className="prompt-field">
							<Text size="label" weight="medium">
								{text.nameLabel}
							</Text>
							<Input name="presetName" className={field} value={editing.draft.name} onChange={(event) => editDraft({ name: event.target.value })} />
						</label>
					)}
					<div className="prompt-field">
						<Text size="label" weight="medium">
							{text.identityLabel}
						</Text>
						<TextArea
							name="presetIdentity"
							aria-label={text.identityLabel}
							value={editing.draft.identity}
							onChange={(identity) => editDraft({ identity })}
							readOnly={readOnly}
							rows={3}
							className="plume-textarea-mono"
						/>
						<Text size="caption" tone="faint">
							{text.identityHint}
						</Text>
					</div>
					<div className="prompt-field">
						<Text size="label" weight="medium">
							{text.guidelinesLabel}
						</Text>
						<TextArea
							name="presetGuidelines"
							aria-label={text.guidelinesLabel}
							value={editing.draft.guidelines}
							onChange={(guidelines) => editDraft({ guidelines })}
							readOnly={readOnly}
							rows={12}
							resizable
							className="plume-textarea-mono"
						/>
						<Text size="caption" tone="faint">
							{text.guidelinesHint}
						</Text>
					</div>
					<details className="prompt-fixed">
						<summary>
							<Text size="label" weight="medium">
								{text.fixedTitle}
							</Text>
						</summary>
						<Text as="p" size="caption" tone="faint">
							{text.fixedDetail}
						</Text>
						<ul>
							{view.fixed.map((line) => (
								<li key={line}>
									<Text size="detail" tone="muted">
										{line}
									</Text>
								</li>
							))}
						</ul>
					</details>
					{error && (
						<SettingsNotice tone="danger" icon={CircleAlert} data-prompt-save-error="">
							{error}
						</SettingsNotice>
					)}
					<div className="prompt-buttons">
						{readOnly ? (
							<>
								<Button
									variant="primary"
									onClick={() => {
										const preset = view.presets.find((each) => each.id === editing.id);
										if (preset) copy(preset);
									}}
								>
									{text.copy}
								</Button>
								<Button onClick={() => close()}>{text.close}</Button>
							</>
						) : (
							<>
								<Button
									variant="primary"
									loading={saving}
									disabled={editing.draft.name.trim() === "" || editing.draft.identity.trim() === ""}
									onClick={() => void save()}
								>
									{text.save}
								</Button>
								<Button onClick={() => close()}>{text.cancel}</Button>
							</>
						)}
					</div>
				</SettingsCard>
			)}
			{confirmer.element}
		</div>
	);
}
