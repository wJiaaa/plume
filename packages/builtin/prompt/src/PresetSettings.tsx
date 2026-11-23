/**
 * 设置 › 个性化里「身份与准则」那一节：列出内置的两套和自己写的，选一套给之后新开的会话用；能新建，都能改、复制，内置的改过能恢复默认，自己写的能删。
 *
 * 改在弹窗里：身份、准则是几屏长的英文，铺在设置页里会把列表挤下去。
 * 选的、写的都在逻辑入口那边（插件数据目录），经 `ui.remote()` 读写；校验也在那边，存不进去的原因按界面语言交回来。
 */

import type { Remote } from "@plume/contract/ui";
import {
	ChoiceMark,
	Dialog,
	DialogAction,
	IconButton,
	Input,
	SettingsCard,
	SettingsNotice,
	SettingsSectionTitle,
	Text,
	TextArea,
	useConfirmer,
	useI18n,
} from "@plume/ui";
import { CircleAlert, Copy, Pencil, Plus, RotateCcw, Trash2 } from "@plume/ui/icons";
import { field } from "@plume/styles";
import { useCallback, useEffect, useRef, useState } from "react";
import { type BuiltinId, type PresetDraft, type PresetsView, type PresetView, type PromptApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";

type Messages = (typeof MESSAGES)["zh-CN"];
type Notify = (message: string, level?: "info" | "warn" | "error") => void;

/** 正在改的那一套：`create` 是新建或复制出来、还没存的。`key` 认没存的草稿：Esc 关掉后再打开同一套还在。内置的不改名字。 */
interface Editing {
	mode: "create" | "change";
	key: string;
	id?: string;
	builtin: boolean;
	draft: PresetDraft;
	original: PresetDraft;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const nameOf = (preset: PresetView, text: Messages) => (preset.builtin ? text[preset.id as BuiltinId] : (preset.name ?? preset.id));
const detailOf = (preset: PresetView, text: Messages) => (preset.builtin ? text[`${preset.id as BuiltinId}Detail`] : preset.identity.split("\n")[0]);
const draftOf = (preset: PresetView, text: Messages): PresetDraft => ({ name: nameOf(preset, text), identity: preset.identity, guidelines: preset.guidelines });
const isDirty = (editing: Editing) => JSON.stringify(editing.draft) !== JSON.stringify(editing.original);

export function PresetSettings({ api, notify }: { api: Remote<PromptApi>; notify: Notify }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [view, setView] = useState<PresetsView | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [editing, setEditing] = useState<Editing | null>(null);
	// Esc、点遮罩关掉时没存的字留在这里，下次打开同一套还在；只有「取消」先问一句再扔。
	const drafts = useRef(new Map<string, PresetDraft>());
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

	const open = (next: Omit<Editing, "draft">) => setEditing({ ...next, draft: drafts.current.get(next.key) ?? next.original });

	const create = () => open({ mode: "create", key: "new", builtin: false, original: { name: "", identity: "", guidelines: "" } });

	const copy = (preset: PresetView) => {
		const original = { ...draftOf(preset, text), name: text.copyName(nameOf(preset, text)) };
		open({ mode: "create", key: `copy:${preset.id}`, builtin: false, original });
	};

	const remove = (preset: PresetView) => {
		confirmer.ask({
			title: text.removeTitle(nameOf(preset, text)),
			detail: text.removeDetail,
			confirmLabel: text.remove,
			cancelLabel: text.cancel,
			onConfirm: () => {
				drafts.current.delete(preset.id);
				void act(api.remove(preset.id));
			},
		});
	};

	const reset = (preset: PresetView) => {
		confirmer.ask({
			title: text.resetTitle(nameOf(preset, text)),
			detail: text.resetDetail,
			confirmLabel: text.reset,
			cancelLabel: text.cancel,
			onConfirm: () => {
				drafts.current.delete(preset.id);
				void act(api.reset(preset.id));
			},
		});
	};

	if (loadError) {
		return (
			<Text as="p" size="label" tone="danger">
				{text.loadFailed(loadError)}
			</Text>
		);
	}
	if (!view) return null;

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
			<SettingsCard>
				{/* 选哪一套是一组单选；末尾的「新建一套」不是选项，放在这一组外面。 */}
				<div role="radiogroup" aria-label={text.title} data-prompt-presets="" data-settings-item="">
					{view.presets.map((preset) => {
						const selected = preset.id === view.selected;
						return (
							<div key={preset.id} className="prompt-row" data-prompt-preset={preset.id}>
								<button
									type="button"
									role="radio"
									aria-checked={selected}
									className="prompt-choice"
									onClick={() => selected || void act(api.select(preset.id))}
								>
									<ChoiceMark kind="radio" checked={selected} />
									<span className="prompt-choice-body">
										<span className="prompt-choice-head">
											<Text size="label">{nameOf(preset, text)}</Text>
											<Text size="caption" tone="faint">
												{preset.builtin ? text.builtinBadge : text.custom}
												{preset.modified ? ` · ${text.modified}` : ""}
												{selected ? ` · ${text.inUse}` : ""}
											</Text>
										</span>
										<Text as="span" size="detail" tone="muted" className="prompt-choice-detail">
											{detailOf(preset, text)}
										</Text>
									</span>
								</button>
								{/* 悬停或聚焦到这一行时才出现，和子智能体、命令那几行一样。 */}
								<span className="prompt-actions">
									<IconButton
										label={text.edit}
										icon={<Pencil size={14} aria-hidden />}
										onClick={() => open({ mode: "change", key: preset.id, id: preset.id, builtin: preset.builtin, original: draftOf(preset, text) })}
									/>
									<IconButton label={text.copy} icon={<Copy size={14} aria-hidden />} onClick={() => copy(preset)} />
									{preset.modified && <IconButton label={text.reset} icon={<RotateCcw size={14} aria-hidden />} onClick={() => reset(preset)} />}
									{!preset.builtin && <IconButton label={text.remove} icon={<Trash2 size={14} aria-hidden />} onClick={() => remove(preset)} />}
								</span>
							</div>
						);
					})}
				</div>
				{/* 列表只有几行，新建放在末尾最顺手：和各套同一种行，平常就看得见，不靠悬停才出现。 */}
				<button type="button" className="prompt-row prompt-create" onClick={create} data-prompt-create="" data-settings-item="">
					<Plus size={16} aria-hidden />
					<Text size="label" tone="muted">
						{text.create}
					</Text>
				</button>
			</SettingsCard>

			{editing && (
				<PresetDialog
					// 内置那套里按「复制」会换成新的一份草稿：换 key 让弹窗里的状态（出错、问放弃）从头来。
					key={`${editing.mode}:${editing.key}`}
					editing={editing}
					text={text}
					onChange={(draft) => {
						const next = { ...editing, draft };
						setEditing(next);
						if (isDirty(next)) drafts.current.set(editing.key, draft);
						else drafts.current.delete(editing.key);
					}}
					onSave={async (draft) => {
						setView(await api.save(editing.mode === "change" ? editing.id : undefined, draft));
						drafts.current.delete(editing.key);
						notify(text.saved);
					}}
					onDiscard={() => drafts.current.delete(editing.key)}
					onClose={() => setEditing(null)}
				/>
			)}
			{confirmer.element}
		</div>
	);
}

function PresetDialog({
	editing,
	text,
	onChange,
	onSave,
	onDiscard,
	onClose,
}: {
	editing: Editing;
	text: Messages;
	onChange: (draft: PresetDraft) => void;
	onSave: (draft: PresetDraft) => Promise<void>;
	onDiscard: () => void;
	onClose: () => void;
}) {
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [leaving, setLeaving] = useState(false);
	const { draft } = editing;
	const edit = (change: Partial<PresetDraft>) => onChange({ ...draft, ...change });
	const title = editing.mode === "create" ? text.newTitle : text.editTitle(editing.original.name);

	const save = async (dismiss: () => void) => {
		if (saving) return;
		setSaving(true);
		setError(null);
		try {
			await onSave(draft);
			dismiss();
		} catch (cause) {
			setError(reasonOf(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog
			onClose={onClose}
			width={640}
			label={title}
			title={title}
			detail={editing.builtin ? text.builtinNote : undefined}
			bodyClassName="prompt-dialog-body"
			data-prompt-editor={editing.mode}
			status={
				error ? (
					<Text as="p" size="detail" tone="danger" role="alert" className="prompt-dialog-error" data-prompt-save-error="">
						{error}
					</Text>
				) : undefined
			}
			actions={(dismiss) => {
				// 「放弃没保存的改动？」就问在按下取消的那一排：底栏原地换成这句话和两个去处。
				if (leaving)
					return (
						<>
							<Text size="detail" role="alert" className="prompt-leaving">
								{text.discardTitle}
							</Text>
							<DialogAction autoFocus onClick={() => setLeaving(false)}>
								{text.keepEditing}
							</DialogAction>
							<DialogAction
								tone="danger"
								onClick={() => {
									onDiscard();
									dismiss();
								}}
							>
								{text.discard}
							</DialogAction>
						</>
					);
				return (
					<>
						<DialogAction disabled={saving} onClick={() => (isDirty(editing) ? setLeaving(true) : dismiss())}>
							{text.cancel}
						</DialogAction>
						<DialogAction tone="primary" disabled={saving || draft.name.trim() === "" || draft.identity.trim() === ""} onClick={() => void save(dismiss)}>
							{text.save}
						</DialogAction>
					</>
				);
			}}
		>
			<div className="prompt-form">
				{!editing.builtin && (
					<label className="prompt-field">
						<Text size="label" weight="medium">
							{text.nameLabel}
						</Text>
						<Input name="presetName" className={field} value={draft.name} onChange={(event) => edit({ name: event.target.value })} autoFocus />
					</label>
				)}
				<div className="prompt-field">
					<Text size="label" weight="medium">
						{text.identityLabel}
					</Text>
					<TextArea
						name="presetIdentity"
						aria-label={text.identityLabel}
						value={draft.identity}
						onChange={(identity) => edit({ identity })}
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
						value={draft.guidelines}
						onChange={(guidelines) => edit({ guidelines })}
						rows={10}
						resizable
						className="plume-textarea-mono"
					/>
					<Text size="caption" tone="faint">
						{text.guidelinesHint}
					</Text>
				</div>
			</div>
		</Dialog>
	);
}
