/**
 * 唯一的那个看图器，以及别处怎么叫它出来。
 *
 * 用一个 store，而不是一个 context provider 再在每个调用处配一个 hook：打开图片的地方彼此毫无关系——输入框
 * 的附件、发出去的消息、一次工具结果——为了够到同一层浮层把 provider 穿过它们全部，是给一件说到底只是窗口
 * 里一件家具的东西搞排场。
 *
 * 起点矩形是这东西不只是「显示一张大图」的全部理由。打开时记下缩略图在屏幕上的位置，浮层就从正好那里开始、
 * 长到窗口中间；关闭时倒着放一遍。没有它，图片凭空出现，点的那个小东西和得到的那个大东西之间是什么关系，
 * 只能留给人自己去猜。
 */

import { useSyncExternalStore } from "react";

export interface ViewerImage {
	/** `data:` URL 或绝对地址——`<img src>` 接受什么就是什么。 */
	src: string;
	alt?: string;
	/**
	 * 保存带标注的副本时调用，前提是这张图能接受副本。
	 *
	 * 没有就说明这张图是已经发出去的东西的记录，不能原地修改。
	 */
	onReplace?: (dataUrl: string) => void;
	/**
	 * 一张不能替换的图，标注完按「完成」时副本去哪——通常是它所在那个对话的输入框。没有的话，副本进剪贴板。
	 */
	onAttach?: (dataUrl: string) => void;
}

export interface ViewerState {
	images: ViewerImage[];
	index: number;
	/** 缩略图在哪，给打开和关闭的动画用。 */
	origin: DOMRect | null;
	/**
	 * 缩略图本身，好在它的图片不在它身上时把它藏起来。
	 *
	 * 这段飞行要读成*这张缩略图*变成了全尺寸的图。原图留在原地、一份副本飞走，同时就有两个一样的东西，
	 * 这是以最字面的方式拆穿了这个错觉。只在看图器开着时持有，看图器退出时负责还原。
	 */
	source: HTMLElement | null;
	/** 看图器是不是一打开就直接进入标注。 */
	startEditing?: boolean;
}

let state: ViewerState | null = null;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

export function openViewer(images: ViewerImage[], index: number, origin: DOMRect | null = null, source: HTMLElement | null = null, startEditing = false) {
	if (images.length === 0) return;
	state = { images, index: Math.max(0, Math.min(index, images.length - 1)), origin, source, startEditing };
	emit();
}

export function closeViewer() {
	state = null;
	emit();
}

export function stepViewer(delta: number) {
	if (!state) return;
	const count = state.images.length;
	// 首尾相接：三张图的图集要是两头都会停住，就成了一个得动脑子的图集。
	// 不带起点和缩略图：翻页是在图与图之间移动，不是从缩略图到达，起头那张缩略图一直藏到看图器关上。
	state = { ...state, index: (state.index + delta + count) % count, origin: null };
	emit();
}

export function useViewer(): ViewerState | null {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => state,
		() => null,
	);
}

/**
 * 一张可以点开的图交出来的东西。
 *
 * 矩形从被点的元素上量，而不是要调用方自己留一个 ref，所以让一张图能点开只需要一个属性，不用记账。
 */
export function openFromEvent(event: React.MouseEvent<HTMLElement>, images: ViewerImage[], index: number) {
	openViewer(images, index, event.currentTarget.getBoundingClientRect(), event.currentTarget);
}
