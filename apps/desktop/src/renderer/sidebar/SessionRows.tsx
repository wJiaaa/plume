import type { ProjectEntry, SessionSummary } from "@plume/contract";
import { Collapse } from "@plume/ui";
import { useCallback, useEffect, useState } from "react";
import type { SidebarActions } from "./actions.ts";
import { withSpawned } from "./grouping.ts";
import { SessionRow } from "./SessionRow.tsx";

interface Props {
	sessions: readonly SessionSummary[];
	spawned: Record<string, SessionSummary[]>;
	busyParents: ReadonlySet<string>;
	lit: ReadonlySet<string>;
	compact: boolean;
	projects: readonly ProjectEntry[];
	actions: SidebarActions;
}

/** 各分区共用后续会话的展开、折叠和缩进。 */
export function SessionRows(props: Props) {
	return props.sessions.map((session) => <Thread key={session.id} {...props} session={session} />);
}

function Thread({ session, spawned, busyParents, lit, compact, projects, actions }: Props & { session: SessionSummary }) {
	const key = `plume.sidebar.thread.${session.id}`;
	const [folded, setFolded] = useState(() => {
		try {
			return localStorage.getItem(key) === "true";
		} catch {
			return false;
		}
	});
	const children = withSpawned(spawned[session.id] ?? [], spawned);
	const active = children
		.filter((child) => lit.has(child.id))
		.map((child) => child.id)
		.join(",");
	// 只在收起、展开时写：展开是缺省，删掉键，不给每一行都留一条记录。
	const fold = useCallback(
		(next: boolean) => {
			setFolded(next);
			try {
				if (next) localStorage.setItem(key, "true");
				else localStorage.removeItem(key);
			} catch {
				/* 存不下时只影响下次打开。 */
			}
		},
		[key],
	);
	// 只在切换到后续会话时展开；用户主动收起当前行时不抢着打开。
	useEffect(() => {
		if (active) fold(false);
	}, [active, fold]);
	const row = (entry: SessionSummary, nested = false) => (
		<SessionRow
			key={entry.id}
			session={entry}
			active={lit.has(entry.id)}
			compact={compact}
			onOpen={actions.open}
			projects={projects}
			actions={actions}
			loadStats={actions.stats}
			childRunning={busyParents.has(entry.id)}
			nested={nested}
			{...(!nested && children.length ? { followUps: children, folded, onFold: () => fold(!folded) } : {})}
		/>
	);
	return children.length ? (
		<div className="flex flex-col">
			{row(session)}
			<Collapse open={!folded}>
				<div className={`flex flex-col ${compact ? "gap-[5px] pt-[5px]" : "gap-[2px] pt-[2px]"}`}>{children.map((child) => row(child, true))}</div>
			</Collapse>
		</div>
	) : (
		row(session)
	);
}
