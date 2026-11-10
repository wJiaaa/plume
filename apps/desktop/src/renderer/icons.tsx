/**
 * 产品界面用到的几个图标。路径摘自 Lucide（ISC 许可，https://lucide.dev），只有这几个，不为它加依赖。
 * 线条用 currentColor，跟着文字色走。
 */

import type { ReactNode } from "react";

export type Icon = (props: { size?: number }) => ReactNode;

function icon(paths: ReactNode): Icon {
	return function LucideIcon({ size = 16 }) {
		return (
			<svg
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden
				className="shrink-0"
			>
				{paths}
			</svg>
		);
	};
}

export const ArrowLeft = icon(
	<>
		<path d="m12 19-7-7 7-7" />
		<path d="M19 12H5" />
	</>,
);

export const Settings = icon(
	<>
		<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
		<circle cx="12" cy="12" r="3" />
	</>,
);

export const Settings2 = icon(
	<>
		<path d="M14 17H5" />
		<path d="M19 7h-9" />
		<circle cx="17" cy="17" r="3" />
		<circle cx="7" cy="7" r="3" />
	</>,
);

export const Palette = icon(
	<>
		<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" />
		<circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
		<circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
		<circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
		<circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
	</>,
);

export const Layers = icon(
	<>
		<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
		<path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
		<path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
	</>,
);

export const Blocks = icon(
	<>
		<path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2" />
		<rect x="14" y="2" width="8" height="8" rx="1" />
	</>,
);

export const Info = icon(
	<>
		<circle cx="12" cy="12" r="10" />
		<path d="M12 16v-4" />
		<path d="M12 8h.01" />
	</>,
);
