/**
 * 设置页里「网页搜索」那一节。页头由宿主画。
 *
 * 实情写在页面上：免配置的不用账号，但会被限流或只认英文；要 key 的可靠。这一页围着它真正要人做的决定排：
 * 选一家，选的是要 key 的就把 key 贴上。
 *
 * key 不进渲染进程：这里只知道每家填没填，输入框里是这次新打的字，存下的那把看不到；填了新的才替换，可以清掉。
 */

import type { Remote, UiContext } from "@plume/contract/ui";
import { Button, IconButton, Input, SettingsCard, SettingsSectionTitle, Text, useI18n } from "@plume/ui";
import { Check, Eraser, ExternalLink, Eye, EyeOff, Search } from "@plume/ui/icons";
import { text as textStyles } from "@plume/styles";
import { useCallback, useEffect, useRef, useState } from "react";
import { type KeyId, type ProviderId, type SearchSettingsView, SIGNUP, type WebApi } from "./api.ts";
import { MESSAGES } from "./messages.ts";

type Messages = (typeof MESSAGES)["zh-CN"];
type Notify = (message: string, level?: "info" | "warn" | "error") => void;

interface Choice {
	id: ProviderId;
	/** 牌子名不翻译，直接写；有译名的用 `nameKey`。 */
	name?: string;
	nameKey?: "ddgInstant";
	/** 用它要付出什么，一句话。 */
	costKey: "needsKey1000" | "needsKeyPaid" | "needsKey2000" | "needsKeyFree" | "noSetupStable" | "noSetupLimited";
	detailKey: "tavily" | "deepseek" | "brave" | "exa" | "ddgInstantDetail" | "ddgScrapeDetail";
	/** 免配置的没有。 */
	key?: KeyId;
}

const CHOICES: Choice[] = [
	{ id: "tavily", name: "Tavily", costKey: "needsKey1000", detailKey: "tavily", key: "tavily" },
	{ id: "deepseek", name: "DeepSeek", costKey: "needsKeyPaid", detailKey: "deepseek", key: "deepseek" },
	{ id: "brave", name: "Brave Search", costKey: "needsKey2000", detailKey: "brave", key: "brave" },
	{ id: "exa", name: "Exa", costKey: "needsKeyFree", detailKey: "exa", key: "exa" },
	{ id: "ddg-instant", nameKey: "ddgInstant", costKey: "noSetupStable", detailKey: "ddgInstantDetail" },
	{ id: "duckduckgo", name: "DuckDuckGo", costKey: "noSetupLimited", detailKey: "ddgScrapeDetail" },
];

const nameOf = (choice: Choice, text: Messages) => (choice.nameKey ? text[choice.nameKey] : choice.name);
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `**…**` 之间的画成加粗，星号本身不显示。 */
function emphasize(sentence: string): React.ReactNode {
	return sentence.split(/\*\*(.+?)\*\*/).map((part, at) =>
		at % 2 === 1 ? (
			<Text key={at} size="detail" tone="default" weight="medium">
				{part}
			</Text>
		) : (
			part
		),
	);
}

export function SearchSettings({ api, notify, openExternal }: { api: Remote<WebApi>; notify: Notify; openExternal: UiContext["openExternal"] }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [view, setView] = useState<SearchSettingsView | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	const load = useCallback(() => {
		api.settings().then(
			(next) => {
				setView(next);
				setLoadError(null);
			},
			(error: unknown) => setLoadError(reasonOf(error)),
		);
	}, [api]);
	useEffect(load, [load]);

	/** 写一次设置；没存上就说一声，再从逻辑入口读回真实的状态。 */
	const save = (write: PromiseLike<SearchSettingsView>) =>
		write.then(setView, (error: unknown) => {
			notify(text.saveFailed(reasonOf(error)), "error");
			load();
		});

	if (loadError) {
		return (
			<Text as="p" size="label" tone="danger">
				{text.loadFailed(loadError)}
			</Text>
		);
	}
	if (!view) return null;

	const choose = (id: ProviderId) => {
		// 再点一次已选的那家是取消选择，回到自动挑。
		const provider = view.provider === id ? null : id;
		setView({ ...view, provider });
		void save(api.setProvider(provider));
	};

	const openSignup = (which: KeyId) => openExternal(SIGNUP[which]).then(undefined, (error: unknown) => notify(text.openFailed(reasonOf(error)), "error"));

	return (
		<div data-search-settings="">
			<SettingsSectionTitle>{text.which}</SettingsSectionTitle>
			<SettingsCard className="web-card">
				{CHOICES.map((choice) => {
					const configured = choice.key ? view.keys[choice.key] : true;
					const active = view.provider === choice.id;
					return (
						<button
							key={choice.id}
							type="button"
							data-search-provider={choice.id}
							data-selected={active || undefined}
							onClick={() => choose(choice.id)}
							className="web-choice"
						>
							{/* 圈落在整条的中线上，不贴着第一行：各家说明的行数不同，贴着标题的话一列圈高低参差。 */}
							<span className="web-radio" data-on={active || undefined}>
								{active && <Check size={11} strokeWidth={3} />}
							</span>
							<span className="web-choice-body">
								<span className="web-choice-head">
									<Text size="label" weight="medium">
										{nameOf(choice, text)}
									</Text>
									<Text size="caption" tone="faint">
										{text[choice.costKey]}
									</Text>
									{/* 说它现在能不能跑：选了一家却没填 key，是一次以后才失败的搜索。 */}
									{choice.key && (
										<Text size="caption" tone="faint">
											{configured ? <span className="web-ok">{text.keySet}</span> : text.keyMissing}
										</Text>
									)}
								</span>
								<Text as="span" size="detail" tone="muted" className="web-choice-detail">
									{emphasize(text[choice.detailKey])}
								</Text>
							</span>
						</button>
					);
				})}
			</SettingsCard>

			<SettingsSectionTitle>{text.apiKey}</SettingsSectionTitle>
			<SettingsCard className="web-card">
				{CHOICES.filter((choice) => choice.key).map((choice) => {
					const which = choice.key!;
					return (
						<div key={choice.id} className="web-key-row">
							<div className="web-key-head">
								<Text size="label">{nameOf(choice, text)}</Text>
								<button type="button" className={`${textStyles.faint} web-signup`} onClick={() => void openSignup(which)}>
									{text.apply}
									<ExternalLink size={10} strokeWidth={2} />
								</button>
							</div>
							<div className="web-key-line">
								<KeyField
									saved={view.keys[which]}
									text={text}
									onCommit={(value) => {
										setView({ ...view, keys: { ...view.keys, [which]: true } });
										void save(api.setKey(which, value));
									}}
								/>
								{view.keys[which] && (
									<Button
										size="sm"
										icon={<Eraser size={13} strokeWidth={1.8} aria-hidden />}
										onClick={() => {
											setView({ ...view, keys: { ...view.keys, [which]: false } });
											void save(api.setKey(which, ""));
										}}
									>
										{text.clear}
									</Button>
								)}
							</div>
						</div>
					);
				})}
			</SettingsCard>

			{/* 除了钱以外搜索要付出的唯一一件事：问题会离开这台机器。写在这里，因为每次搜索都是这样，每次都问一遍反而没人看。 */}
			<div className="web-trust">
				<Search size={13} strokeWidth={1.8} />
				<Text as="p" size="detail" tone="faint">
					{text.trustNote}
				</Text>
			</div>
		</div>
	);
}

/**
 * 停手才写出去的一把 key。
 *
 * 框里只有这次新打的字：有焦点时文字留在本地，停手 400ms 后写出去，失焦时立刻写出去并清空框（已存的那把由占位字说明）。
 * 每次按键都写会让粘贴一把 40 位的 key 变成四十次落盘。空的不写：留空是「不改」，清掉用旁边的按钮。
 */
function KeyField({ saved, text, onCommit }: { saved: boolean; text: Messages; onCommit: (value: string) => void }) {
	const [typed, setTyped] = useState("");
	const [visible, setVisible] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	const commit = (raw: string, now: boolean) => {
		clearTimeout(timer.current);
		// 两头的空白是粘贴带进来的，不是 key 的一部分。
		const cleaned = raw.trim();
		if (!cleaned) return;
		if (now) onCommit(cleaned);
		else timer.current = setTimeout(() => onCommit(cleaned), 400);
	};

	return (
		<div className="plume-field web-key-field" data-plume-field="">
			<Input
				type={visible ? "text" : "password"}
				value={typed}
				onChange={(event) => {
					setTyped(event.target.value);
					commit(event.target.value, false);
				}}
				onBlur={(event) => {
					commit(event.target.value, true);
					setTyped("");
					setVisible(false);
				}}
				placeholder={saved ? text.keySaved : text.pasteKey}
				spellCheck={false}
				autoComplete="off"
				className="web-key-input"
			/>
			{/* 眼睛只看得到自己刚打的字，存下的 key 不在这里。 */}
			{typed && (
				<IconButton
					label={visible ? text.hide : text.show}
					onClick={() => setVisible((v) => !v)}
					className="web-key-eye"
					icon={visible ? <EyeOff size={15} strokeWidth={1.8} /> : <Eye size={15} strokeWidth={1.8} />}
				/>
			)}
		</div>
	);
}
