import { I18nProvider, useI18n } from "@plume/ui";
import mark from "../../assets/boot-mark.png";
import { useLocaleSetting } from "../locale.ts";
import { useAppPick } from "./state.ts";

/** 从启动页挂上起计时，和后台初始化并行，不在初始化结束后再等一次。 */
export const MIN_BOOT_MS = 900;

export function BootScreen() {
	return (
		<I18nProvider locale={useLocaleSetting()}>
			<BootContent />
		</I18nProvider>
	);
}

function BootContent() {
	const { t } = useI18n();
	const fatal = useAppPick((current) => current.fatal);
	return (
		<div className="flex h-full items-center justify-center bg-shell" data-boot-screen="">
			{fatal ? (
				<p role="alert" className="px-6 text-center text-body text-ink-muted">
					{fatal}
				</p>
			) : (
				<div className="plume-boot-content flex flex-col items-center gap-8" role="status" aria-busy="true" aria-label={t("app.starting")}>
					<img src={mark} alt="" width={288} height={288} draggable={false} className="plume-boot-mark select-none" />
					<div className="plume-boot-rail relative h-0.5 w-32 overflow-hidden rounded-full bg-ink/9" />
				</div>
			)}
		</div>
	);
}
