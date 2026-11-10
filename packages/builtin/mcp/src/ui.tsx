/**
 * plume.mcp 的界面入口，跑在渲染进程：「插件市场」页里「连接器」那一类。每台服务一张卡片：它在不在跑、怎么启动、带来了哪些工具；
 * 添加在弹窗里，改已有的在卡片里就地改；开关、重连、填值、登录、删除都经逻辑入口（`ui.remote()`）改插件数据目录里的
 * `servers.json`。服务中途要人填的表画成一张审批卡（`FormCard.tsx`）。
 *
 * 像密钥的环境变量、请求头，界面只知道填没填，原值不出 agent 进程。
 */

import type { Remote, UiPlugin } from "@plume/contract/ui";
import {
	Button,
	Collapse,
	Dialog,
	IconButton,
	MenuBody,
	MenuItem,
	MenuSeparator,
	Popover,
	Segmented,
	Select,
	SearchField,
	Text,
	Toggle,
	useConfirmer,
	useI18n,
	usePopover,
} from "@plume/ui";
import { Globe, LogIn, LogOut, MoreHorizontal, Plug, Plus, RefreshCw, SlidersHorizontal, SquareTerminal, Trash2 } from "@plume/ui/icons";
import { useCallback, useEffect, useState } from "react";
import type { McpApi, McpView, ServerDraft, ServerView, VarDraft, VarView } from "./api.ts";
import { formCard } from "./FormCard.tsx";
import { documentCard } from "./DocumentCard.tsx";
import { FORM_KIND } from "./form.ts";
import mcpCss from "./mcp.css";
import { type Messages, MESSAGES } from "./messages.ts";
import { ENV_NAME, HEADER_NAME, looksSecret } from "./vars.ts";

type Notify = (message: string, level?: "info" | "warn" | "error") => void;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function mountStyles(): void {
	const id = "plume.mcp";
	let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-style="${id}"]`);
	if (!style) {
		style = document.createElement("style");
		style.dataset.pluginStyle = id;
		document.head.append(style);
	}
	style.textContent = mcpCss;
}

function McpSettings({ api, notify }: { api: Remote<McpApi>; notify: Notify }) {
	const text = MESSAGES[useI18n().resolvedLocale];
	const [view, setView] = useState<McpView | null>(null);
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const confirmer = useConfirmer();

	const refresh = useCallback(() => {
		void (async () => setView(await api.list()))().catch((error: unknown) => notify(text.readFailed(reasonOf(error)), "error"));
	}, [api, notify, text]);
	useEffect(refresh, [refresh]);
	// 连接在后台走：还有「连接中」「重连中」的，过一秒再问一次，直到每台都有了结果。
	const settling = view?.servers.some((server) => server.status.state === "connecting" || server.status.state === "reconnecting") ?? false;
	useEffect(() => {
		if (!settling) return;
		const timer = setTimeout(refresh, 1000);
		return () => clearTimeout(timer);
	}, [settling, view, refresh]);

	const run = async (id: string, action: () => Promise<McpView>): Promise<boolean> => {
		setBusy(id);
		try {
			setView(await action());
			return true;
		} catch (error) {
			notify(text.actionFailed(reasonOf(error)), "error");
			return false;
		} finally {
			setBusy(null);
		}
	};

	const servers = view?.servers ?? [];
	const needle = query.trim().toLowerCase();
	const visible = servers.filter((server) => !needle || `${server.name} ${server.command ?? ""} ${server.url ?? ""}`.toLowerCase().includes(needle));

	const remove = (server: ServerView) =>
		confirmer.ask({
			title: text.deleteConfirm(server.name),
			detail: text.deleteDetail,
			confirmLabel: text.delete,
			cancelLabel: text.cancel,
			onConfirm: () => void run(server.id, async () => await api.remove(server.id)),
		});

	return (
		<div data-mcp-settings="">
			<div className="mcp-toolbar">
				{servers.length > 0 && <SearchField value={query} onChange={setQuery} placeholder={text.searchPlaceholder} className="mcp-search" />}
				<IconButton label={text.refresh} icon={<RefreshCw size={14} strokeWidth={1.8} aria-hidden />} onClick={refresh} />
				{/* 一个连接器都没有时，「添加」只放在下面的空状态里，不重复两个。 */}
				{(servers.length > 0 || view?.error) && (
					<Button variant="primary" size="sm" icon={<Plus size={13} aria-hidden />} disabled={Boolean(view?.error)} onClick={() => setAdding(true)}>
						{text.add}
					</Button>
				)}
			</div>
			{view?.error && (
				<div className="mcp-problem" role="status">
					<Text as="p" size="label" weight="medium" tone="danger">
						{text.fileBrokenTitle}
					</Text>
					<Text as="p" size="detail" tone="muted">
						<Text size="detail" mono>
							{view.file}
						</Text>
						{` — ${view.error}`}
					</Text>
				</div>
			)}

			{view && !view.error && servers.length === 0 ? (
				<div className="mcp-empty">
					<Text as="p" size="detail" tone="muted">
						{text.emptyHint}
					</Text>
					<Button variant="primary" icon={<Plus size={13} aria-hidden />} onClick={() => setAdding(true)}>
						{text.add}
					</Button>
				</div>
			) : servers.length > 0 && visible.length === 0 ? (
				<div className="mcp-empty">
					<Text size="label" tone="faint">
						{text.noMatch}
					</Text>
				</div>
			) : (
				<div className="mcp-grid">
					{visible.map((server) => (
						<ServerCard
							key={server.id}
							server={server}
							busy={busy === server.id}
							taken={servers.filter((other) => other.id !== server.id).map((other) => other.name)}
							text={text}
							onSave={(draft) => run(server.id, async () => await api.save(server.id, draft))}
							onFill={(values) => void run(server.id, async () => await api.fill(server.id, values))}
							onToggle={(enabled) => void run(server.id, async () => await api.setEnabled(server.id, enabled))}
							onReconnect={() => void run(server.id, async () => await api.reconnect(server.id))}
							onLogin={() => void run(server.id, async () => await api.login(server.id))}
							onLogout={() => void run(server.id, async () => await api.logout(server.id))}
							onRemove={() => remove(server)}
						/>
					))}
				</div>
			)}

			{adding && (
				<ServerDialog
					taken={servers.map((server) => server.name)}
					text={text}
					onClose={() => setAdding(false)}
					onSave={async (draft) => {
						try {
							setView(await api.save(null, draft));
							return null;
						} catch (error) {
							return reasonOf(error);
						}
					}}
				/>
			)}
			{confirmer.element}
		</div>
	);
}

interface CardActions {
	/** 存一份改过的配置；成功时为真。 */
	onSave: (draft: ServerDraft) => Promise<boolean>;
	onFill: (values: { name: string; value: string }[]) => void;
	onToggle: (enabled: boolean) => void;
	onReconnect: () => void;
	onLogin: () => void;
	onLogout: () => void;
	onRemove: () => void;
}

function stateOf(server: ServerView, text: Messages): { tone: string; label: string } {
	const { status } = server;
	if (!server.enabled) return { tone: "off", label: text.off };
	switch (status.state) {
		case "connected":
			return { tone: "ok", label: text.toolCount(status.tools.length) };
		case "failed":
			return { tone: "danger", label: text.failed };
		case "connecting":
			return { tone: "busy", label: text.connecting };
		case "reconnecting":
			return { tone: "busy", label: text.reconnecting(status.attempt?.at ?? 1) };
		case "missing":
			return { tone: "danger", label: text.needsKeys };
		case "needs-login":
			return { tone: "danger", label: text.needsLogin };
		default:
			return { tone: "off", label: text.on };
	}
}

function ServerCard({
	server,
	busy,
	taken,
	text,
	onSave,
	onFill,
	onToggle,
	onReconnect,
	onLogin,
	onLogout,
	onRemove,
}: CardActions & { server: ServerView; busy: boolean; taken: string[]; text: Messages }) {
	const menu = usePopover();
	const [toolsOpen, setToolsOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const { status } = server;
	const state = stateOf(server, text);
	const live = status.state === "connected" || status.state === "reconnecting";
	const canListTools = server.enabled && live && status.tools.length > 0;
	// 连不上的，原因和「重新连接」摊在卡片上。
	const troubled = server.enabled && (status.state === "failed" || status.state === "reconnecting") && Boolean(status.error || status.stderr);
	/*
	 * 平时是网格里的一格；有事要人做（缺值、登录、连不上）或人点开了工具、编辑时占满一行：
	 * 表单、stderr、工具列表在三分之一宽里摆不下。
	 */
	const missing = !server.managed && server.enabled && status.state === "missing" && Boolean(status.missing);
	const login = server.enabled && status.state === "needs-login";
	const wide = editing || (toolsOpen && canListTools) || missing || login || troubled;

	return (
		<div className="mcp-card" data-wide={wide || undefined} data-off={!server.enabled || undefined}>
			<div className="mcp-card-head" data-mcp-server={server.name}>
				<span className="mcp-mark" aria-hidden>
					{server.transport === "stdio" ? <SquareTerminal size={18} strokeWidth={1.7} /> : <Globe size={18} strokeWidth={1.7} />}
				</span>
				<span className="mcp-card-body">
					<Text size="label" weight="medium">
						{server.name}
					</Text>
					<span className="mcp-state">
						<span className="mcp-dot" data-tone={state.tone} aria-hidden />
						{canListTools ? (
							<button type="button" className="mcp-tools-toggle" aria-expanded={toolsOpen} onClick={() => setToolsOpen((open) => !open)}>
								<Text size="caption" className="mcp-tone" data-tone={state.tone}>
									{state.label}
								</Text>
							</button>
						) : (
							<Text size="caption" className="mcp-tone" data-tone={state.tone}>
								{state.label}
							</Text>
						)}
						<Text size="caption" tone="faint">
							{`· ${server.transport === "stdio" ? "stdio" : server.transport === "sse" ? "SSE" : "HTTP"}`}
						</Text>
					</span>
				</span>
				<span className="mcp-card-side">
					<span className="mcp-reveal" data-open={editing}>
						<IconButton
							label={text.launch}
							ariaLabel={`${text.launch} · ${server.name}`}
							active={editing}
							expanded={editing}
							icon={<SlidersHorizontal size={14} strokeWidth={1.9} aria-hidden />}
							onClick={() => setEditing((open) => !open)}
						/>
					</span>
					<Toggle checked={server.enabled} disabled={busy || server.managed} onChange={onToggle} ariaLabel={text.enableNamed(server.name)} />
					<IconButton
						label={text.more}
						ariaLabel={text.moreFor(server.name)}
						menu={menu.open}
						onClick={menu.toggle}
						icon={<MoreHorizontal size={15} strokeWidth={1.9} />}
					/>
				</span>
			</div>

			{(server.managed || server.plugin !== undefined) && (
				<div className="mcp-section" data-mcp-managed="">
					<Text as="p" size="detail" tone="muted">
						{server.managed ? text.magpieManaged : text.pluginManaged(server.plugin ?? "")}
					</Text>
				</div>
			)}

			{!server.managed && server.enabled && status.state === "missing" && status.missing && (
				<div className="mcp-section" data-mcp-missing="">
					<Text as="p" size="detail" tone="danger">
						{text.missingTitle(status.missing.length)}
					</Text>
					<ValueRows names={status.missing} text={text} onFill={onFill} />
				</div>
			)}

			{server.enabled && status.state === "needs-login" && (
				<div className="mcp-section" data-mcp-login="">
					<div className="mcp-trouble-row">
						<span className="mcp-trouble-error">
							<Text as="p" size="detail" tone="muted">
								{status.loginReason ? text.loginBecause(text.loginReason[status.loginReason]) : text.loginHint}
							</Text>
							{busy && (
								<Text as="p" size="caption" tone="faint">
									{text.loginWaiting}
								</Text>
							)}
						</span>
						<Button variant="primary" size="sm" loading={busy} icon={<LogIn size={12} strokeWidth={1.9} aria-hidden />} onClick={onLogin}>
							{text.login}
						</Button>
					</div>
				</div>
			)}

			{troubled && (
				<div className="mcp-section" data-mcp-trouble="">
					<div className="mcp-trouble-row">
						<Text as="p" size="detail" tone="danger" className="mcp-trouble-error">
							{status.error}
						</Text>
						<Button variant="subtle" size="sm" loading={busy} icon={<RefreshCw size={12} strokeWidth={1.9} aria-hidden />} onClick={onReconnect}>
							{text.reconnect}
						</Button>
					</div>
					{status.stderr && (
						<div>
							<Text as="p" size="caption" tone="faint">
								{text.stderr}
							</Text>
							<Text as="code" size="caption" tone="muted" mono className="mcp-stderr">
								{status.stderr}
							</Text>
						</div>
					)}
				</div>
			)}

			<Collapse open={toolsOpen && canListTools}>
				<div className="mcp-tools">
					{status.tools.map((tool) => (
						<Text key={tool.name} as="p" size="detail" className="mcp-tool">
							<Text size="detail" mono>
								{tool.name}
							</Text>
							<Text size="detail" tone="faint">{`  ${tool.description.slice(0, 120)}`}</Text>
						</Text>
					))}
				</div>
			</Collapse>

			<Collapse open={editing}>
				<ServerEditor server={server} taken={taken} text={text} onSave={onSave} onFill={onFill} onLogout={onLogout} busy={busy} />
			</Collapse>

			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width="compact" role="menu" label={server.name}>
					<MenuBody>
						{server.enabled && (
							<MenuItem
								icon={<RefreshCw size={13} strokeWidth={1.8} />}
								onClick={() => {
									menu.close();
									onReconnect();
								}}
							>
								{text.reconnect}
							</MenuItem>
						)}
						{server.enabled && server.oauth && server.signedIn && (
							<MenuItem
								icon={<LogOut size={13} strokeWidth={1.8} />}
								onClick={() => {
									menu.close();
									onLogout();
								}}
							>
								{text.logout}
							</MenuItem>
						)}
						{server.enabled && !server.managed && server.plugin === undefined && <MenuSeparator />}
						{!server.managed && server.plugin === undefined && (
							<MenuItem
								danger
								icon={<Trash2 size={13} strokeWidth={1.8} />}
								onClick={() => {
									menu.close();
									onRemove();
								}}
							>
								{text.delete}
							</MenuItem>
						)}
					</MenuBody>
				</Popover>
			)}
		</div>
	);
}

interface EditorFields {
	name: string;
	command: string;
	args: string;
	url: string;
	wire: "http" | "sse";
	rows: VarRow[];
	flags: { trustReadOnly: boolean; pinned: boolean; perSession: boolean };
}

function draftOf(fields: EditorFields, stdio: boolean): ServerDraft {
	return {
		name: fields.name.trim(),
		transport: stdio ? "stdio" : fields.wire,
		...(stdio ? { command: fields.command.trim(), args: fields.args.split(" ").filter(Boolean) } : { url: fields.url.trim() }),
		// 填过的密钥框空着：不带值，逻辑入口留着原来的。
		vars: fields.rows.map((row): VarDraft => (row.filled && row.value === "" ? { name: row.name } : { name: row.name, value: row.value })),
		...fields.flags,
	};
}

/**
 * 卡片里就地改一台服务：名字、启动方式、变量、三个开关。焦点离开这一块时存一次（开关拨了就存），不弹窗、不点保存：
 * 改一个参数不该换一个界面。没填完的（名字空、命令空、地址不对）不存，标出来等人改好。
 * 像密钥的变量只写不读：框里是空的，填了、存了又变回空的，旁边写着「已填写」。
 * Magpie 分发的整块禁用：能看启动方式，改要去 Magpie。
 */
function ServerEditor({
	server,
	taken,
	text,
	busy,
	onSave,
	onFill,
	onLogout,
}: {
	server: ServerView;
	taken: string[];
	text: Messages;
	busy: boolean;
	onSave: CardActions["onSave"];
	onFill: CardActions["onFill"];
	onLogout: () => void;
}) {
	const stdio = server.transport === "stdio";
	const initial: EditorFields = {
		name: server.name,
		command: server.command ?? "",
		args: (server.args ?? []).join(" "),
		url: server.url ?? "",
		wire: server.transport === "sse" ? "sse" : "http",
		rows: rowsOf(server),
		flags: { trustReadOnly: server.trustReadOnly, pinned: server.pinned, perSession: server.perSession },
	};
	const [fields, setFields] = useState(initial);
	const set =
		<K extends keyof EditorFields>(key: K) =>
		(value: EditorFields[K]) =>
			setFields((was) => ({ ...was, [key]: value }));
	/** 上次存下（或刚打开时）的那份：没改什么的不存，每次失焦都存一遍会每次都重新登记工具。 */
	const [saved, setSaved] = useState(() => JSON.stringify(draftOf(initial, stdio)));

	const clean = fields.name.trim();
	const duplicate = taken.some((existing) => existing.trim().toLowerCase() === clean.toLowerCase());
	const badUrl = !stdio && !/^https?:\/\/\S+$/.test(fields.url.trim());
	const ready = clean !== "" && !duplicate && (stdio ? fields.command.trim() !== "" : !badUrl);

	const commit = (next: EditorFields) => {
		const draft = draftOf(next, stdio);
		if (!ready || JSON.stringify(draft) === saved) return;
		void onSave(draft).then((ok) => {
			if (!ok) return;
			// 存下的密钥从框里清掉：原值不留在界面上。
			const rows = next.rows.map((row) => (row.secret && row.value !== "" ? { ...row, value: "", filled: true } : row));
			setFields((was) => ({ ...was, rows }));
			setSaved(JSON.stringify(draftOf({ ...next, rows }, stdio)));
		});
	};
	/** 开关和下拉框改了就存。 */
	const change = <K extends keyof EditorFields>(key: K, value: EditorFields[K]) => {
		const next = { ...fields, [key]: value };
		setFields(next);
		commit(next);
	};
	const flip = (flag: keyof EditorFields["flags"]) => (value: boolean) => change("flags", { ...fields.flags, [flag]: value });

	// Magpie 分发的整块锁住；插件带来的只有空位的值能填（下面那一节在锁外）。
	const locked = server.managed || server.plugin !== undefined;
	return (
		<div
			className="mcp-editor"
			data-mcp-editor=""
			onBlur={(event) => {
				if (!locked && !event.currentTarget.contains(event.relatedTarget as Node | null)) commit(fields);
			}}
		>
			<fieldset className="mcp-editor-lock" disabled={locked}>
				<Field
					id={`plume-mcp-name-${server.id}`}
					label={text.name}
					hint={text.nameHint}
					error={duplicate ? text.nameTaken(clean) : clean === "" ? text.draftProblem.badName : null}
					text={text}
				>
					<TextField id={`plume-mcp-name-${server.id}`} value={fields.name} onChange={set("name")} mono />
				</Field>
				{stdio ? (
					<>
						<Field
							id={`plume-mcp-command-${server.id}`}
							label={text.command}
							error={fields.command.trim() === "" ? text.draftProblem.badCommand : null}
							text={text}
						>
							<TextField id={`plume-mcp-command-${server.id}`} value={fields.command} onChange={set("command")} mono />
						</Field>
						<Field id={`plume-mcp-args-${server.id}`} label={text.args} optional hint={text.argsDetail} text={text}>
							<TextField id={`plume-mcp-args-${server.id}`} value={fields.args} onChange={set("args")} mono />
						</Field>
					</>
				) : (
					<div className="mcp-pair">
						<Field id={`plume-mcp-url-${server.id}`} label="URL" error={badUrl ? text.urlInvalid : null} text={text}>
							<TextField id={`plume-mcp-url-${server.id}`} value={fields.url} onChange={set("url")} mono />
						</Field>
						<Field label={text.transport} text={text}>
							<Select
								value={fields.wire}
								onChange={(next) => change("wire", next)}
								ariaLabel={text.transport}
								options={[
									{ value: "http", label: "Streamable HTTP" },
									{ value: "sse", label: "SSE" },
								]}
							/>
						</Field>
					</div>
				)}
				<Field label={stdio ? text.env : text.headers} optional hint={text.varsHint} text={text}>
					<VarRows rows={fields.rows} kind={stdio ? "stdio" : "http"} text={text} onChange={set("rows")} />
				</Field>
			</fieldset>
			{(!stdio || server.plugin !== undefined) && server.values.length > 0 && (
				<Field label={text.values} hint={text.valuesHint} text={text}>
					<ValueRows names={server.values.map((item) => item.name)} known={server.values} text={text} onFill={onFill} removable />
				</Field>
			)}
			<fieldset className="mcp-editor-lock" disabled={locked}>
				<Switch label={text.trustReadOnly} hint={text.trustReadOnlyHint} checked={fields.flags.trustReadOnly} onChange={flip("trustReadOnly")} />
				<Switch label={text.pinned} hint={text.pinnedHint} checked={fields.flags.pinned} onChange={flip("pinned")} />
				<Switch label={text.perSession} hint={text.perSessionHint} checked={fields.flags.perSession} onChange={flip("perSession")} />
				{server.oauth && server.signedIn && (
					<div className="mcp-trouble-row">
						<Text as="p" size="detail" tone="faint" className="mcp-trouble-error">
							{text.signedIn}
						</Text>
						<Button variant="subtle" size="sm" loading={busy} icon={<LogOut size={12} strokeWidth={1.9} aria-hidden />} onClick={onLogout}>
							{text.logout}
						</Button>
					</div>
				)}
			</fieldset>
		</div>
	);
}

/**
 * 填 `${NAME}` 空位：一行一个，失焦就存。值是写进去的，不读出来：像密钥的用密码框，填过的写「已填写」。
 * `removable` 的（远程服务存着的值、插件带来的服务填过的值）能删掉；可选的空位没填时提示可以不填。
 */
/** 没传 known 时用同一个空数组：默认参数写 `[]` 每次渲染都是新的。 */
const NO_VARS: VarView[] = [];

function ValueRows({
	names,
	known = NO_VARS,
	text,
	removable,
	onFill,
}: {
	names: string[];
	known?: VarView[];
	text: Messages;
	removable?: boolean;
	onFill: CardActions["onFill"];
}) {
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	return (
		<div className="mcp-vars">
			{names.map((name) => {
				const current = known.find((item) => item.name === name);
				const secret = current?.secret ?? looksSecret(name);
				const value = drafts[name] ?? (secret ? "" : (current?.value ?? ""));
				return (
					<div key={name} className="mcp-var">
						<Text size="detail" mono className="mcp-var-name" title={name}>
							{name}
						</Text>
						<Text size="label" className="mcp-var-value">
							<input
								className="mcp-input mcp-mono"
								type={secret ? "password" : "text"}
								value={value}
								aria-label={name}
								placeholder={current?.filled ? text.varFilled : current?.optional ? text.optionalValue : secret ? text.paste : text.fill}
								spellCheck={false}
								autoComplete="off"
								onChange={(event) => setDrafts((was) => ({ ...was, [name]: event.target.value }))}
								onBlur={() => {
									const typed = drafts[name];
									if (typed === undefined || typed === "" || typed === current?.value) return;
									onFill([{ name, value: typed }]);
									setDrafts(({ [name]: _sent, ...rest }) => rest);
								}}
							/>
						</Text>
						{removable && current?.filled !== false && (
							<IconButton
								tone="danger"
								size="sm"
								label={text.removeVar(name)}
								icon={<Trash2 size={13} strokeWidth={1.8} />}
								onClick={() => onFill([{ name, value: "" }])}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}

function Switch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void }) {
	return (
		<span className="mcp-switch">
			<span className="mcp-switch-text">
				<Text size="detail" weight="medium">
					{label}
				</Text>
				<Text as="p" size="detail" tone="faint">
					{hint}
				</Text>
			</span>
			<Toggle checked={checked} onChange={onChange} ariaLabel={label} />
		</span>
	);
}

/** 弹窗里的一个变量：`filled` 是像密钥、已经填过的那些，原值不在界面上，框空着就是保留。 */
interface VarRow {
	name: string;
	value: string;
	secret: boolean;
	filled: boolean;
}

type Kind = "stdio" | "http";

function rowsOf(server: ServerView): VarRow[] {
	return server.vars.map((item) => ({ name: item.name, value: item.value ?? "", secret: item.secret, filled: item.secret && item.filled }));
}

/** 添加一台服务。先填齐了才存：没填完的那张卡片不该开着、连着、挂着连接失败躺在列表里。改已有的在卡片里就地改。 */
function ServerDialog({
	taken,
	text,
	onSave,
	onClose,
}: {
	taken: string[];
	text: Messages;
	onSave: (draft: ServerDraft) => Promise<string | null>;
	onClose: () => void;
}) {
	const [kind, setKind] = useState<Kind>("stdio");
	const [name, setName] = useState("");
	const [command, setCommand] = useState("");
	const [args, setArgs] = useState("");
	const [url, setUrl] = useState("");
	const [wire, setWire] = useState<"http" | "sse">("http");
	// 两种各留一份：在弹窗里来回切，填过的字不丢。
	const [env, setEnv] = useState<VarRow[]>([]);
	const [headers, setHeaders] = useState<VarRow[]>([]);
	const [trust, setTrust] = useState(false);
	const [saving, setSaving] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const clean = name.trim();
	const duplicate = taken.some((existing) => existing.trim().toLowerCase() === clean.toLowerCase());
	const badUrl = url.trim() !== "" && !/^https?:\/\/\S+$/.test(url.trim());
	const ready = clean !== "" && !duplicate && (kind === "stdio" ? command.trim() !== "" : url.trim() !== "" && !badUrl) && !saving;
	const title = text.addTitle;

	const save = async (dismiss: () => void) => {
		if (!ready) return;
		const rows = kind === "stdio" ? env : headers;
		// 填过的密钥框空着：不带值，逻辑入口留着原来的。
		const vars = rows.map((row): VarDraft => (row.filled && row.value === "" ? { name: row.name } : { name: row.name, value: row.value }));
		setSaving(true);
		setFailure(null);
		const problem = await onSave({
			name: clean,
			transport: kind === "stdio" ? "stdio" : wire,
			...(kind === "stdio" ? { command: command.trim(), args: args.split(" ").filter(Boolean) } : { url: url.trim() }),
			vars,
			trustReadOnly: trust,
		});
		setSaving(false);
		if (problem) setFailure(problem);
		else dismiss();
	};
	const enter = (dismiss: () => void) => (event: React.KeyboardEvent) => {
		if (event.key === "Enter" && !event.nativeEvent.isComposing) void save(dismiss);
	};

	return (
		<Dialog
			onClose={onClose}
			width={520}
			label={title}
			title={title}
			icon={<Plug size={16} />}
			status={
				failure ? (
					<Text as="p" size="detail" tone="danger" role="alert">
						{failure}
					</Text>
				) : undefined
			}
			actions={(dismiss) => (
				<>
					<span className="mcp-spacer" />
					<Button onClick={() => dismiss()}>{text.cancel}</Button>
					<Button variant="primary" disabled={!ready} loading={saving} onClick={() => void save(() => dismiss())} data-mcp-save="">
						{text.add}
					</Button>
				</>
			)}
		>
			{(dismiss) => (
				<div className="mcp-form" data-mcp-dialog="">
					<span className="mcp-fit">
						<Segmented
							value={kind}
							onChange={setKind}
							options={[
								{ value: "stdio", label: text.kindStdio },
								{ value: "http", label: text.kindHttp },
							]}
						/>
					</span>

					<Field id="plume-mcp-name" label={text.name} hint={text.nameHint} error={duplicate ? text.nameTaken(clean) : null} text={text}>
						<TextField id="plume-mcp-name" value={name} onChange={setName} onKeyDown={enter(dismiss)} placeholder="github" autoFocus mono />
					</Field>

					{kind === "stdio" ? (
						<>
							<Field id="plume-mcp-command" label={text.command} text={text}>
								<TextField id="plume-mcp-command" value={command} onChange={setCommand} onKeyDown={enter(dismiss)} placeholder="npx" mono />
							</Field>
							<Field id="plume-mcp-args" label={text.args} optional hint={text.argsDetail} text={text}>
								<TextField
									id="plume-mcp-args"
									value={args}
									onChange={setArgs}
									onKeyDown={enter(dismiss)}
									placeholder="-y @modelcontextprotocol/server-github"
									mono
								/>
							</Field>
						</>
					) : (
						<div className="mcp-pair">
							<Field id="plume-mcp-url" label="URL" error={badUrl ? text.urlInvalid : null} text={text}>
								<TextField id="plume-mcp-url" value={url} onChange={setUrl} onKeyDown={enter(dismiss)} placeholder="https://mcp.example.com/mcp" mono />
							</Field>
							<Field label={text.transport} text={text}>
								<Select
									value={wire}
									onChange={setWire}
									ariaLabel={text.transport}
									options={[
										{ value: "http", label: "Streamable HTTP" },
										{ value: "sse", label: "SSE" },
									]}
								/>
							</Field>
						</div>
					)}

					<Field label={kind === "stdio" ? text.env : text.headers} optional hint={text.varsHint} text={text}>
						<VarRows rows={kind === "stdio" ? env : headers} kind={kind} text={text} onChange={kind === "stdio" ? setEnv : setHeaders} />
					</Field>

					<Switch label={text.trustReadOnly} hint={text.trustReadOnlyHint} checked={trust} onChange={setTrust} />
				</div>
			)}
		</Dialog>
	);
}

/** 一行一个变量，最后一行起个新名字。 */
function VarRows({ rows, kind, text, onChange }: { rows: VarRow[]; kind: Kind; text: Messages; onChange: (rows: VarRow[]) => void }) {
	const [name, setName] = useState("");
	const valid = (kind === "stdio" ? ENV_NAME : HEADER_NAME).test(name) && !rows.some((row) => row.name.toLowerCase() === name.toLowerCase());
	const add = () => {
		if (!valid) return;
		onChange([...rows, { name, value: "", secret: looksSecret(name), filled: false }]);
		setName("");
	};
	return (
		<div className="mcp-vars">
			{rows.map((row) => (
				<div key={row.name} className="mcp-var">
					<Text size="detail" mono className="mcp-var-name" title={row.name}>
						{row.name}
					</Text>
					<Text size="label" className="mcp-var-value">
						<input
							className="mcp-input mcp-mono"
							type={row.secret ? "password" : "text"}
							value={row.value}
							aria-label={row.name}
							placeholder={row.filled ? text.varFilled : ""}
							spellCheck={false}
							autoComplete="off"
							onChange={(event) => onChange(rows.map((item) => (item.name === row.name ? { ...item, value: event.target.value } : item)))}
						/>
					</Text>
					<IconButton
						tone="danger"
						size="sm"
						label={text.removeVar(row.name)}
						icon={<Trash2 size={13} strokeWidth={1.8} />}
						onClick={() => onChange(rows.filter((item) => item.name !== row.name))}
					/>
				</div>
			))}
			<div className="mcp-var">
				<Text size="label" className="mcp-var-name">
					<input
						className="mcp-input mcp-mono"
						value={name}
						aria-label={kind === "stdio" ? text.addVar : text.addHeader}
						placeholder={kind === "stdio" ? "NAME" : "Authorization"}
						spellCheck={false}
						autoComplete="off"
						aria-invalid={name !== "" && !valid}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
							// 这里的回车是加变量，不是提交整个表单。
							event.stopPropagation();
							add();
						}}
					/>
				</Text>
				<Button variant="subtle" size="sm" disabled={!valid} icon={<Plus size={12} strokeWidth={2} aria-hidden />} onClick={add}>
					{kind === "stdio" ? text.addVar : text.addHeader}
				</Button>
			</div>
		</div>
	);
}

/** 一个表单字段：标签、控件、下面一行提示或错误。 */
function Field({
	id,
	label,
	optional,
	hint,
	error,
	text,
	children,
}: {
	id?: string;
	label: string;
	optional?: boolean;
	hint?: string;
	error?: string | null;
	text: Messages;
	children: React.ReactNode;
}) {
	return (
		<div className="mcp-field">
			<span className="mcp-field-label">
				<Text size="detail" weight="medium" {...(id ? { id: `${id}-label` } : {})}>
					{label}
				</Text>
				{optional && (
					<Text size="detail" tone="faint">
						{text.optional}
					</Text>
				)}
			</span>
			{children}
			{(error || hint) && (
				<Text as="p" size="detail" tone={error ? "danger" : "faint"}>
					{error ?? hint}
				</Text>
			)}
		</div>
	);
}

function TextField({
	id,
	value,
	onChange,
	onKeyDown,
	placeholder,
	mono,
	autoFocus,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	onKeyDown?: (event: React.KeyboardEvent) => void;
	placeholder?: string;
	mono?: boolean;
	autoFocus?: boolean;
}) {
	return (
		<Text size="label">
			<input
				className={mono ? "mcp-input mcp-mono" : "mcp-input"}
				aria-labelledby={`${id}-label`}
				value={value}
				placeholder={placeholder}
				spellCheck={false}
				autoComplete="off"
				autoFocus={autoFocus}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={onKeyDown}
			/>
		</Text>
	);
}

export default {
	name: "plume.mcp",
	apply(ui) {
		mountStyles();
		const api = ui.remote<McpApi>();
		const Documents = documentCard(ui, api);
		// 文档预览只在通用卡片下面补一段：MCP 的调用照常合成一段活，不因为这张卡各占一行。
		ui.toolCard("mcp__", Documents, { match: "prefix", inline: true });
		ui.toolCard("mcp_call", Documents, { inline: true });
		const notify = ui.notify.bind(ui);
		ui.settingsSection("mcp", () => <McpSettings api={api} notify={notify} />, {
			title: (locale) => MESSAGES[locale].settingsTitle,
			icon: Plug,
			page: "extensions-connectors",
		});
		ui.approvalCard(FORM_KIND, formCard(ui, api), { match: "kind" });
	},
} satisfies UiPlugin;
