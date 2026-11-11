/**
 * 换肤工坊里的「首页背景」卡片：选图或拖入、清除，铺放方式、浓度、效果和显示位置。
 * 背景只在这里设置，外观页不再重复一份；图片由主进程校验和存储，插件拿不到文件。
 */

import { type MessageKey, useI18n } from "@plume/ui";
import { ImagePlus, X } from "@plume/ui/icons";
import { type ReactNode, useState } from "react";
import {
	CHAT_BACKGROUND_DEFAULTS,
	MAX_BACKGROUND_BYTES,
	type AppearancePatch,
	type ChatBackgroundEffect,
	type ChatBackgroundFit,
} from "../shared/appearance.ts";
import { updateAppearance, useAppearance } from "./appearance-settings.ts";
import { BackdropLayer, GrainLayer, useChatBackdropImage } from "./chat-backdrop.tsx";

const EFFECTS: Record<ChatBackgroundEffect, MessageKey> = {
	none: "appearance.chatBackgroundEffectNone",
	dither: "appearance.chatBackgroundEffectDither",
	ascii: "appearance.chatBackgroundEffectAscii",
	halftone: "appearance.chatBackgroundEffectHalftone",
	scanlines: "appearance.chatBackgroundEffectScanlines",
	haze: "appearance.chatBackgroundEffectHaze",
};
/** 浓度分五档，落在 CHAT_BACKGROUND_OPACITY 的范围里；中间一档是默认值。 */
const OPACITY_STEPS = [0.08, 0.16, 0.24, 0.38, 0.52] as const;
const ERROR_KEYS: Record<"too-large" | "invalid" | "failed", MessageKey> = {
	"too-large": "appearance.chatBackgroundTooLarge",
	invalid: "appearance.chatBackgroundErrorInvalid",
	failed: "appearance.chatBackgroundErrorFailed",
};

const nearestStep = (opacity: number) =>
	OPACITY_STEPS.reduce((best, step) => (Math.abs(step - opacity) < Math.abs(best - opacity) ? step : best), OPACITY_STEPS[0]);

function Seg({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
			<span className="shrink-0 text-detail text-ink-faint">{label}</span>
			<div role="group" aria-label={label} className="flex max-w-full flex-wrap overflow-hidden rounded-lg border border-line">
				{children}
			</div>
		</div>
	);
}

function SegButton({ pressed, onClick, label, children }: { pressed: boolean; onClick: () => void; label?: string; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-pressed={pressed}
			aria-label={label}
			title={label}
			onClick={onClick}
			className={`flex h-7.5 items-center justify-center border-line text-label transition-colors not-first:border-l ${label ? "w-9" : "px-3"} ${
				pressed ? "bg-accent-dim font-medium text-accent" : "text-ink hover:bg-card-hover active:bg-elevated"
			}`}
		>
			{children}
		</button>
	);
}

export function PluginChatBackgroundSettings({ title }: { title?: string }) {
	const { t } = useI18n();
	const appearance = useAppearance();
	const patch = (next: AppearancePatch) => updateAppearance(next);
	const url = useChatBackdropImage();
	const [busy, setBusy] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [error, setError] = useState<"too-large" | "invalid" | "failed" | null>(null);
	const {
		chatBackgroundOnNewChat: onNewChat,
		chatBackgroundInChat: inChat,
		chatBackgroundEffect: effect,
		chatBackgroundOpacity: opacity,
		chatBackgroundFit: fit,
	} = { ...CHAT_BACKGROUND_DEFAULTS, ...appearance };
	const grain = appearance.grain === true;
	const hasImage = Boolean(appearance.chatBackground);
	const step = nearestStep(opacity);

	const accept = (picked: { name: string } | { error: "too-large" | "invalid" | "failed" } | null) => {
		setError(picked && "error" in picked ? picked.error : null);
		// 两个位置都关着时换了图也看不见，换图就是想看到它。
		if (picked && "name" in picked)
			patch({ chatBackground: picked.name, ...(onNewChat || inChat ? {} : { chatBackgroundOnNewChat: true, chatBackgroundInChat: true }) });
	};
	const work = async (task: () => Promise<void>) => {
		setBusy(true);
		try {
			await task();
		} catch {
			setError("failed");
		} finally {
			setBusy(false);
		}
	};
	const setGrain = (on: boolean) => patch({ grain: on });
	const choose = () => work(async () => accept(await window.plume.chatBackground.pick(t("appearance.chatBackgroundPick"))));
	const drop = (file: File) => {
		if (busy) return;
		if (file.size > MAX_BACKGROUND_BYTES) {
			setError("too-large");
			return;
		}
		void work(async () => accept(await window.plume.chatBackground.import(new Uint8Array(await file.arrayBuffer()), file.name)));
	};
	const remove = () =>
		work(async () => {
			// 存盘后主进程只留还被引用的那张图（`BackgroundImageStore.commit`），不用另外去删。
			patch({ chatBackground: null });
			setError(null);
		});

	return (
		<section data-chat-background-settings="" className="flex flex-col gap-3 rounded-panel border border-line bg-card p-3.5">
			<h2 className="text-label font-semibold text-ink-muted">{title ?? t("appearance.chatBackground")}</h2>
			<div
				data-chat-background-drop=""
				data-dragging={dragging}
				className={`relative isolate flex h-30 items-center justify-center overflow-hidden rounded-lg border bg-shell transition-colors ${
					dragging ? "border-accent bg-accent-dim" : hasImage ? "border-line" : "border-dashed border-line"
				}`}
				onDragOver={(event) => {
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(event) => {
					event.preventDefault();
					setDragging(false);
					const file = event.dataTransfer.files[0];
					if (file) drop(file);
				}}
			>
				{hasImage ? (
					<div data-chat-background-preview="" className="absolute inset-0">
						{url && <BackdropLayer url={url} effect={effect} opacity={opacity} fit={fit} reading={!onNewChat} />}
					</div>
				) : (
					<div className="pointer-events-none flex flex-col items-center gap-1 px-3 text-center text-ink-faint">
						<span className="text-detail">{t("appearance.chatBackgroundEmpty")}</span>
						<span className="text-caption">{t("appearance.chatBackgroundDrop")}</span>
					</div>
				)}
				{grain && <GrainLayer />}
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					disabled={busy}
					onClick={() => void choose()}
					className={`flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-label font-medium text-on-accent transition-opacity hover:opacity-90 ${busy ? "opacity-60" : ""}`}
				>
					<ImagePlus size={15} />
					{t("appearance.chatBackgroundChoose")}
				</button>
				<button
					type="button"
					disabled={busy || !hasImage}
					onClick={() => void remove()}
					className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-label text-ink-muted transition-colors hover:bg-card-hover hover:text-ink disabled:opacity-45"
				>
					<X size={15} />
					{t("common.clear")}
				</button>
			</div>
			{error && (
				<p role="alert" className="text-caption text-danger">
					{t(ERROR_KEYS[error])}
				</p>
			)}
			<Seg label={t("appearance.chatBackgroundFit")}>
				{(["cover", "tile"] as ChatBackgroundFit[]).map((value) => (
					<SegButton key={value} pressed={fit === value} onClick={() => patch({ chatBackgroundFit: value })}>
						{t(value === "cover" ? "appearance.chatBackgroundFitCover" : "appearance.chatBackgroundFitTile")}
					</SegButton>
				))}
			</Seg>
			<Seg label={t("appearance.chatBackgroundOpacity")}>
				{OPACITY_STEPS.map((value) => (
					<SegButton
						key={value}
						pressed={step === value}
						label={t("appearance.chatBackgroundOpacityStep", { percent: Math.round(value * 100) })}
						onClick={() => patch({ chatBackgroundOpacity: value })}
					>
						{/* 圆点本身的浓淡就是这一档的浓度，比五个数字好认。 */}
						<span className="size-3 rounded-full bg-current" style={{ opacity: Math.min(1, value * 1.8) }} />
					</SegButton>
				))}
			</Seg>
			<Seg label={t("appearance.chatBackgroundEffect")}>
				{(Object.keys(EFFECTS) as ChatBackgroundEffect[]).map((value) => (
					<SegButton key={value} pressed={effect === value} onClick={() => patch({ chatBackgroundEffect: value })}>
						{t(EFFECTS[value])}
					</SegButton>
				))}
			</Seg>
			<Seg label={t("appearance.chatBackgroundTexture")}>
				<SegButton pressed={!grain} onClick={() => setGrain(false)}>
					{t("appearance.chatBackgroundTextureNone")}
				</SegButton>
				<SegButton pressed={grain} onClick={() => setGrain(true)}>
					{t("appearance.chatBackgroundTextureGrain")}
				</SegButton>
			</Seg>
			<Seg label={t("appearance.chatBackgroundShow")}>
				<SegButton pressed={onNewChat} onClick={() => patch({ chatBackgroundOnNewChat: !onNewChat })}>
					{t("appearance.chatBackgroundOnNewChat")}
				</SegButton>
				<SegButton pressed={inChat} onClick={() => patch({ chatBackgroundInChat: !inChat })}>
					{t("appearance.chatBackgroundInChat")}
				</SegButton>
			</Seg>
		</section>
	);
}
