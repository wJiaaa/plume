/**
 * 输入框收下附件之后的那一整套：读文件、句子里那枚标记的一生、上方那一排图、右键菜单、点开预览、左下角那颗「+」。
 *
 * 一枚标记要成立，得同时有：落下时的编号和光标落点、删掉一份之后剩下那些的重新编号、句子里标记没了附件跟着
 * 卸下、附件条上删掉一格句子里跟着拿掉、换界面语言时整篇改写。少一件，它就会在某一步退化成一串没人认得的方括号。
 * 这些事共用同一份「改之前的附件清单」，所以放在一个 hook 里。画标记、光标跳过它在 `attachment-marks.ts`。
 */

import type { DocumentText, OutgoingMessage } from "@plume/contract";
import { IconButton, useI18n } from "@plume/ui";
import { Plus } from "@plume/ui/icons";
import type { EditorView } from "@codemirror/view";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { openFromEvent, openViewer } from "../image/index.ts";
import { attachmentMarks, type MarkFile, type MarkHandlers, setMarkFiles } from "./attachment-marks.ts";
import { attachmentActions } from "./attachments/actions.ts";
import { AttachmentMenu } from "./attachments/AttachmentMenu.tsx";
import { AttachmentStrip, type StripFile } from "./attachments/AttachmentStrip.tsx";
import { displayName } from "./attachments/display.ts";
import { fileKind, KIND_LABEL, type FileKind } from "./attachments/file-kind.ts";
import { attachmentMeta, spellDraft } from "./attachments/outgoing.ts";
import { pickedFrom, type PickedFile } from "./attachments/picked.ts";
import { placeholderFor, renamePlaceholders, scanPlaceholders } from "./attachments/placeholders.ts";
import { type DraftAttachment, fromDataUrl, readPickedFiles } from "./attachments/read.ts";

const kindOf = (file: DraftAttachment): FileKind => file.kind ?? (file.isText ? "text" : fileKind(file.name ?? "", file.mimeType ?? ""));
const imageSrc = (file: DraftAttachment) => `data:${file.mimeType};base64,${file.data}`;
const hasPixels = (file: DraftAttachment) => !file.isText && Boolean(file.data);

export interface ComposerAttachments {
	/** 给编辑器的扩展：画标记、贴文件、点中和右键标记。建编辑器时加一次。 */
	extension: ReturnType<typeof attachmentMarks>;
	/** 读进来、在光标处落下标记。 */
	addFiles: (picked: PickedFile[]) => Promise<void>;
	/** 人改完字之后：句子里没人提的附件跟着卸下来。 */
	reconcile: (next: string) => void;
	/** 框上方那一格托盘，只有图片。没有图时收起。 */
	tray: ReactNode;
	/** 右键标记弹出的菜单，挂在哪里都行，它自己浮起来。 */
	menu: ReactNode;
	/** 左下角那颗「+」连同它背后的文件选择框。 */
	addButton: ReactNode;
	attachments: DraftAttachment[];
	/** 这份草稿发出去的样子；`text` 是去过首尾空白的正文。 */
	outgoing: (text: string) => OutgoingMessage;
	/** 发出去以后清空。 */
	clear: () => void;
	/** 插件接在草稿后面的几份（`ui.draftInSession`）：挂在已有的后面，标记落在正文最后。 */
	append: (files: DraftAttachment[]) => void;
	/** 撤回、分叉放回来的那一份：整份换掉。正文由调用方一起放回，里面的标记照发出时存下的标签写，所以标签不重起。 */
	restore: (files: DraftAttachment[]) => void;
	/** 排队条上编辑退回来的那一条：字接在草稿后面，附件接在已有的后面，按位置重新起名，正文里的标记跟着改。 */
	takeBack: (text: string, files: DraftAttachment[]) => void;
}

export function useComposerAttachments({
	setText,
	editor,
	documentText,
	notify,
	cwd,
	state,
}: {
	/** 函数式更新：这几件事经常和人正在打的字撞在同一帧。 */
	setText: (update: (current: string) => string) => void;
	editor: { current: EditorView | null };
	documentText: (name: string, data: Uint8Array) => Promise<DocumentText | null>;
	notify: (text: string) => void;
	/** 屏上会话的工作目录：点到它里面的文件标记时在文件面板里打开。还没有会话时不给。 */
	cwd?: string | undefined;
	/** 由会话草稿保存整份附件时使用；未提供时沿用输入框本地状态。 */
	state?: { attachments: DraftAttachment[]; setAttachments: (files: DraftAttachment[]) => void };
}): ComposerAttachments {
	const { t, resolvedLocale } = useI18n();
	const [localAttachments, setAttachmentState] = useState<DraftAttachment[]>([]);
	const attachments = state?.attachments ?? localAttachments;
	/** 「此刻」的清单：闭包里那份会过期，而这几件事都要拿此刻的去配对。改的同时就更新，不等下一次渲染。 */
	const live = useRef(attachments);
	live.current = attachments;
	const setAttachments = (next: DraftAttachment[]) => {
		live.current = next;
		if (state) state.setAttachments(next);
		else setAttachmentState(next);
	};
	const [markMenu, setMarkMenu] = useState<{ point: { x: number; y: number }; file: DraftAttachment } | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	/**
	 * 重新编号：「图片 2」里的 2 是它在同门类里的位置。图片和没名字的叫「图片 1」，其余有名字就叫名字，规则见
	 * `displayName`——和附件条上那一格算的是同一个字符串，差一个字正文里那枚标记就配不上了。
	 */
	const relabel = (files: DraftAttachment[]): DraftAttachment[] => {
		const seen = new Map<FileKind, number>();
		return files.map((file) => {
			const kind = kindOf(file);
			const kindIndex = (seen.get(kind) ?? 0) + 1;
			seen.set(kind, kindIndex);
			return { ...file, label: displayName({ name: file.name, kind, kindLabel: t(KIND_LABEL[kind]), kindIndex }, t("composer.regionShot")) };
		});
	};

	/**
	 * 卸下这几份，返回改写后的正文。两件事一次做完：被卸下的标记从句子里拿掉，剩下的那些可能改了名（删掉
	 * 「图片 1」之后原来的「图片 2」成了「图片 1」），句子里跟着改。定位用改之前的那份清单。
	 */
	const unload = (text: string, dropped: DraftAttachment[]): string => {
		const before = live.current;
		const remaining = before.filter((file) => !dropped.includes(file));
		const relabelled = relabel(remaining);
		const renamed = new Map(remaining.map((file, index) => [file, relabelled[index]!.label ?? file.name]));
		setAttachments(relabelled);
		return renamePlaceholders(text, before, (file) => renamed.get(file) ?? null);
	};

	/**
	 * 收下这几份：只给新来的起名、在光标处落下标记、光标送到标记后面。已有的名字不动——正文里它们的标记是照旧
	 * 名字写的，改了名而不改正文，下一次改字它们就被当成孤儿卸掉。
	 */
	const attach = (added: DraftAttachment[], caret: number) => {
		if (added.length === 0) return;
		const before = live.current;
		const grown = [...before, ...relabel([...before, ...added]).slice(before.length)];
		setAttachments(grown);
		// 标记之间不另塞空格：收尾那个方括号是透明的，它自己就占着一点空。
		const marks = grown
			.slice(before.length)
			.map((file) => placeholderFor(file.label ?? file.name))
			.join("");
		let targetCaret = 0;
		setText((current) => {
			const at = Math.min(caret, current.length);
			const head = current.slice(0, at);
			const lead = head && !/\s$/.test(head) ? " " : "";
			targetCaret = at + lead.length + marks.length;
			return `${head}${lead}${marks}${current.slice(at)}`;
		});
		// 光标落在标记后面，接着打的字跟在它后头。等新的正文进了编辑器再放。
		requestAnimationFrame(() => {
			const view = editor.current;
			if (view && targetCaret <= view.state.doc.length) view.dispatch({ selection: { anchor: targetCaret } });
		});
	};

	const detach = (file: DraftAttachment) => setText((current) => unload(current, [file]));

	/*
	 * 句子里那枚标记被删掉，附件跟着卸下来：删了标记还留着附件，就成了一份谁也提不到的东西。只在人改字时做，
	 * 外面同步进来的值不走这里（见 `MarkdownField` 的 `onChange`）。
	 */
	const reconcile = (next: string) => {
		const kept = new Set(scanPlaceholders(next, live.current).map((hit) => hit.file));
		const orphaned = live.current.filter((file) => !kept.has(file));
		if (orphaned.length > 0) setText(() => unload(next, orphaned));
	};

	const addFiles = async (picked: PickedFile[]) => {
		if (picked.length === 0) return;
		// 读字节之前记下光标：抽一份三百页 PDF 的字要几百毫秒，那之后光标早不在原地了。
		const caret = editor.current?.state.selection.main.head ?? 0;
		const next = await readPickedFiles(picked, { documentText, notify });
		if (next.length > 0) attach(next, caret);
	};

	// 换了界面语言，「图片 1」跟着翻译，句子里那些标记整篇改写；文件名不翻译，不在此列。
	const spokenIn = useRef(resolvedLocale);
	useEffect(() => {
		if (spokenIn.current === resolvedLocale) return;
		spokenIn.current = resolvedLocale;
		const before = live.current;
		if (before.length === 0) return;
		const relabelled = relabel(before);
		const renamed = new Map(before.map((file, index) => [file, relabelled[index]!.label ?? file.name]));
		setAttachments(relabelled);
		setText((current) => renamePlaceholders(current, before, (file) => renamed.get(file) ?? null));
		// relabel 读的是当前语言的 t，跟着 resolvedLocale 变，所以只盯它。
		// oxlint-disable-next-line react-hooks/exhaustive-deps -- 见上
	}, [resolvedLocale]);

	// 编辑器认标记要用的那份清单。
	useEffect(() => {
		const files: MarkFile[] = attachments.map((file) => ({
			name: file.name,
			label: file.label ?? file.name,
			kind: kindOf(file),
			bodiless: !file.isText && !file.data && file.kind !== "folder",
		}));
		editor.current?.dispatch({ effects: setMarkFiles.of(files) });
	}, [attachments, editor]);

	/** 带着像素的那几个，按附件里的先后：看图器里的序号只能在这一份里数。 */
	const previewable = attachments.filter(hasPixels);

	/** 从句子里那枚标记打开看图器：上面那一排里有它自己的格子，就从那儿长出来。 */
	const previewImage = (target: DraftAttachment, originRect?: DOMRect) => {
		const index = previewable.findIndex((file) => file.id === target.id);
		if (index < 0) return;
		const tile = document.querySelector<HTMLElement>(`[data-plume-attachment="${CSS.escape(target.id)}"] .plume-attachment-body`);
		const origin =
			originRect ?? tile?.getBoundingClientRect() ?? new DOMRect(markMenu?.point.x ?? window.innerWidth / 2, markMenu?.point.y ?? window.innerHeight / 2, 1, 1);
		openViewer(
			previewable.map((file) => ({ src: imageSrc(file), alt: file.name })),
			index,
			origin,
			tile,
		);
	};

	const handlers = useRef<MarkHandlers>({ onFiles: () => {}, onOpen: () => {}, onMenu: () => {} });
	handlers.current = {
		onFiles: (picked) => void addFiles(picked),
		onOpen: (index, rect) => {
			const hit = scanPlaceholders(editor.current?.state.doc.toString() ?? "", live.current)[index];
			if (!hit) return;
			attachmentActions.openOrPreview(
				{
					name: hit.file.label ?? hit.file.name,
					...(hit.file.path ? { path: hit.file.path } : {}),
					...(hasPixels(hit.file) ? { src: imageSrc(hit.file) } : {}),
					isImage: hasPixels(hit.file),
					isFolder: hit.file.kind === "folder",
					onPreviewImage: (originRect) => previewImage(hit.file, originRect),
					...(cwd ? { cwd } : {}),
				},
				rect,
			);
		},
		onMenu: (index, point) => {
			const hit = scanPlaceholders(editor.current?.state.doc.toString() ?? "", live.current)[index];
			if (hit) setMarkMenu({ point, file: hit.file });
		},
	};
	const extension = useMemo(() => attachmentMarks(handlers), []);

	/**
	 * 上方那一排只有图片：文件的全部信息就是名字，已经写在句子里那枚标记上了。删除入口也因此不同：图片在格子上
	 * 按叉，文件是把句子里那枚标记删掉。
	 */
	const strip: StripFile[] = attachments.filter(hasPixels).map((attachment) => {
		const kind = attachment.kind ?? "image";
		return {
			key: attachment.id,
			name: attachment.name,
			kind,
			...(attachment.label ? { label: attachment.label } : {}),
			src: imageSrc(attachment),
			...(attachment.path ? { path: attachment.path } : {}),
			tip: `${attachment.name}\n${t(KIND_LABEL[kind])}`,
		};
	});

	/*
	 * 这一排最后一次有图时的样子，托盘收起的那段时间里还画着它：发送、删掉最后一张图会在同一次提交里清空这一排、
	 * 关上托盘，没有它的话收起过渡无物可收，输入框上沿一帧就跳下去。
	 */
	const lastStrip = useRef<StripFile[]>([]);
	useLayoutEffect(() => {
		if (strip.length > 0) lastStrip.current = strip;
	});
	const leaving = strip.length === 0 && lastStrip.current.length > 0;
	const shownStrip = leaving ? lastStrip.current : strip;

	const stripNode =
		shownStrip.length > 0 ? (
			// 有图就始终包着这一层，离场时这一排不会被卸载重建、滚动位置回到开头。
			<div inert={leaving} aria-hidden={leaving || undefined}>
				<AttachmentStrip
					files={shownStrip}
					layout="row"
					eager
					onRemove={(file) => {
						const target = live.current.find((a) => a.id === file.key);
						if (target) detach(target);
					}}
					// 这一份还能改：在看图器里标注完，改的是还没发出去的草稿本身。
					onOpen={(index, event) =>
						openFromEvent(
							event,
							previewable.map((a) => ({
								src: imageSrc(a),
								alt: a.name,
								onReplace: (dataUrl: string) =>
									setAttachments(live.current.map((item) => (item.id === a.id ? { ...item, ...fromDataUrl(dataUrl, item) } : item))),
							})),
							index,
						)
					}
				/>
			</div>
		) : null;

	const tray = (
		<div className="plume-reveal" data-open={strip.length > 0 ? "true" : "false"}>
			<div>
				<div className="plume-composer-attachments">{stripNode}</div>
			</div>
		</div>
	);

	/*
	 * 句子里那一枚被右键点中时，弹的是和附件条上同一份菜单。预览只给图片：像素就在手上。
	 */
	const menu = (
		<AttachmentMenu
			anchor={markMenu?.point ?? null}
			file={
				markMenu
					? {
							name: markMenu.file.label ?? markMenu.file.name,
							...(markMenu.file.path ? { path: markMenu.file.path } : {}),
							...(hasPixels(markMenu.file) ? { src: imageSrc(markMenu.file), onPreview: () => previewImage(markMenu.file) } : {}),
						}
					: null
			}
			onClose={() => setMarkMenu(null)}
			onRemove={() => {
				const target = markMenu?.file;
				setMarkMenu(null);
				if (target) detach(target);
			}}
		/>
	);

	const addButton = (
		<>
			<IconButton
				size="composer"
				emphasis
				label={t("composer.addAttachment")}
				onClick={() => fileInput.current?.click()}
				icon={<Plus size={16} strokeWidth={1.9} />}
			/>
			<input
				ref={fileInput}
				type="file"
				multiple
				hidden
				onChange={(event) => {
					// 选进来的也要取路径，和拖进来的走同一条路。
					void addFiles(pickedFrom(event.target.files));
					event.target.value = "";
				}}
			/>
		</>
	);

	/*
	 * 正文里的标记留在给人看的那一份（`displayText`）里：气泡外那排答的是「这条消息带了什么」，句子里这一枚答的是
	 * 「这句话说的是哪一个」，剥掉之后「照着它改一版」里的「它」就没有着落了。
	 */
	const outgoing = (text: string): OutgoingMessage => {
		const files = live.current;
		if (files.length === 0) return { content: [{ type: "text", text }] };
		return { content: spellDraft(text, files), displayText: text, attachments: attachmentMeta(files) };
	};

	return {
		extension,
		addFiles,
		reconcile,
		tray,
		menu,
		addButton,
		attachments,
		outgoing,
		clear: () => setAttachments([]),
		append: (files) => attach(files, Number.MAX_SAFE_INTEGER),
		restore: (files) => {
			const named = relabel(files);
			setAttachments(files.map((file, index) => (file.label ? file : named[index]!)));
		},
		takeBack: (text, files) => {
			const before = live.current;
			const grown = [...before, ...relabel([...before, ...files]).slice(before.length)];
			const renamed = new Map(files.map((file, index) => [file, grown[before.length + index]!.label ?? file.name]));
			const body = renamePlaceholders(text, files, (file) => renamed.get(file) ?? null);
			setAttachments(grown);
			setText((current) => (current.trim() ? `${current.trimEnd()}\n\n${body}` : body));
		},
	};
}
