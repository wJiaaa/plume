/**
 * 输入框工具栏里的权限签，和挂在它上面的菜单：工具多大程度上不用问人就能做。
 *
 * 签上写的是这个会话实际按的那一档：项目配置收紧了（`SessionSummary.projectPermission`，本体算好的）就是项目那档，
 * 图标换成带锁的文件夹、悬停和菜单顶上说明是项目要求的；菜单照旧改本机设置。还没有会话（新对话没发第一句）时按本机设置。
 *
 * 菜单锚在签上而不是居中的对话框：居中读起来像在改整个应用，而这是输入框里就在手边的一个设置，
 * 和模型、思考档位的菜单挂在各自的签上是一个道理。
 */

import type { PermissionMode } from "@plume/contract";
import { type Anchor, DialogAction, DialogFrame, MenuBody, MenuItem, MenuLabel, type MessageKey, Overlay, Popover, usePopover, useI18n } from "@plume/ui";
import { Check, ChevronDown, CircleAlert, Folder, FolderLock, Globe, Hand, SquareTerminal, Terminal, TriangleAlert } from "@plume/ui/icons";
import { useState, useSyncExternalStore } from "react";
import { modelsAgent, refreshModels, settingsView, subscribeModels } from "../models/store.ts";

/** 菜单里每一档的名字就是签上的字，两处说的永远是同一个词。 */
const MODES: { value: PermissionMode; icon: typeof Hand; titleKey: MessageKey; detailKey: MessageKey; danger?: boolean }[] = [
	{ value: "ask", icon: Hand, titleKey: "composer.permissionAsk", detailKey: "permission.askDetail" },
	{ value: "auto", icon: SquareTerminal, titleKey: "composer.permissionAuto", detailKey: "permission.autoDetail" },
	{ value: "full", icon: CircleAlert, titleKey: "composer.permissionFull", detailKey: "permission.fullDetail", danger: true },
];
const TITLE: Record<PermissionMode, MessageKey> = { ask: "composer.permissionAsk", auto: "composer.permissionAuto", full: "composer.permissionFull" };

export function PermissionChip({ required, onError }: { required?: PermissionMode; onError: (message: string) => void }) {
	const { t } = useI18n();
	const menu = usePopover();
	const local = useSyncExternalStore(subscribeModels, settingsView)?.permissionMode ?? "auto";
	// 项目给的那档本体只在不比本机宽时才给，有它时就是生效的那档，这里不用再比。
	const mode = required ?? local;
	const label = t(TITLE[mode]);
	const tip = required ? t("composer.permissionProject", { mode: label }) : label;
	const Icon = required ? FolderLock : CircleAlert;
	// 完全访问是红色而不是强调色：只有这一档把整台机器交出去。
	const tone =
		mode === "full"
			? `text-danger ${menu.open ? "bg-danger/10" : "hover:bg-danger/10"}`
			: menu.open
				? "bg-card-hover text-ink"
				: "text-ink hover:bg-card-hover";
	return (
		<>
			<button
				type="button"
				data-permission-chip={mode}
				data-permission-source={required ? "project" : "local"}
				data-plume-tip={tip}
				aria-label={tip}
				onClick={menu.toggle}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				className={`plume-composer-control flex shrink-0 items-center gap-1 rounded-lg px-2 text-label transition-colors ${tone}`}
			>
				<Icon size={16} strokeWidth={1.9} className="shrink-0" />
				{/* 地方不够时最先让出去：图标（完全访问是红的）和悬停提示照样说是哪一档，这几个字设一次就一直放着，是这一排最便宜的东西。见 `fit.ts`。 */}
				<span data-plume-fit-drop="1" className="flex shrink-0 items-center gap-1 whitespace-nowrap">
					{label}
					<ChevronDown size={14} className="shrink-0" aria-hidden />
				</span>
			</button>
			{menu.open && <PermissionPicker anchor={menu.anchor} current={local} required={required} onClose={menu.close} onError={onError} />}
		</>
	);
}

function PermissionPicker({
	anchor,
	current,
	required,
	onClose,
	onError,
}: {
	anchor: Anchor;
	/** 本机设置的那档：菜单改的是它，勾也打在它上面。 */
	current: PermissionMode;
	/** 项目配置要求、在这个会话里生效的那档，见 `PermissionChip`。 */
	required?: PermissionMode;
	onClose: () => void;
	onError: (message: string) => void;
}) {
	const { t } = useI18n();
	const [confirming, setConfirming] = useState(false);

	function choose(mode: PermissionMode) {
		onClose();
		void modelsAgent()
			.setPermissionMode(mode)
			.then(refreshModels)
			.catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
	}

	return (
		<>
			{!confirming && (
				<Popover anchor={anchor} onClose={onClose} placement="top" align="start" width="wide" label={t("permission.mode")}>
					<MenuBody>
						{required && (
							<p data-permission-project className="px-2 pt-1.5 pb-1 text-detail leading-relaxed text-ink-muted">
								{t("permission.projectNote", { mode: t(TITLE[required]) })}
							</p>
						)}
						<MenuLabel>{t("permission.question")}</MenuLabel>
						{MODES.map((mode) => (
							<MenuItem
								key={mode.value}
								icon={<mode.icon size={13} strokeWidth={1.8} className={mode.danger ? "text-danger" : undefined} />}
								detail={t(mode.detailKey)}
								selected={current === mode.value}
								trailing={
									current === mode.value ? <Check size={13} strokeWidth={2.2} className={`mt-[3px] shrink-0 ${mode.danger ? "text-danger" : ""}`} /> : undefined
								}
								onClick={() => {
									/*
									 * 开完全访问要再确认一次：别的档只是少问几句，这一档把问整个拿掉，文件和网络都是。
									 * 这么大的设置不该离一次手滑只差一下——而点到它的那一下，多半瞄的是上面那行。
									 */
									if (mode.danger && current !== mode.value) setConfirming(true);
									else choose(mode.value);
								}}
							>
								{/* 只有完全访问保留颜色：它是唯一一个绝不能悄悄开着的设置。 */}
								<span className={mode.danger ? "text-danger" : undefined}>{t(mode.titleKey)}</span>
							</MenuItem>
						))}
					</MenuBody>
				</Popover>
			)}

			{confirming && (
				<Overlay
					onClose={() => {
						setConfirming(false);
						onClose();
					}}
					returnFocus={anchor instanceof HTMLElement ? anchor : undefined}
					width={480}
				>
					{(dismiss) => (
						<DialogFrame
							icon={<TriangleAlert size={20} className="shrink-0 text-danger" />}
							title={t("permission.confirmTitle")}
							detail={t("permission.confirmSummary")}
							actions={
								<>
									<div className="flex-1" />
									<DialogAction onClick={() => dismiss()}>{t("common.cancel")}</DialogAction>
									<DialogAction
										tone="danger"
										onClick={() =>
											dismiss(() => {
												setConfirming(false);
												choose("full");
											})
										}
									>
										{t("permission.confirmEnable")}
									</DialogAction>
								</>
							}
						>
							<div className="rounded-2xl bg-card px-4 py-1">
								{[
									{ icon: <Folder size={23} className="text-accent" />, title: t("permission.files"), detail: t("permission.filesDetail") },
									{ icon: <Terminal size={23} className="text-ink-muted" />, title: t("permission.terminal"), detail: t("permission.terminalDetail") },
									{ icon: <Globe size={23} className="text-accent" />, title: t("permission.network"), detail: t("permission.networkDetail") },
								].map((item) => (
									<div key={item.title} className="flex items-center gap-3 py-3">
										<span className="shrink-0">{item.icon}</span>
										<div>
											<p className="text-label font-medium text-ink">{item.title}</p>
											<p className="mt-0.5 text-detail leading-relaxed text-ink-muted">{item.detail}</p>
										</div>
									</div>
								))}
							</div>
							<p className="mt-4 text-detail leading-relaxed text-ink-faint">{t("permission.risk")}</p>
						</DialogFrame>
					)}
				</Overlay>
			)}
		</>
	);
}
