/**
 * 一条自己发出去的消息：气泡外面一排带上去的图，气泡里是人打的那些字，句子里的 `【图片 1】` 画成一枚标签。
 *
 * 图片在外面是缩略图，答的是「是哪一张」，点开进看图器；文件不上那一排，它的全部信息就是名字，已经在句子里那枚
 * 标签上了。标签左键打开或预览，右键弹出和输入框里同一份菜单，只是没有「移除」：发出去的是记录。
 *
 * 气泡底下是这条消息的时间和复制，悬停才显出来；用户自己的会话里还有撤回、编辑重发和分叉（`MessageEdits`）。
 * 整条消息挂 `data-plume-quote`：划词引用只认落在一条消息里的选区。
 *
 * 编辑重发是从这里重跑：后面的回复和建在它上面的一切都截掉，那些答的已经不是新问的这句了。只有最后一条能编辑：
 * 改一条更早的话，等于把之后几轮一起作废，这件事交给撤回，它会先问清楚。按钮留着、置灰并说明，不因位置不同时有时无。
 */

import type { UserMessage } from "@plume/contract";
import { IconButton, useI18n } from "@plume/ui";
import { openReferencedSession } from "../plugins.tsx";
import { notify } from "../toast/index.ts";
import { SessionReferences } from "../composer/SessionReferences.tsx";
import { MessageSquarePlus, Pencil } from "@plume/ui/icons";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { attachmentActions } from "../composer/attachments/actions.ts";
import { AttachmentMenu } from "../composer/attachments/AttachmentMenu.tsx";
import { AttachmentStrip } from "../composer/attachments/AttachmentStrip.tsx";
import { KIND_LABEL } from "../composer/attachments/file-kind.ts";
import { MarkGlyph } from "../composer/attachments/FileKindIcon.tsx";
import { useFileScope } from "../files/scope.ts";
import { openFromEvent, openViewer } from "../image/index.ts";
import { BubbleText } from "./BubbleText.tsx";
import { useFilesBack } from "./files-back.tsx";
import { ForkAction } from "./ForkAction.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { useMessageEdits } from "./message-edits.ts";
import { MessageEditor } from "./MessageEditor.tsx";
import { RevertAction } from "./RevertAction.tsx";
import { type SentFile, sentAttachments, spokenText } from "./sent-attachments.ts";
import { useCalls } from "./view-state.ts";

/** `index` 是它在会话里的位置，`last` 说它是不是最后一条人说的话：撤回、编辑、分叉按它们认是哪一条。 */
export function UserBubble({ message, index, last = false }: { message: UserMessage; index?: number; last?: boolean }) {
	const { t } = useI18n();
	const edits = useMessageEdits();
	const running = useCalls((calls) => calls.running);
	const scope = useFileScope();
	/** 这条消息自己的元素：看图器的起点在这里面找，别的消息里同一序号的格子不算。 */
	const root = useRef<HTMLDivElement>(null);
	const files = useMemo(() => sentAttachments(message, (kind) => t(KIND_LABEL[kind]), t("composer.regionShot")), [message, t]);
	const pictures = useMemo(() => files.filter((file) => file.src), [files]);
	const text = spokenText(message);
	const said = text.trim();
	const [markMenu, setMarkMenu] = useState<{ point: { x: number; y: number }; file: SentFile } | null>(null);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(text);
	const filesBack = useFilesBack();

	/** 看图器里的这几张：已经发出去，不能改写；标注完的副本放回这个会话的输入框（没有输入框的转录照旧复制）。 */
	const viewerImages = () =>
		pictures.map((picture) => ({ src: picture.src!, alt: picture.name, ...(edits?.attachImage ? { onAttach: edits.attachImage } : {}) }));

	/** 从句子里那枚标签打开看图器：起点取外面那一排里对应的格子，没有就从点的位置长。 */
	const previewImage = (file: SentFile, originRect?: DOMRect) => {
		const index = pictures.indexOf(file);
		if (index < 0) return;
		const tile = root.current?.querySelectorAll<HTMLElement>(".plume-attachment-body")[index] ?? null;
		const origin = originRect ?? tile?.getBoundingClientRect() ?? new DOMRect(markMenu?.point.x ?? 0, markMenu?.point.y ?? 0, 1, 1);
		openViewer(viewerImages(), index, origin, tile);
	};

	const renderFile = (file: SentFile, at: number): ReactNode => (
		<span
			key={at}
			className="plume-attachment-token"
			data-kind={file.kind}
			data-glyph=""
			data-bodiless={file.bodiless ? "" : undefined}
			data-plume-tip={file.bodiless ? t("composer.filenameOnly") : undefined}
			onClick={(event) =>
				attachmentActions.openOrPreview(
					{
						name: file.label,
						...(file.path ? { path: file.path } : {}),
						...(file.src ? { src: file.src } : {}),
						isImage: Boolean(file.src),
						isFolder: file.kind === "folder",
						onPreviewImage: (originRect) => previewImage(file, originRect),
						...(scope ? { cwd: scope.cwd } : {}),
					},
					event.currentTarget.getBoundingClientRect(),
				)
			}
			onContextMenu={(event) => {
				event.preventDefault();
				setMarkMenu({ point: { x: event.clientX, y: event.clientY }, file });
			}}
		>
			<MarkGlyph name={file.name} kind={file.kind} />
			{file.label}
		</span>
	);

	if (editing && edits && index !== undefined) {
		// 没改字也照发：连接断了以后原样再问一遍正是要的；不想发了旁边就是取消。空的才算取消。
		const submit = () => {
			const edited = draft.trim();
			if (!edited) return setEditing(false);
			const send = (files: boolean) => {
				setEditing(false);
				void edits.edit(index, message, edited, files);
			};
			// 子会话改不了主对话的文件，它截的也不是那几轮。
			const plan = edits.revertPlan;
			if (edits.aside || !plan) return send(false);
			// 截掉的那几轮改过文件时先问要不要一起退回；取消就回到编辑框，改好的字还在。
			void filesBack.check(
				() => plan(index, message),
				(n) => ({
					title: t("revert.editTitle"),
					detail: t("revert.editDetail", { n }),
					blocked: t("revert.editBlocked"),
					withFiles: t("revert.editWithFiles"),
					without: t("revert.editOnly"),
				}),
				send,
				() => send(false),
			);
		};
		return (
			<div ref={root} className="flex w-full justify-end">
				<MessageEditor
					value={draft}
					onChange={setDraft}
					onSubmit={submit}
					onCancel={() => {
						setEditing(false);
						setDraft(text);
					}}
					// 侧边面板只有两三百像素宽，320 会把它吞掉；按钮也照侧边聊天一直的说法叫「重新提问」。
					{...(edits.aside ? { confirmLabel: t("sideMessage.reask"), maxHeight: 220 } : {})}
				/>
				{filesBack.element}
			</div>
		);
	}

	return (
		<div ref={root} data-plume-quote="user" className="group/msg flex w-full flex-col items-end">
			{message.sessionRefs && (
				<SessionReferences
					references={message.sessionRefs}
					onOpen={(id) => void openReferencedSession(id).catch((error: unknown) => notify(String(error), "error"))}
				/>
			)}
			{/* 侧边聊天写下、交过来的话：用的是人的气泡，不说清楚的话，人回头看到的是一句自己不记得说过的话。一直显示，不藏到悬停里。 */}
			{message.origin === "side-chat" && (
				<span className="mb-1 flex items-center gap-1 pr-1 text-caption text-ink-faint" data-from-side-chat="">
					<MessageSquarePlus size={11} strokeWidth={1.9} aria-hidden />
					{t("userMessage.fromSideChat")}
				</span>
			)}
			{pictures.length > 0 && (
				<AttachmentStrip
					files={pictures}
					align="end"
					thumbnail={80}
					layout="wrap"
					className="mb-2 max-w-[85%]"
					onOpen={(index, event) => openFromEvent(event, viewerImages(), index)}
				/>
			)}
			{said && (
				<div className="plume-user-bubble max-w-[85%] rounded-2xl bg-card px-4 py-2.5 sm:max-w-[75%]">
					{/* 认不出的 `【…】` 原样留着：中文里方括号是普通标点。 */}
					<BubbleText text={text} files={files} className="text-label leading-6 text-ink" renderFile={renderFile} />
				</div>
			)}
			<AttachmentMenu
				anchor={markMenu?.point ?? null}
				file={
					markMenu
						? {
								name: markMenu.file.label,
								...(markMenu.file.path ? { path: markMenu.file.path } : {}),
								...(markMenu.file.src ? { src: markMenu.file.src, onPreview: () => previewImage(markMenu.file) } : {}),
							}
						: null
				}
				onClose={() => setMarkMenu(null)}
			/>
			<MessageActions timestamp={message.timestamp} text={text} className="mt-1 pr-1">
				{edits && index !== undefined && (
					<>
						{edits.revert && edits.revertPlan && (
							<RevertAction
								running={running}
								last={last}
								plan={() => edits.revertPlan!(index, message)}
								onRevert={(files) => void edits.revert!(index, message, files)}
							/>
						)}
						<IconButton
							data-message-edit=""
							label={
								running
									? t(edits.aside ? "sideMessage.busy" : "userMessage.turnRunning")
									: last
										? t(edits.aside ? "sideMessage.editAndReask" : "userMessage.editResend")
										: t("userMessage.editNotLast")
							}
							ariaLabel={t(edits.aside ? "sideMessage.editAndReask" : "userMessage.editResend")}
							explainDisabled
							disabled={running || !last}
							onClick={() => {
								if (running || !last) return;
								setDraft(text);
								setEditing(true);
							}}
							icon={<Pencil size={12.5} strokeWidth={1.8} />}
						/>
						{/* 排在最后，原会话不动，所以一轮在跑也给。 */}
						{edits.fork && <ForkAction onFork={() => edits.fork!(index, message)} />}
					</>
				)}
			</MessageActions>
		</div>
	);
}
