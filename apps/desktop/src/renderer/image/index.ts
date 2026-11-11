/**
 * 看图器对外的那一面：在 App 里挂一次 `ImageViewerHost`，别处用 `openViewer` / `openFromEvent` 打开图片。
 */

export { ImageViewerHost } from "./ImageViewer.tsx";
export { openFromEvent, openViewer } from "./viewer-store.ts";
