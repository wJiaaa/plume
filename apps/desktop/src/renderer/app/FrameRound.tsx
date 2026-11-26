import type { ReactNode } from "react";

/**
 * 各栏身子（`data-frame-body`）和常驻面板裁剪层（`data-frame-clip`）的圆角裁剪：外面那一层只按直角裁，圆角在这里。
 *
 * 四个角永远是同一个半径。挨着别人的那一边，这一层整体往外伸出一个圆角的宽度，伸出去的两个圆角落在外层的直角裁剪外面，
 * 看到的还是直角（styles.css 的 `data-frame-round`）。不在外层直接去掉那一边的圆角：macOS 上 Chromium 只有四个角一样的
 * 圆角裁剪能在合成器里直接裁，不一样就给里面每块单独合成的内容（转录、渐隐遮罩、光标……）各生成一张和这一栏一样大的遮罩，
 * 5K 屏上一张一百多 MB。
 * 里面那一层缩回外层的内框，内容和按它绝对定位的东西都摆在原来的位置。
 */
export function FrameRound({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
	return (
		<div data-frame-round={disabled ? undefined : ""} className={disabled ? "contents" : "absolute overflow-hidden"}>
			<div data-frame-box={disabled ? undefined : ""} className={disabled ? "contents" : "absolute flex flex-col"}>
				{children}
			</div>
		</div>
	);
}
