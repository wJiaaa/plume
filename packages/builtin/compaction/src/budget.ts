/**
 * 压缩用到的每一条线，按窗口和开销在这一处算：触发线、只剪枝够不够的余量、保留尾部、尾部删到哪、按条丢弃落到哪、摘要回复留多少。
 * 散在几处各算各的，同一个「8000 / 四分之一窗口」会写好几遍，单位还不统一。`CompactionBudget` 里除 `trigger` 以外都是历史本身的
 * token，开销（系统提示词和工具表）已扣掉。
 *
 * 估算的校准（实测用量与字符估算之比）不在这里：两处校准的分母有意不同，见 `compaction.ts`。
 */

/** 压缩要知道的模型：窗口、输出上限、价格分档线。 */
export interface BudgetModel {
	contextWindow: number;
	maxOutputTokens: number;
	/** 价格分档线，见 `ContextCompact.model.tierLines`。 */
	tierLines?: readonly number[];
}

/**
 * 到窗口的这么多就压。一次压缩要付一份摘要、还要整段重写缓存，线靠后压得少；代价是线上方只剩一成，一步里几个大结果就可能越过窗口，
 * 那时走超长恢复（不分叉）。
 */
const COMPACTION_RATIO = 0.9;
/**
 * 压完要落到触发线以下多少才算压完：只剪枝落到这里就不摘要，摘要旁的尾部也只删到这里。比的是两个估算的乘积，错的方向是静悄悄的——
 * 以为放得下、其实放不下，下一轮一点没变小。
 */
const PRUNE_MARGIN = 0.1;
/**
 * 原样保留的尾部最多占窗口多少。按大小而不是条数：六条短回复是很小的尾巴，一个工具结果是一整个文件时就很大。它决定最近的工作能不能
 * 原样留下：正在改的文件得完整留着，不然下一轮又去读；更早的能经 `recall` 找回来。
 */
const KEEP_BUDGET = 0.12;
/** 再大也至少留这么多条：没有最后一来一回，接不上手。 */
export const KEEP_MIN = 4;
/**
 * 没有摘要、只能按条丢弃时落到哪。远在触发线以下：刚好落在线下，接下来几条就又越线，一个长任务的时间全花在丢弃上。摘要旁的尾部改为
 * 删到 `settled`：要删的是正在做的事，小窗口上「三成减开销」所剩无几。
 */
const SAFE_AFTER = 0.3;
/**
 * 摘要请求本身最多占窗口多少。要摘要的历史本来就快满了，整段发过去，模型读不下、请求失败；失败又意味着「不压」，唯一让会话留在窗口里的
 * 办法恰好在要用时关掉了自己。所以先按这条线把较早的部分收短。
 */
export const SUMMARY_INPUT = 0.4;
/** 摘要回复最多要多少：交接用不了四分之一窗口以上，小模型也让不出更多。 */
const SUMMARY_REPLY_MAX = 8000;
const SUMMARY_REPLY_SHARE = 0.25;

/** 摘要请求要给回复留的位置，独立请求和分叉请求是同一个数，发前核对也按它算。 */
export function summaryReplyTokens(model: Pick<BudgetModel, "contextWindow" | "maxOutputTokens">): number {
	return Math.min(SUMMARY_REPLY_MAX, model.maxOutputTokens, Math.floor(model.contextWindow * SUMMARY_REPLY_SHARE));
}

/**
 * 触发线还得给摘要请求留出位置：分叉请求是完整历史加一条指令，摘要要写在窗口剩下的地方。大窗口上 90% 留下的比这多，这一项不起作用；
 * 只在小窗口上把线往前挪——32k 的 90% 只剩 3.2k，放不下一份 8k 的摘要。
 *
 * 大窗口不往后推到「窗口减固定预留」：每一轮都要按缓存价重读整段前缀，线越靠后，两次压缩之间的每一轮越贵。
 */
function summaryHeadroom(contextWindow: number): number {
	return Math.min(SUMMARY_REPLY_MAX, Math.floor(contextWindow * SUMMARY_REPLY_SHARE)) + Math.min(2000, Math.floor(contextWindow / 20));
}

export function compactionTriggerTokens(contextWindow: number): number {
	return Math.max(0, Math.floor(Math.min(contextWindow * COMPACTION_RATIO, contextWindow - summaryHeadroom(contextWindow))));
}

/**
 * 低于这条线的价格分档不缩压缩窗口：1M 窗口的模型按 32k 的线压，扣掉提示词和工具表只剩几千，几乎每轮都在摘要、每次都丢信息——
 * 这比越线多付的那一档贵。128k 以上的线留出的对话空间够干活，照旧按线压。
 */
const MIN_TIER_LINE = 128_000;

/**
 * 压缩按多大的窗口算：模型有价格分档时，不低于 `MIN_TIER_LINE` 的最低一条分档线以上不当作可用的窗口。一次请求的输入越过分档线，
 * 整次按高一档计，之后每一轮都在线上方；压缩一次的代价只是一份摘要。把线换算成窗口（触发线正好落在线上），尾部、余量、按条丢弃
 * 都跟着按比例缩。
 */
function compactionWindow(model: Pick<BudgetModel, "contextWindow" | "tierLines">): number {
	// 跳过太低的线而不是整体作废：一个模型可能 32k、272k 两条线都有，272k 那条照样值得守。
	const line = (model.tierLines ?? []).reduce((lowest, above) => (above < MIN_TIER_LINE ? lowest : Math.min(lowest, above)), Infinity);
	return line < model.contextWindow * COMPACTION_RATIO ? Math.floor(line / COMPACTION_RATIO) : model.contextWindow;
}

export interface CompactionBudget {
	/** 整份请求（开销加历史）到这里就压。 */
	trigger: number;
	/** 历史落到这以下算压完了：只剪枝落到这里就不摘要，摘要旁的尾部也只删到这里。 */
	settled: number;
	/** 历史最多能占多少还不越线。光开销就占满触发线时不大于 0。 */
	room: number;
	/** 原样保留的尾部最多占多少。 */
	keep: number;
	/** 按条丢弃落到哪。 */
	dropped: number;
}

/**
 * `retiring`：手动压缩时这段对话本身的大小。`/compact` 是要把做完的事收起来，哪怕窗口还很空，尾部预算按对话而不是窗口算。
 */
export function compactionBudget(model: Pick<BudgetModel, "contextWindow" | "tierLines">, overhead: number, retiring?: number): CompactionBudget {
	const contextWindow = compactionWindow(model);
	const trigger = compactionTriggerTokens(contextWindow);
	const keep = contextWindow * KEEP_BUDGET;
	return {
		trigger,
		settled: Math.max(0, trigger - contextWindow * PRUNE_MARGIN - overhead),
		room: trigger - overhead,
		keep: retiring === undefined ? keep : Math.min(keep, retiring * KEEP_BUDGET),
		dropped: Math.max(0, contextWindow * SAFE_AFTER - overhead),
	};
}
