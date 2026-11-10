/**
 * 一条正在输出的回复，每个字什么时候放出来。纯逻辑，`useSmoothText` 按它逐帧切原文。
 *
 * 字到达的节奏是服务商的：有的每个 token 一帧，有的攒几百毫秒一次倒出一两百字（DeepSeek 经中转
 * 的流每 0.5s 左右停 200–400ms）。照原样画是停住、整句蹦出来、再停住。这里把到了的字排进一条
 * 时间线：**每一批按上游最近一秒的平均速度匀着放，夹在一条缓冲带里**——不早于到达后 `hold`，不晚于
 * 到达后 `MAX_LAG`。
 *
 * `hold` 是给上游停顿留的余量：队里至少攒着这么久的字，上游停这么久屏幕也不停。它按最近观察到的
 * 最长停顿定（`gapMax`），不是一个固定的数：按 token 流的服务商停顿只有一两帧，屏幕几乎不落后；
 * 一阵一停的服务商停多久就留多久，上限 `MAX_LAG`。从前固定留 400ms，每一条回复、每一个服务商都
 * 落后 400ms 起步，写完以后还要再放 0.4–0.7 秒；而停得比 400ms 久的上游，照样一顿一顿。
 *
 * 速度没有上限。从前封在每秒 500 字，理由是出字多快整段回复就往上走多快、太快读不过来——可那是
 * 模型的速度，不是界面该替它装慢的：写 15 秒的回复写完还要放 5 秒。字漂不漂由模型决定，跟随滚动
 * 把每一帧挪匀就够了。
 *
 * **按词放，不按字。** 匀速逐字出是电传打字机。拉丁文正在打的半个词不放出来（`wordCut`），每个词
 * 的间隔等于词长除以速率，长词停得久、短词过得快，节奏像说话；顺带行尾的词不会先打半个再跳到下
 * 一行。中文一个字就是一个音节，照字放。上游停下超过 `HOLD_RELEASE` 就不再扣着：那可能是一个写完
 * 了、后面没跟空格的词。
 */

/** 一个字淡入要多久。透明度按它在 `FadeText.tsx` 里逐拍算。 */
export const FADE = 180;
/** 上游的平均速度按多长的时间窗来估。要比上游一次「流一阵、停一下」长，才平得掉它。 */
const RATE_TAU = 1000;
/** 这条流刚开始时，时间窗最少按这么长算。 */
const WINDOW_MIN = 300;
/** 落后比余量多出来的部分，每一批收回几成。 */
const PULL = 0.25;
/** 最近的最长停顿按多久衰减：停顿的模式变了（换了阶段），一两秒后就不再按老样子留余量。 */
const GAP_TAU = 2000;
/** 屏幕最多落后模型多久：每一批字不晚于到达后这么久出完。 */
const MAX_LAG = 700;
/**
 * 给上游停顿留的余量的上下限。下限约一帧多一点，再短就是来一帧画一帧；上限就是 `MAX_LAG`：每 600ms
 * 倒一批的上游，要屏幕不停就得落后一整个周期，这是抹平一阵一停的最低代价，不是可以省的。
 */
const HOLD_MIN = 60;
const HOLD_MAX = MAX_LAG;
/** 头一批字（还不知道上游多快）最多在这么多毫秒内放完：整句一次到达的短回复是从左到右出来的，不是整句浮现。 */
const CATCH_UP = 400;
/** 头一批字按这个速度估（字/毫秒），短的几个字几帧就出完。 */
const FIRST_RATE = 0.2;
/** 积压很少时，相邻两个字最多隔多久（即最慢 60 字/秒），免得最后几个字拖着出来。要摊满余量时例外，见 `plan`。 */
const SLOWEST = 1000 / 60;
/** 上游停了这么久再来的字，按一条新的流算：之前的节奏说明不了接下来的。 */
const RESET = 1500;
/** 一次进来这么多字就不是在「输出」了（重连、补发），直接全放。 */
const JUMP = 2000;
/** 上游停下超过这么久，正在打的半个词也放出来。 */
const HOLD_RELEASE = 250;
/** 半个词最多扣多少个字：再长的不是词（哈希、base64），照常放。 */
const HOLD_CHARS = 24;

export class Pace {
	/** 第 n 个 UTF-16 单元的放出时刻（`performance.now()`），只增不减。 */
	readonly births: number[] = [];
	/** 已经排进时间线的原文长度，和最近一次来字的时刻。 */
	private seen = 0;
	private seenAt = Number.NEGATIVE_INFINITY;
	/** 这条流开始的时刻，和按 `RATE_TAU` 衰减的最近字数（除以时间窗就是平均速度）。 */
	private startedAt = 0;
	private recent = 0;
	/** 最近观察到的最长停顿，按 `GAP_TAU` 衰减。 */
	private gapMax = 0;

	/** 最近一次来字的时刻；一次也没来过是负无穷。 */
	get arrivedAt(): number {
		return this.seenAt;
	}

	/** 最后一个字放出来的时刻。 */
	get done(): number {
		return this.births.at(-1) ?? 0;
	}

	/**
	 * 挂上时已经有的字：当作早就放出来了（淡也淡完了），不重放。
	 * 不算到达：拿它估速度，会把打开会话那一刻当成每秒几千字。
	 *
	 * 多往前挪 1ms：`useSmoothText` 拿 `done + FADE > now` 判断还在不在淡，`(now - FADE) + FADE` 有时会比
	 * `now` 多出一点浮点尾数，打开会话时写完的回复就被当成在演，行内代码和代码块闪一下淡入。
	 */
	present(length: number, now: number): void {
		while (this.births.length < length) this.births.push(now - FADE - 1);
		this.seen = Math.max(this.seen, length);
	}

	/** 原文长到了 `length`：新到的这一批字排进时间线。同一个长度调第二次什么也不做。 */
	plan(now: number, length: number): void {
		const arriving = length - this.seen;
		if (arriving <= 0) return;
		const since = now - this.seenAt;
		const fresh = since > RESET;
		this.seen = length;
		this.seenAt = now;
		const last = this.births.at(-1) ?? Number.NEGATIVE_INFINITY;
		if (arriving > JUMP) {
			this.startedAt = now;
			this.recent = 0;
			this.gapMax = 0;
			while (this.births.length < length) this.births.push(now);
			return;
		}
		const from = Math.max(now, last);
		let end: number;
		let slowest = SLOWEST;
		if (fresh) {
			this.startedAt = now;
			this.recent = arriving;
			this.gapMax = 0;
			end = now + Math.min(CATCH_UP, Math.max(HOLD_MIN, arriving / FIRST_RATE));
		} else {
			this.gapMax = Math.max(since, this.gapMax * Math.exp(-since / GAP_TAU));
			// 衰减的总量而不是「这批字数 / 离上一批多久」的平均：后者在两批挨得很近时大得离谱，估出来的
			// 速度偏快，队伍在上游停顿之前就放空，屏幕跟着停。时间窗按这条流实际跑了多久归一，刚开始
			// 那几批不会因为窗还没填满而被估得极慢；但最少按 `WINDOW_MIN` 算，不然开头几十毫秒里倒进来
			// 一大段，会被当成每秒几千字一口气放完。
			this.recent = this.recent * Math.exp(-since / RATE_TAU) + arriving;
			const window = RATE_TAU * (1 - Math.exp(-Math.max(WINDOW_MIN, now - this.startedAt) / RATE_TAU));
			const rate = this.recent / window;
			const hold = Math.min(HOLD_MAX, Math.max(HOLD_MIN, this.gapMax));
			// 按平均速度放，落后就一直是那么多：开头估慢了攒下的、上游提速时攒下的，都不会自己消掉。
			// 比余量多出来的那截，每批收回 `PULL` 这么多，几批之后落后就回到余量上。
			const excess = Math.max(0, from - now - hold);
			end = Math.min(now + MAX_LAG, Math.max(now + hold, from + arriving / rate - excess * PULL));
			// 慢的上游（每秒不到 60 字）一批只有几个字，按 `SLOWEST` 几帧就放完，余下的停顿屏幕干等下一批，
			// 看着是一段一段吐出来的。所以这批字往余量的末尾摊，但不慢过上游平均间隔的 1.5 倍：上游停过一大下
			// 之后余量撑到了顶，只按余量摊，接着来的几个字就成了慢动作（停 1 秒后 12 个字放 750ms）。1.5 是因为
			// `rate` 把刚到的这一批算了全额，一阵一停的上游会被估快两三成，按 1 倍摊不满，每批之间还空 100–200ms。
			slowest = Math.max(SLOWEST, Math.min((now + hold - from) / arriving, 1.5 / rate));
		}
		const pace = Math.min(slowest, Math.max(0, (end - from) / arriving));
		let at = last;
		while (this.births.length < length) {
			at = Math.max(now, at + pace);
			this.births.push(at);
		}
	}

	/** 到 `now` 为止可以放出来的字数（UTF-16 单元）。放出时刻递增，二分。 */
	cut(now: number): number {
		const births = this.births;
		let lo = 0;
		let hi = births.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (births[mid]! <= now) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	/** 最近 `within` 毫秒内放出来的字数。 */
	recentCount(now: number, within: number): number {
		return this.cut(now) - this.cut(now - within);
	}
}

/**
 * 时间线说可以放到 `cut` 了，实际切在哪：不切在代理对中间（emoji 会先露出半个乱码），`hold` 时
 * 也不切在一个拉丁词的中间。切不出词的边界（`HOLD_CHARS` 以内没有）就照常放。
 */
export function wordCut(text: string, cut: number, hold: boolean): number {
	if (cut < text.length) {
		const code = text.charCodeAt(cut);
		if (code >= 0xdc00 && code <= 0xdfff) cut++;
	}
	if (!hold || cut === 0) return cut;
	// 正好切在原文末尾也一样：末尾那个词多半还没打完，后面的字还在来。
	if (!isWordChar(text, cut - 1) || (cut < text.length && !isWordChar(text, cut))) return cut;
	for (let at = cut - 1; at > 0 && at > cut - HOLD_CHARS; at--) {
		if (!isWordChar(text, at - 1) || !isWordChar(text, at)) return at;
	}
	return cut;
}

/** 上游停下超过 `HOLD_RELEASE` 了吗：那就不再扣着半个词。 */
export function holdsWord(now: number, arrivedAt: number, live: boolean): boolean {
	return live && now - arrivedAt < HOLD_RELEASE;
}

const WORD = /[\p{L}\p{N}_\x27]/u;
/** 中日韩的字各自成词，不算在「词」里：照字放，也不会在行尾被挪到下一行。 */
const IDEOGRAPH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function isWordChar(text: string, at: number): boolean {
	const code = text.codePointAt(at);
	if (code === undefined) return false;
	// 落在代理对的后半：看整个字。
	const low = code >= 0xdc00 && code <= 0xdfff;
	const char = String.fromCodePoint(low ? (text.codePointAt(at - 1) ?? code) : code);
	return WORD.test(char) && !IDEOGRAPH.test(char);
}
