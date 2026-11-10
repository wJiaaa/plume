export interface RetryRule {
	/** Retries after the initial request; null means until cancelled. */
	retries: number | null;
	strategy: "fixed" | "linear";
	intervalMs: number;
	maxIntervalMs: number;
}
export interface RetryPolicy { network: RetryRule; upstream: RetryRule }
export type RetryFailure = keyof RetryPolicy;

/**
 * A policy, or a way to read the current one.
 *
 * A request that is retrying every five seconds until the network comes back can outlive several
 * visits to the settings page, and taking a copy at the start meant those edits reached it only
 * after it had finished — which for the unlimited rule is never. Handed a function instead, the
 * budget reads the live setting before each wait, so raising a limit or shortening an interval
 * applies from the next retry on. Callers with a fixed policy of their own still pass a value.
 */
export type RetryPolicySource = RetryPolicy | (() => RetryPolicy | undefined);

export const DEFAULT_RETRY_RULE: RetryRule = { retries: 10, strategy: "fixed", intervalMs: 5000, maxIntervalMs: 30_000 };
/*
 * 断网默认重试 10 次、5 秒起递增到 30 秒：一共约四分钟，够熬过换网、VPN 重连这类一两分钟的断线。
 *
 * 它曾经默认无限重试。代价是量出来的：一次运行连不上中转（`ECONNREFUSED`），每 5 秒重发一次，
 * 重发了 646 次、挂了 54 分钟，直到人按停——那期间会话一直显示「在跑」，发给它的消息也都排着。
 * 所以默认改成有上限，无限要显式打开。「无限重试」这个选项照旧在设置里，选它的人要的语义一点不变。
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { network: { ...DEFAULT_RETRY_RULE, strategy: "linear" }, upstream: { ...DEFAULT_RETRY_RULE } };

function normalizeRule(value: unknown, fallback: RetryRule): RetryRule {
	const raw = value && typeof value === "object" ? value : {};
	const number = (candidate: unknown, defaultValue: number, min: number, max: number) => typeof candidate === "number" && Number.isFinite(candidate) ? Math.min(max, Math.max(min, Math.round(candidate))) : defaultValue;
	const retries = "retries" in raw ? raw.retries : fallback.retries;
	const intervalMs = number("intervalMs" in raw ? raw.intervalMs : undefined, fallback.intervalMs, 1000, 3_600_000);
	return {
		retries: retries === null ? null : number(retries, fallback.retries ?? 10, 0, 1_000_000),
		// 没写就用这一类自己的默认：网络默认递增，照旧落到 fixed 会把它悄悄改成每 5 秒。
		strategy: "strategy" in raw ? (raw.strategy === "linear" ? "linear" : "fixed") : fallback.strategy,
		intervalMs,
		maxIntervalMs: Math.max(intervalMs, number("maxIntervalMs" in raw ? raw.maxIntervalMs : undefined, fallback.maxIntervalMs, 1000, 3_600_000)),
	};
}

/** Separate fault policies, each bounded the same way wherever it was written. */
export function normalizeRetryPolicy(value: unknown): RetryPolicy {
	const raw = value && typeof value === "object" ? value : {};
	return {
		network: normalizeRule("network" in raw ? raw.network : undefined, DEFAULT_RETRY_POLICY.network),
		upstream: normalizeRule("upstream" in raw ? raw.upstream : undefined, DEFAULT_RETRY_POLICY.upstream),
	};
}

/**
 * How long this wait is. A fixed interval carries ±20% jitter; on average it is still the setting.
 *
 * It was deliberately exact once, so that "every 5 seconds" meant exactly that. The cost: when a relay
 * hiccups, every client on it drops at the same instant and comes back in lockstep every 5 seconds,
 * knocking the recovering end over on the same beat each time. A second either way makes no
 * difference to the person waiting. `random` is injected only by tests.
 */
export function policyDelay(policy: RetryRule, retry: number, random: () => number = Math.random): number {
	if (policy.strategy === "fixed") return Math.round(policy.intervalMs * (0.8 + random() * 0.4));
	return Math.min(policy.maxIntervalMs, policy.intervalMs * Math.max(1, retry));
}
