import type { DocumentPreviewProps } from "@plume/contract/ui";
import { translate } from "@plume/ui";
import { Component, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

const entries: Array<{ extensions: readonly string[]; component: ComponentType<DocumentPreviewProps>; id: number }> = [];
const listeners = new Set<() => void>();
let revision = 0;
const changed = () => {
	revision++;
	for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

export function registerDocumentViewer(extensions: readonly string[], component: ComponentType<DocumentPreviewProps>): () => void {
	if (!Array.isArray(extensions) || !extensions.length || extensions.some((extension) => !/^[a-z0-9]+$/.test(extension)) || typeof component !== "function")
		throw new Error("documentViewer requires lowercase extensions and a component");
	const entry = { extensions: [...extensions], component, id: ++revision };
	entries.push(entry);
	changed();
	return () => {
		const at = entries.indexOf(entry);
		if (at >= 0) entries.splice(at, 1);
		changed();
	};
}

class PreviewBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

/** 只分派展示，文件数据与权限仍由原入口负责。 */
export function DocumentPreview(props: DocumentPreviewProps) {
	useSyncExternalStore(subscribe, () => revision);
	const extension = props.name.toLowerCase().split(".").pop() ?? "";
	const entry = entries.findLast((candidate) => candidate.extensions.includes(extension));
	const fallback = props.fallback ?? <p className="p-6 text-center text-detail text-ink-muted">{translate("fileViewer.noPreview")}</p>;
	if (!entry) return fallback;
	const Viewer = entry.component;
	return (
		<PreviewBoundary key={`${entry.id}:${props.identity}`} fallback={fallback}>
			<Viewer {...props} />
		</PreviewBoundary>
	);
}
