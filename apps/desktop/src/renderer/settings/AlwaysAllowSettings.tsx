/**
 * 设置 › 常规 › 权限里「以后不再问」那一行：列出人在审批卡上点过的批准，每条能撤销，也能全部撤销。
 *
 * 名单只来自本机的设置（`SettingsView.alwaysAllow`），项目配置里写的不认、也不列。批准在对话里随时会多出来，打开这一页时重新要一次设置。
 */

import type { AlwaysAllow } from "@plume/contract";
import { Button, useI18n } from "@plume/ui";
import { useEffect, useSyncExternalStore } from "react";
import { usePluginDisplayName } from "../market/store.ts";
import { modelsAgent, refreshModels, settingsView, subscribeModels } from "../models/store.ts";
import { Row, saveFailed } from "./controls.tsx";

/** 本体读边界的批准（`read:<路径>`），见 `packages/core/workspace/src/read-access.ts`。 */
const READ_PREFIX = "read:";

export function AlwaysAllowSettings() {
	const { t } = useI18n();
	const grants = useSyncExternalStore(subscribeModels, settingsView)?.alwaysAllow ?? [];
	const displayName = usePluginDisplayName();
	useEffect(() => {
		void refreshModels().catch(() => undefined);
	}, []);
	const revoke = (grant: AlwaysAllow) => void modelsAgent().revokeAlwaysAllow(grant).then(refreshModels).catch(saveFailed);
	const clear = () => void modelsAgent().clearAlwaysAllow().then(refreshModels).catch(saveFailed);
	return (
		<Row
			title={t("permission.never")}
			detail={grants.length === 0 ? t("general.alwaysAllowEmpty") : t("general.alwaysAllowDetail")}
			control={
				grants.length > 0 && (
					<Button variant="ghost" size="sm" onClick={clear} data-always-allow-clear="true">
						{t("general.alwaysAllowClear")}
					</Button>
				)
			}
		>
			{grants.length > 0 && (
				<ul className="mt-2.5 flex flex-col" data-always-allow-list="true">
					{grants.map((grant) => {
						const owner = grant.plugin === undefined ? t("general.alwaysAllowCore") : (displayName(grant.plugin) ?? grant.plugin);
						const what =
							grant.plugin === undefined && grant.subject.startsWith(READ_PREFIX)
								? t("general.alwaysAllowRead", { path: grant.subject.slice(READ_PREFIX.length) })
								: grant.subject;
						return (
							<li
								key={`${grant.plugin ?? ""}\n${grant.subject}`}
								className="flex items-center gap-3 border-t border-line-soft py-1.5"
								data-always-allow={grant.subject}
								data-always-allow-plugin={grant.plugin ?? ""}
							>
								<div className="min-w-0 flex-1">
									<div className="font-mono text-detail break-all text-ink">{what}</div>
									<div className="text-caption text-ink-faint">{owner}</div>
								</div>
								<Button variant="ghost" size="xs" onClick={() => revoke(grant)} data-always-allow-revoke="true">
									{t("general.alwaysAllowRevoke")}
								</Button>
							</li>
						);
					})}
				</ul>
			)}
		</Row>
	);
}
