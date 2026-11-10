/**
 * 一个滚动面是不是在跟随自己的底部，以及什么东西有权改变这一点。
 *
 * 窗口里每一份转录——对话、侧聊、委派的日志——要的都是同一种行为：有东西进来时贴着底部走，读者
 * 往上翻去看什么时留在原地，并且给一条回来的路。三份各自长出来的实现会慢慢走样，所以这个文件是
 * 规则，每个滚动面都只是调用方。
 *
 * 这里什么都不碰 DOM。每样东西都是一次几何读数加一个事件的纯函数，这样那些有意思的情形——只在
 * 一轮输出中途的某一帧出现的那些——才能写成测试，而不是靠手去复现。
 *
 * 这里唯一值得带走的想法：
 *
 *   跟随是一种**意图**，不是一个位置。
 *
 * 在每次滚动事件里问「scrollTop 是不是接近末尾」并把答案当成读者的意愿，是行不通的。scrollTop
 * 不只是读者在写，程序也在写——视口变矮、图片加载、面板隐藏又显示，都会挪动它——于是程序会一直用
 * 自己的写入推翻读者。所以 `nextState` 是不对称的：离开由事件驱动（滚轮往上一格是明确的，不管多小），
 * 回来由位置驱动（没有一个事件叫「我想重新跟随」；到达底部是唯一的表达方式）。
 *
 * 这个不对称有一条推论，同一个毛病犯了第二次才学到：
 *
 *   位置变化可以**恢复**跟随，永远不能结束它。
 *
 * 留一道后门的做法是：一次位置往上移的滚动事件，只要最近 300ms 里见过某个输入，就结束跟随——这个
 * 时间窗之所以在，是因为滚动锚定会自己挪 `scrollTop`，不能被当成读者。可它分不清两者。输入是从整个
 * 窗口听来的，于是在任何地方松开鼠标——侧栏、面板、输入框——都会打开这个窗口，落在窗口里的任何重排
 * 都被读成「读者往上走了」。一组工具落定、运行行折叠、最旧的一轮离开挂载范围：每一件都会让一份没人碰
 * 过的转录停止跟随，在读者正看着内容进来的会话上留下「有新内容」。
 *
 * 所以一次单纯的位置变化，现在只说它能诚实说出的那一件事，那就是 `arrived`。所有结束跟随的东西都以
 * 手势的形式到来，来自一个叫得出它名字的监听器。
 */

export type FollowState =
	/** 贴着底部走：尾部长高和视口变化都会重新钉住。 */
	| "following"
	/** 读者在上面某处，除了读者自己，谁都不能挪动他们。 */
	| "detached"
	/** 正在滑回底部。可以打断——见 `nextState`。 */
	| "returning";

/**
 * 换掉滚动面之后还留着的意图。
 *
 * 正在回去的面已经被要求跟随末尾了；动画只是这个意图正在被执行的方式。滑动途中打开了另一个会话，
 * 要是把它记成 detached，旧的面恢复时就停在半路，又一次给出「回到最新」。
 */
export function followsAfterRestore(state: FollowState): boolean {
	return state !== "detached";
}

/**
 * 离底部多近算「跟上了」，单位像素。
 *
 * 只用来判断**重新进入**。要是同时拿它判断读者有没有离开，一轮输出时往上挪 50px 就不可能做到：
 * 那一下落在余量里，面仍然认为自己被钉着，下一个 token 又把它拽回去。现在离开只要一格滚轮，不要
 * 任何距离。
 *
 * 宽到能原谅惯性滚动最后那几个像素，窄到从一屏开外不会意外够到。
 */
const FOLLOW_SLACK = 72;

/**
 * 读者离开余量多远之后才给出回去的路，单位像素。
 *
 * 用第二个更大的门槛而不是同一个，好让按钮有一段不会闪烁的带：在 `FOLLOW_SLACK` 和这个值之间，
 * 面已经脱离跟随，但什么都不说，停在差一点到底的滚动就落在这里。
 */
const AWAY_THRESHOLD = 160;

/**
 * 某一瞬间滚动面的样子：这里每个判断都从这三个数出发。
 *
 * 有意只有几何。浮在最后一段内容上的东西——审批卡、回到最新的按钮——在它该在的地方处理，作为滚动
 * 内容底部的内边距（`--plume-bottom-inset`），好让页面的底部是最新消息真正看得见的地方。把重叠量折进
 * 这里的算术是双重错误：`scrollTop` 不可能超过 `scrollHeight - clientHeight`，一个正的 inset 会让
 * `atBottom` 永远够不着，钉住一份永远满足不了自己判断的转录。
 */
export interface Reading {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

/**
 * 让内容末尾贴住视口底边的 scrollTop。
 *
 * 整数，而且只是近似：`scrollHeight` 和 `clientHeight` 都取过整，所以这个值最多比内容真正的末尾
 * 差一个像素。对下面那些都留了一像素余量的距离判断够用；拿来写不够——见 `targetScrollTop`。
 */
export function visualBottom(reading: Reading): number {
	return Math.max(0, reading.scrollHeight - reading.clientHeight);
}

/** 读者离底部多远。 */
export function distanceToBottom(reading: Reading): number {
	return reading.scrollHeight - reading.scrollTop - reading.clientHeight;
}

/** 内容没填满视口。永远算「在底部」，永远不值得一个按钮。 */
export function fitsInView(reading: Reading): boolean {
	return reading.scrollHeight - reading.clientHeight <= 1;
}

/**
 * 滚动面不在屏幕上时拿到的读数。
 *
 * 用 `display: none` 收起的窗格、最小化的窗口、元素被摘下时触发的 `ResizeObserver`：报的都是零，
 * 而零满足所有「在底部」的判断。这样的读数什么都证明不了，绝不能进状态机——按它行事，切换面板就会
 * 把一个会话记住的位置覆盖成「转录顶部，并且算作钉住」。
 */
export function isDegenerate(reading: Reading): boolean {
	return reading.clientHeight <= 0;
}

/** 读者在哪，只分要紧的两段。 */
export function atBottom(reading: Reading): boolean {
	return fitsInView(reading) || distanceToBottom(reading) <= FOLLOW_SLACK;
}

/**
 * 真的在末尾，而不只是在 72px 的重新进入带里。
 *
 * `arrived` 要是用 `atBottom`，只挪了 20px 的一格滚轮会被当成「回到了末尾」，下一次写入又把面粘回
 * 底部。那条带留给有意重新跟上的向下手势；一次叫不出名字的位置变化，必须正好停在最后一个像素上。
 */
function landedAtBottom(reading: Reading): boolean {
	return fitsInView(reading) || distanceToBottom(reading) <= 1;
}

export function isAway(reading: Reading): boolean {
	return !fitsInView(reading) && distanceToBottom(reading) > AWAY_THRESHOLD;
}

/**
 * 一个手势往哪个方向，在能知道的时候。
 *
 * 滚轮、按键、拖滑块都直接说了。按下手指没说，报成 `"unknown"`：由之后的位置决定，和一次停在底部的
 * 拖动一直遵守的规则一样。
 */
export type Direction = "up" | "down" | "unknown";

/**
 * 什么可以改变意图。
 *
 * 几何有意不在这里——内容追加、上面有东西折叠、输入框长高。它们都不能改变意图，把新几何读回来当作
 * 「读者想不想跟随」的答案，正是往一个长高 200px 的输入框里打字会冒出「回到最新」按钮、一个窗格短暂
 * 报 0×0 会得到一份滚在顶部却算作钉住的转录的原因。它们作为位置应用（`targetScrollTop`），从不喂给
 * `nextState`。
 */
export type FollowEvent =
	/** 读者动了，这是唯一可以结束跟随意图的事件。 */
	| { kind: "user-scroll"; direction: Direction }
	/**
	 * 面停在一个这里没人要求过的位置。
	 *
	 * 每一次不是这个模块自己写的滚动：甩动的尾巴、浏览器夹住一份刚失去最旧一轮的转录、上方展开一段
	 * 推理时锚定稳住一行。到达状态机时它们只是四个来路不明的数，彼此分不开，也没有一个是手势。所以
	 * 唯一能做的断言是面回到了末尾——唯一能做的事是重新开始跟随。见文件顶部的推论。
	 */
	| { kind: "arrived" }
	/** 读者要求回去：按钮、End 键、发送一条消息。 */
	| { kind: "user-return" }
	/** 一次滑动到达了。 */
	| { kind: "settle" };

/**
 * 整个状态机。
 *
 * 有意写得像一张表：它要防的毛病，都是一个分支和另一个分支在一个谁都没点名的情形上意见不一。
 */
export function nextState(state: FollowState, event: FollowEvent, reading: Reading): FollowState {
	// 隐藏时拿到的读数不是证据；保持读者上一次的意思。
	if (isDegenerate(reading)) return state;

	switch (event.kind) {
		case "user-scroll":
			// 滑回去途中的手势是改了主意，不管指向哪边。先于方向判断，这样滑到一半往下推一下会停住
			// 动画，而不是被读成「对，继续」——读者碰了这块面，这就是全部信号。
			if (state === "returning") return "detached";
			if (event.direction === "up") {
				// 门槛为零，是有意的。一轮输出时往上一格是一句完整的话：「别动了」。去问它走了多远，正是
				// 每次这种手势的头 80px 都消失的原因。
				//
				// 除非根本没东西可滚：装得下的转录无处可离开。读成离开的话，回复随后长过窗口，就卡在顶部。
				return fitsInView(reading) ? state : "detached";
			}
			// 向下，或者方向不可知的拖动：由位置回答。到达底部是说「重新跟随」的唯一方式，所以它本身
			// 就必须足够。
			return atBottom(reading) ? "following" : "detached";

		case "arrived":
			// 滑回去本身就是跟随的意图，这里要判断的位置是它自己的帧。不管它，等 `settle` 说结束了。
			if (state === "returning") return state;
			// 在末尾就是跟随；别处就是原来的意思。没写的那个 `: "detached"` 就是整条规则——见文件顶部的推论。
			//
			// 这里的「末尾」是最后一个像素，不是 72px 的余量。那段余量是向下手势说「我回来了」的方式。
			// 在 `arrived` 上用它，20px 的一格滚轮往上就会弹回家：脱离、原生滚动、在余量里 arrived、跟随、写到底部。
			return landedAtBottom(reading) ? "following" : state;

		case "user-return":
			// 已经在底部就无处可滑；硬说要滑，代价是一段什么都没挪动的 420ms 动画，外加按钮在自己的
			// 点击里淡出的那一帧。
			return atBottom(reading) ? "following" : "returning";

		case "settle":
			// 只有跑完的滑动才到这里——被打断的那次，已经被打断它的手势带到 `detached` 了。
			return state === "returning" ? "following" : state;
	}
}

/**
 * 一个事件之后面应该在哪，`null` 表示别动它。
 *
 * 和 `nextState` 分开，是因为它们回答的问题不同、被调用的时机也不同：状态在事件处理里决定，位置在
 * 绘制前的布局副作用里应用。返回 `null`——而不是当前的 `scrollTop`——调用方才能整个跳过写入，而跳过
 * 写入正是惯性滚动不被打断的原因。
 */
export function targetScrollTop(state: FollowState, reading: Reading): number | null {
	if (isDegenerate(reading)) return null;
	if (state !== "following") return null;
	const target = visualBottom(reading);
	// 已经在那里了。照写一遍不是没有代价：赋值 `scrollTop` 会打断进行中的甩动，而在钉住的转录上，
	// 这个赋值每收到一个 token 就发生一次。
	if (Math.abs(reading.scrollTop - target) < 1) return null;
	/*
	 * 有意越过末尾一个像素，让浏览器把它夹到真正的末尾。
	 *
	 * `visualBottom` 是两个取过整的整数相减，而内容真正的高度不是整数：中文正文一行排 26.25px，所以
	 * 转录真正的可滚动最大值带小数部分，随着长高在 .023 → .273 → .523 → .773 之间循环。`scrollTop`
	 * 本身是小数，写整数就把内容停在离底部差那么一点的地方——尾部每变一次，差的量都不同。
	 *
	 * 这个差就是抖动。照脚本跑一轮量过：220 次跟随写入里，73 次让画出来的内容挪了亚像素——0.25px 和
	 * 0.75px——最新的消息气泡和它下面的运行行每次都一起滑一下。在 2 倍屏上，就是任何让尾部一直在动的
	 * 东西下面都有一个物理像素在闪。
	 *
	 * 越过去是到达真正末尾的唯一办法：没有哪个 DOM 属性报告它，浏览器按精确的几何算夹紧。`write`
	 * 会把夹过的值读回来，所以 `onScroll` 里的自写检查和下游的所有东西看到的是它真正落在哪，而不是
	 * 要求的是哪。
	 */
	return target + 1;
}

// ---------------------------------------------------------------------------
// 未读
// ---------------------------------------------------------------------------

/**
 * 足够判断到底有没有新东西来的那一部分转录。
 *
 * 只看 `count` 会漏掉正在写的回复——一条消息，在长。只看 `tail` 会漏掉同时落地、结尾看着一样的
 * 两条消息。两个合起来才够回答「这还是我上次看的那份转录吗」，而且——要紧的是——两个都是**值**，
 * 所以从磁盘重读、以新数组交回的转录，和它替换掉的那份比较起来相等。
 */
export interface Marker {
	count: number;
	/** 最后一行变了它就变的东西：它的键加上它已经有多少。 */
	tail: string;
}

export function marker(count: number, tail: string): Marker {
	return { count, tail };
}

/**
 * 读者上次看到末尾之后，来了多少条消息。
 *
 * 它要杜绝的毛病：一份只是又被交给了 React 一次的转录，亮起「有新内容」。打开一个会话会设置两遍
 * 消息——一遍来自缓存，一遍是磁盘读完落地——第二遍改变了数组的引用，别的什么都没变。按引用判断的
 * 未读标记把那当成了新内容。这里按上面那两个数判断，第二遍什么都不贡献。
 *
 * 回退和压缩会让转录变短。两者都不是新内容，也都没给读者留下什么要追的，所以都报零。
 */
export function unreadSince(seen: Marker | null, now: Marker): number {
	if (!seen) return 0;
	if (now.count < seen.count) return 0;
	const added = now.count - seen.count;
	if (added > 0) return added;
	// 条数一样：唯一可能变了的是最后一条，而一条在读者眼皮底下长的回复，不管多了多少 token，都只是
	// 一件要追的事。
	return now.tail === seen.tail ? 0 : 1;
}
