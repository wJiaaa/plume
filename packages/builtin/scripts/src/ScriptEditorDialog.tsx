import { Button, Dialog, Input, Popover, SettingsCard, Text, TextArea, Toggle, useConfirmer, useI18n, usePopover } from "@plume/ui";
import { useState } from "react";
import { MESSAGES } from "./messages.ts";
import { ScriptIcon } from "./ScriptIcon.tsx";
import { SCRIPT_ICONS, type ProjectScript, type ScriptIconId, type ScriptInput } from "./types.ts";

export interface ScriptEditorDialogProps {
	script: ProjectScript | null;
	onSave: (scriptId: string | null, input: ScriptInput) => Promise<void>;
	onDelete?: (scriptId: string) => Promise<void>;
	onClose: () => void;
}

export function ScriptEditorDialog({ script, onSave, onDelete, onClose }: ScriptEditorDialogProps) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const editing = script !== null;
	const [name, setName] = useState(script?.name ?? "");
	const [command, setCommand] = useState(script?.command ?? "");
	const [icon, setIcon] = useState<ScriptIconId>(script?.icon ?? "play");
	const [previewUrl, setPreviewUrl] = useState(script?.previewUrl ?? "");
	const [autoOpenPreview, setAutoOpenPreview] = useState(script?.autoOpenPreview === true);
	const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(script?.runOnWorktreeCreate === true);
	const [waitForSetup, setWaitForSetup] = useState(script?.runOnWorktreeCreate === true && script?.waitForSetup === true);
	const [stopOnArchive, setStopOnArchive] = useState(script?.stopOnArchive === true);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const iconMenu = usePopover();
	const confirmer = useConfirmer();

	const trimmedName = name.trim();
	const trimmedCommand = command.trim();
	const trimmedPreview = previewUrl.trim();

	const submit = async (dismiss: () => void) => {
		if (saving) return;
		if (!trimmedName) {
			setError(text.nameRequired);
			return;
		}
		if (!trimmedCommand) {
			setError(text.commandRequired);
			return;
		}
		setError(null);
		setSaving(true);
		try {
			await onSave(script?.id ?? null, {
				name: trimmedName,
				command: trimmedCommand,
				icon,
				runOnWorktreeCreate,
				waitForSetup: runOnWorktreeCreate && waitForSetup,
				stopOnArchive,
				...(trimmedPreview ? { previewUrl: trimmedPreview } : {}),
				autoOpenPreview: trimmedPreview.length > 0 && autoOpenPreview,
			});
			dismiss();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};

	const requestDelete = (dismiss: () => void) => {
		if (!script || !onDelete) return;
		confirmer.ask({
			title: text.deleteConfirmTitle(script.name),
			detail: text.deleteConfirmDetail,
			confirmLabel: text.deleteConfirmAction,
			cancelLabel: text.cancel,
			onConfirm: () => {
				void onDelete(script.id)
					.then(() => dismiss())
					.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
			},
		});
	};

	return (
		<>
			<Dialog
				onClose={onClose}
				width={480}
				title={editing ? text.editScript : text.addScript}
				icon={<ScriptIcon icon={icon} size={16} />}
				actions={(dismiss) => (
					<>
						{editing && onDelete && (
							<>
								<Button variant="danger" disabled={saving} onClick={() => requestDelete(dismiss)}>
									{text.deleteScript}
								</Button>
								<span className="plume-scripts-dialog-spacer" />
							</>
						)}
						<Button disabled={saving} onClick={() => dismiss()}>
							{text.cancel}
						</Button>
						<Button variant="primary" loading={saving} disabled={!trimmedName || !trimmedCommand} onClick={() => void submit(dismiss)}>
							{text.save}
						</Button>
					</>
				)}
			>
				{(dismiss) => (
					<form
						className="plume-scripts-form"
						onSubmit={(event) => {
							event.preventDefault();
							void submit(dismiss);
						}}
					>
						<div className="plume-scripts-field">
							<label htmlFor="plume-script-name">
								<Text size="label" weight="medium">
									{text.nameLabel}
								</Text>
							</label>
							<div className="plume-scripts-name-row">
								<Button
									variant="ghost"
									size="md"
									label={text.chooseIcon}
									menu={iconMenu.open}
									icon={<ScriptIcon icon={icon} size={15} />}
									onClick={iconMenu.toggle}
								/>
								<Input
									id="plume-script-name"
									name="scriptName"
									autoFocus
									className="plume-field plume-scripts-name-input"
									placeholder={text.namePlaceholder}
									value={name}
									onChange={(event) => {
										setName(event.target.value);
										if (error) setError(null);
									}}
								/>
							</div>
							{iconMenu.open && (
								<Popover
									anchor={iconMenu.anchor}
									onClose={iconMenu.close}
									placement="bottom"
									align="start"
									width="hug"
									surface="panel"
									role="group"
									label={text.chooseIcon}
								>
									<div className="plume-scripts-icon-grid">
										{SCRIPT_ICONS.map((entry) => (
											<button
												key={entry}
												type="button"
												aria-pressed={icon === entry}
												className="plume-scripts-icon-option"
												onClick={() => {
													setIcon(entry);
													iconMenu.close();
												}}
											>
												<ScriptIcon icon={entry} size={15} />
												<Text size="caption">{text.icons[entry]}</Text>
											</button>
										))}
									</div>
								</Popover>
							)}
						</div>

						<div className="plume-scripts-field">
							<label htmlFor="plume-script-command">
								<Text size="label" weight="medium">
									{text.commandLabel}
								</Text>
							</label>
							<TextArea
								id="plume-script-command"
								name="scriptCommand"
								rows={3}
								resizable
								className="plume-textarea-mono"
								placeholder={text.commandPlaceholder}
								spellCheck={false}
								value={command}
								onChange={(next) => {
									setCommand(next);
									if (error) setError(null);
								}}
							/>
						</div>

						<div className="plume-scripts-field">
							<label htmlFor="plume-script-preview">
								<Text size="label" weight="medium">
									{text.previewUrlLabel}
								</Text>
							</label>
							<Input
								id="plume-script-preview"
								name="scriptPreviewUrl"
								className="plume-field"
								placeholder={text.previewUrlPlaceholder}
								spellCheck={false}
								value={previewUrl}
								onChange={(event) => setPreviewUrl(event.target.value)}
							/>
							<Text as="p" size="caption" tone="faint">
								{text.previewUrlHint}
							</Text>
						</div>

						<SettingsCard>
							<div data-settings-item="" className="plume-settings-row plume-scripts-toggle-row" data-disabled={trimmedPreview.length === 0 || undefined}>
								<div className="plume-scripts-toggle-copy">
									<Text size="label">{text.autoOpenPreview}</Text>
								</div>
								<Toggle
									checked={trimmedPreview.length > 0 && autoOpenPreview}
									disabled={trimmedPreview.length === 0}
									onChange={setAutoOpenPreview}
									ariaLabel={text.autoOpenPreview}
								/>
							</div>

							<div data-settings-item="" className="plume-settings-row plume-scripts-toggle-row">
								<div className="plume-scripts-toggle-copy">
									<Text size="label">{text.runOnWorktreeCreate}</Text>
									<Text size="caption" tone="faint">
										{text.runOnWorktreeCreateDetail}
									</Text>
								</div>
								<Toggle
									checked={runOnWorktreeCreate}
									onChange={(checked) => {
										setRunOnWorktreeCreate(checked);
										if (!checked) setWaitForSetup(false);
									}}
									ariaLabel={text.runOnWorktreeCreate}
								/>
							</div>

							<div data-settings-item="" className="plume-settings-row plume-scripts-toggle-row" data-disabled={!runOnWorktreeCreate || undefined}>
								<div className="plume-scripts-toggle-copy">
									<Text size="label">{text.waitForSetup}</Text>
									<Text size="caption" tone="faint">
										{text.waitForSetupDetail}
									</Text>
								</div>
								<Toggle
									checked={runOnWorktreeCreate && waitForSetup}
									disabled={!runOnWorktreeCreate}
									onChange={setWaitForSetup}
									ariaLabel={text.waitForSetup}
								/>
							</div>

							<div data-settings-item="" className="plume-settings-row plume-scripts-toggle-row">
								<div className="plume-scripts-toggle-copy">
									<Text size="label">{text.stopOnArchive}</Text>
									<Text size="caption" tone="faint">
										{text.stopOnArchiveDetail}
									</Text>
								</div>
								<Toggle checked={stopOnArchive} onChange={setStopOnArchive} ariaLabel={text.stopOnArchive} />
							</div>
						</SettingsCard>

						{error && (
							<Text as="p" size="detail" tone="danger" role="alert">
								{error}
							</Text>
						)}
					</form>
				)}
			</Dialog>
			{confirmer.element}
		</>
	);
}
