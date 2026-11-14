import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** 两份之间的空隙，字不会撞上自己的副本。 */
const GAP = 44;
/** 每秒多少像素。够慢，读一条长路径不用追着看。 */
const SPEED = 46;

const NO_FIT = { over: 0, hidden: 0, width: 0 };

/** 差不到一个像素的不算变：一个来回抖一像素的读数会让观察器的每次回调都重画一遍。 */
const moved = (prev: number, next: number) => (Math.abs(next - prev) > 1 ? next : prev);

/**
 * 一行字，到边上渐隐而不是以省略号结尾，所在的行被悬停时自己读出来：那一行（父级）要带 `plume-scroll` 类。
 *
 * 省略号只报告标题被截了，不说截掉的是什么——每个以「帮我梳理这个项目的整体架构」开头的会话都缩成
 * 同一行没法用的字。渐隐说的是同一件事，但更安静，悬停滚动则真正回答了那个问题。
 *
 * 滚动只朝一个方向、连续地走。左右来回扫读起来像这一行在抽搐，而不是字在被读：眼睛得一次次重新
 * 找到开头。第一份后面跟着一份隐藏的副本，单向才能无缝循环——原文离开时，副本正好落在它开始的位置。
 *
 * 只有字真的读不全时才动：已经装得下的行，指针划过时不能抖。父级行带着 `plume-scroll`，悬停规则
 * 认的就是它。
 */
export function ScrollText({
	text,
	className = "",
	textClassName = "",
}: {
	text: ReactNode;
	className?: string;
	/**
	 * 加在装字形的那几个 span 上——正文和它循环用的副本——不加在盒子上。
	 *
	 * 给那些透过字本身画出来的效果用（`background-clip: text`、运行中的流光）。加在盒子上的话，它按
	 * 盒子自己那一层的字形裁剪，而跑马灯的 transform 把轨道抬进了单独的一层：悬停时整行变成空白。
	 */
	textClassName?: string;
}) {
	const box = useRef<HTMLSpanElement>(null);
	const body = useRef<HTMLSpanElement>(null);
	/**
	 * 越出盒子的那一截（`over`），和悬停时读不到的那一截（`hidden`）——后者把控件占掉的宽度也算进去。
	 * `width` 是字自己的宽，只有滚起来才用得到（一圈走多远、副本放哪）。
	 */
	const [{ over, hidden, width }, setFit] = useState(NO_FIT);

	useLayoutEffect(() => {
		const outer = box.current;
		const inner = body.current;
		if (!outer || !inner) return;

		/*
		 * 亚像素的差别是噪声——装得下的行不能报 0.4px 的溢出然后为它动起来。死区和取整一样要紧：
		 * 一个来回抖一像素的读数，会让观察器的每次回调都永远重新渲染一遍。
		 */
		const measure = () => {
			// 溢出比较的是布局尺寸，不受正在移动的窗格那一时的缩放影响。
			const part = inner.offsetWidth;
			const room = outer.clientWidth;
			/*
			 * 悬停时会有控件落在这一行最后的一段上，那段宽度写在 `--plume-row-controls` 上。
			 *
			 * 装不装得下要分两次问，而从前只问了一次。「比盒子宽」只管得住静止的样子；悬停一来，
			 * 图钉和归档压在标题最后那 47px 上，遮罩把那一段整个抹平——于是一个 13 个字、盒子明明
			 * 装得下的标题，鼠标一放上去就少掉最后一个字，而且是一刀切的，因为不滚的行没有
			 * `plume-fade-edge`，右边那道渐隐的深度是 0。
			 *
			 * 读不到就是装不下，跟是谁挡的没关系。所以这里问的是「悬停之后还剩多少地方」，控件占掉的
			 * 算进去；答案是「不够」，这一行就该跟长标题走同一条路：化开，并且悬停时自己读出来。
			 *
			 * 列表之外的用法读不到这个变量（没有人写），于是 reserve 是 0，判定和从前一模一样。
			 */
			const reserve = Number.parseFloat(getComputedStyle(outer).getPropertyValue("--plume-row-controls")) || 0;
			const spill = Math.max(0, part - room);
			const unread = Math.max(0, part - (room - reserve));
			setFit((prev) => {
				const over = moved(prev.over, spill);
				const hidden = moved(prev.hidden, unread);
				/*
				 * 不滚的时候不跟着字宽走。字宽在缓（`RollWords` 换句子时把词框的宽度过渡过去）的那几百毫秒里，
				 * 观察器每一帧都报一次、每次都差出 2px；记着它，装得下的一行就跟着每帧重画。并行工具的一轮量到
				 * 过每秒约 90 次，全是这一个数在变，而它在不滚的行上根本没人读。
				 */
				const width = hidden > 1 ? moved(prev.width, part) : prev.width;
				return over === prev.over && hidden === prev.hidden && width === prev.width ? prev : { over, hidden, width };
			});
		};
		measure();

		/*
		 * 内容变了也靠这个观察器，不再靠 effect 的依赖。
		 *
		 * 从前依赖 `[text]`，于是每收到一个字就把观察器拆了重建一次；而 `text` 一旦可以是节点而不
		 * 只是字符串，每次渲染都是一个新对象，那就成了每帧重建。文字变了、宽度跟着变，观察 inner
		 * 的这只手本来就会报——宽度没变的改动也确实不需要重测。
		 *
		 * 侧边栏改宽度（抽屉/推开）和网页字体落地时的重排，同样从这里来。
		 */
		const observer = new ResizeObserver(measure);
		observer.observe(outer);
		observer.observe(inner);
		/*
		 * 重叠量（`--plume-row-controls`）由悬停控件条量出来、写在行上。写它不一定改变这里的任何尺寸，
		 * 而尺寸真变了的时候这个观察器又先触发：折叠一个项目，计数挤进来、标题变窄，这里拿旧的重叠量
		 * 重新判断，控件条随后才写入新的。控件条每次写入都在行上广播一声，这里听到就再量一次。悬停行
		 * 之外没有谁广播，那里什么都不变。
		 */
		const row = outer.closest("[data-plume-hover-row]");
		row?.addEventListener("plume-row-controls", measure);
		return () => {
			observer.disconnect();
			row?.removeEventListener("plume-row-controls", measure);
		};
	}, []);

	/** 悬停时读不全就滚：被控件盖住和越出盒子，对读的人是同一件事。 */
	const scrolls = hidden > 1;
	/** 静止时就装不下的那一种，右边那道虚化要常驻——它说的是「后面还有」。 */
	const clipped = over > 1;
	// 一整圈把第一份带出左边，第二份正好停在第一份开始的位置。定速而不是定时长，略长一点的标题
	// 不会慢慢爬，很长的也不会飞奔。
	const distance = width + GAP;
	const duration = Math.max(2200, Math.round((distance / SPEED) * 1000));

	return (
		<span
			ref={box}
			/*
			 * 两种「装不下」分开说，因为它们化开的时机不同。
			 *
			 * `over` 静止时就该虚化；`yield` 静止时一点事没有，只有控件压上来的那一刻才需要让位。
			 * 给 yield 的行也常驻一道虚化，等于把一个本来完整的标题平白抹淡——那是另一个方向的同一个错。
			 */
			data-plume-scroll-fit={scrolls ? (clipped ? "over" : "yield") : undefined}
			className={`block overflow-hidden whitespace-nowrap ${scrolls ? "plume-fade-edge" : ""} ${className}`}
			style={scrolls ? ({ "--plume-marquee": `-${distance}px`, "--plume-scroll": `${duration}ms` } as React.CSSProperties) : undefined}
		>
			<span className={scrolls ? "plume-marquee-track plume-scroll-text-track" : "inline-block"}>
				<span ref={body} className={`inline-block ${textClassName}`}>
					{text}
				</span>
				{/* 副本不能改变 flex 基准，否则会反过来影响溢出的测量。 */}
				{scrolls && (
					<span aria-hidden data-plume-scroll-dup className={`absolute top-0 inline-block invisible ${textClassName}`} style={{ left: width + GAP }}>
						{text}
					</span>
				)}
			</span>
		</span>
	);
}
