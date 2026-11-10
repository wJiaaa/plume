/**
 * 看图器对外的那一面：在 App 里挂一次 `ImageViewerHost`，别处用 `openViewer` / `openFromEvent` 打开图片。
 * 复制、另存一张图也从这里拿，和看图器的按钮走同一条路。
 */

export { ImageViewerHost } from "./ImageViewer.tsx";
export { openFromEvent, openViewer } from "./viewer-store.ts";
