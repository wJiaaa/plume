/** 全局设置页逐个列出项目文件实际覆盖的值，避免改了全局却误以为项目也会改变。 */

import type { ProjectEntry, ProjectLayerView } from "@plume/contract";
import { useI18n } from "@plume/ui";
import { useEffect, useState, useSyncExternalStore } from "react";
import { modelsAgent, settingsView, subscribeModels } from "../models/store.ts";
import { Card } from "./controls.tsx";

function brief(value: unknown): string {
	const text = JSON.stringify(value) ?? String(value);
	return text.length > 96 ? `${text.slice(0, 95)}…` : text;
}

/** 同一目录的多个项目共用一份配置，合并名字，只列一张卡。 */
export function ProjectLayerCards({ projects }: { projects: readonly ProjectEntry[] }) {
	const { resolvedLocale } = useI18n();
	return projects
		.filter((project, index) => projects.findIndex((other) => other.path === project.path) === index)
		.map((project) => (
			<ProjectLayerCard
				key={project.path}
				path={project.path}
				name={new Intl.ListFormat(resolvedLocale, { type: "conjunction" }).format(
					projects.filter((other) => other.path === project.path).map((other) => other.name),
				)}
			/>
		));
}

function ProjectLayerCard({ path, name }: { path: string; name: string }) {
	const { t } = useI18n();
	const settings = useSyncExternalStore(subscribeModels, settingsView);
	const [view, setView] = useState<ProjectLayerView | null>(null);
	useEffect(() => {
		let current = true;
		void modelsAgent()
			.projectLayer(path)
			.then(
				(next) => {
					if (current) setView(next);
				},
				() => {
					if (current) setView(null);
				},
			);
		return () => {
			current = false;
		};
	}, [path, settings]);
	if (!view?.exists) return null;
	const error =
		view.problem?.kind === "not-object"
			? t("notice.project-config-not-object", { path: view.problem.path })
			: view.problem?.kind === "invalid-json"
				? t("notice.project-config-invalid-json", { path: view.problem.path, error: view.problem.detail })
				: view.error;
	return (
		<Card className="mb-6">
			<div className="px-4 py-3" data-project-layer>
				<div className="mb-1 text-label text-ink">{t("override.projectConfig", { name })}</div>
				<p className="mb-2 font-mono text-caption text-ink-faint break-all">{view.path}</p>
				{error && <p className="mb-2 text-detail text-danger break-words">{error}</p>}
				{view.overrides.length === 0 && view.refused.length === 0 && view.loosened.length === 0 && !error && (
					<p className="text-detail text-ink-muted">{t("override.nothingOverridden")}</p>
				)}
				{view.overrides.map((one) => (
					<div key={one.key} className="py-0.5 text-detail break-words" data-project-layer-key={one.key}>
						<span className="font-mono text-ink">{one.key}</span>
						<div className="ml-3 text-ink-muted">
							{t("override.projectValue")} <span className="font-mono">{brief(one.project)}</span>
						</div>
						<div className="ml-3 text-ink-muted">
							{t("override.globalValue")} <span className="font-mono">{brief(one.global)}</span>{" "}
							<span className="text-accent">{t("override.overriddenNote", { mode: t(one.kind === "array" ? "override.replaced" : "override.overrode") })}</span>
						</div>
					</div>
				))}
				{view.loosened.map((key) => (
					<div key={key} className="py-0.5 text-detail text-ink-muted" data-project-layer-loosened={key}>
						<span className="font-mono text-ink">{key}</span> {t("override.looseningIgnored")}
					</div>
				))}
				{view.refused.map((key) => (
					<div key={key} className="py-0.5 text-detail text-ink-muted" data-project-layer-refused={key}>
						<span className="font-mono text-ink">{key}</span> {t("override.repoBanned")}
					</div>
				))}
			</div>
		</Card>
	);
}
