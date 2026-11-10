import { Component, createRef, type ReactNode } from "react";
import { DURATION, EASING, motionReduced } from "@plume/ui";

interface Props {
	layout: string;
	contentId?: string;
	children: ReactNode;
}

/** 布局先落在终点，只合成内容的位移；标题不缩放，按钮保持在最终位置。 */
export class PanelSurface extends Component<Props, Record<string, never>, DOMRect | null> {
	private root = createRef<HTMLDivElement>();
	private motions: Animation[] = [];

	override getSnapshotBeforeUpdate(previous: Props): DOMRect | null {
		if (previous.layout === this.props.layout || motionReduced()) return null;
		return this.root.current?.getBoundingClientRect() ?? null;
	}

	override componentDidUpdate(_previous: Props, _state: Record<string, never>, before: DOMRect | null): void {
		if (!before || !this.root.current) return;
		for (const motion of this.motions) motion.cancel();
		this.motions = [];
		const after = this.root.current.getBoundingClientRect();
		const dx = before.left - after.left,
			dy = before.top - after.top;
		if ((!dx && !dy) || !after.width || !after.height) return;
		const options = { id: "plume-dock-geometry", duration: DURATION.base, easing: EASING.out };
		const content = this.props.contentId ? document.getElementById(this.props.contentId) : this.root.current.querySelector("[data-panel-content]");
		if (content)
			this.motions.push(
				content.animate(
					[{ transform: `translate(${dx}px, ${dy}px) scale(${before.width / after.width}, ${before.height / after.height})` }, { transform: "none" }],
					options,
				),
			);
		const heading = this.root.current.querySelector("[data-panel-heading]");
		if (heading) this.motions.push(heading.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], options));
	}

	override componentWillUnmount(): void {
		for (const motion of this.motions) motion.cancel();
	}

	override render() {
		return (
			<div ref={this.root} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel border border-line-float bg-shell">
				{this.props.children}
			</div>
		);
	}
}
