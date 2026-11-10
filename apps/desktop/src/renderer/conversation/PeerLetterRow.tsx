/**
 * 另一个会话发来的消息——对话里的一行，不是人发的气泡。
 *
 * 那条消息是写给模型的：正文外面套着 `<session-message>` 和一段「这不是用户说的话」的说明（`ToolRun.letter`）。
 * 原样画在人那一侧，读的人会看见一大段自己没说过的话；什么都不画，这个会话又像是自己突然动了起来。所以画成过程行：
 * 谁写来的、开头一句，点开读全文，旁边一下跳到那个会话。
 *
 * 跳转放在这一行上，不放在展开的正文底下：要去那个会话的人不必先把整封信读完才找得到入口。
 */

import type { PeerLetter } from "@plume/contract";
import { Collapse, FlowRow, IconButton, useI18n } from "@plume/ui";
import { ArrowUpRight, MessagesSquare } from "@plume/ui/icons";
import { Markdown } from "../markdown/Markdown.tsx";
import { openReferencedSession } from "../plugins.tsx";
import { notify } from "../toast/index.ts";
import { useTranscriptDisclosure } from "./view-state.ts";

export function PeerLetterRow({ letters, stateKey }: { letters: PeerLetter[]; stateKey: string }) {
	return (
		<div className="flex flex-col gap-2.5" data-peer-row="">
			{letters.map((letter, index) => (
				<Letter key={letter.id ?? index} letter={letter} stateKey={`${stateKey}-${letter.id ?? index}`} />
			))}
		</div>
	);
}

/** 地址里的名字：`修登录 [a1b2c3]` 画成「修登录」，ref 是给模型认人的。 */
function peerName(address: string): string {
	return address.replace(/\s*\[[0-9a-f]{6,12}\]$/i, "") || address;
}

function Letter({ letter, stateKey }: { letter: PeerLetter; stateKey: string }) {
	const { t } = useI18n();
	const [open, setOpen] = useTranscriptDisclosure(stateKey);
	const jump = () => void openReferencedSession(letter.sessionId).catch(() => notify(t("peers.sessionGone"), "warn"));
	return (
		<div data-peer-letter="">
			<div className="flex min-w-0 items-center gap-1">
				<FlowRow
					icon={<MessagesSquare size={13} strokeWidth={1.8} />}
					/* 别的过程行标题是「思考」这种两三个字的词，加粗读作标签；这里装的是会话名，整段加粗就成了一行粗字。 */
					title={<span className="font-normal">{t(letter.answer ? "peers.answerFrom" : "peers.from", { name: peerName(letter.from) })}</span>}
					summary={letter.text.split("\n").find((line) => line.trim()) ?? ""}
					open={open}
					onToggle={() => setOpen((value) => !value)}
					label={t("peers.letter")}
					data-plume-tip={letter.from}
				/>
				<IconButton size="xs" icon={<ArrowUpRight size={12} strokeWidth={1.8} />} label={t("peers.open")} onClick={jump} data-peer-open="" />
			</div>
			<Collapse open={open} bodyClassName="mt-1.5 border-l-2 border-line pl-3">
				<Markdown text={letter.text} className="text-label text-ink-muted" />
			</Collapse>
		</div>
	);
}
