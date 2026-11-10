/**
 * 形状像还没到的那样东西的占位。
 *
 * 用处不是在等的时候找点事看——而是内容落地时页面已经是对的形状，什么都不跳。转圈或一行「读取中…」
 * 说的是「等等」，它一消失，底下的一切就重新排一遍；这些占位占的是真实的行和卡片将要占的同一些盒子。
 *
 * 只给*第一次*加载用。一旦有东西可显示，显示它本身胜过显示它的草图——真实内容背后的重新校验
 * 不能动那些内容。
 */

import { translate } from "../i18n/translate.ts";
import { useEffect, useState } from "react";

/**
 * 一次加载是否已经久到值得画占位。
 *
 * 只出现两帧的骨架是一次闪烁，闪烁读起来是故障而不是进度——缓存热的时候一个列表 59ms 就填满了，
 * 其中占位只待了 32ms。阈值以下什么都不显示，这是对一次没人察觉的等待最诚实的描绘。
 */
export function useSlowLoad(loading: boolean, delay = 220): boolean {
	const [slow, setSlow] = useState(false);

	useEffect(() => {
		if (!loading) {
			setSlow(false);
			return;
		}
		const timer = window.setTimeout(() => setSlow(true), delay);
		return () => window.clearTimeout(timer);
	}, [loading, delay]);

	return loading && slow;
}

/** 一块暗色的块。`width` 是任意 CSS 长度，一排这样的块看起来能像字而不是像条。 */
export function SkeletonBar({ width, height = 10, className = "" }: { width: string; height?: number; className?: string }) {
	return <span className={`plume-skeleton block rounded-full ${className}`} style={{ width, height }} />;
}

/**
 * 一张目录卡片：标志、标题、两行描述，右边一个按钮。
 *
 * 宽度随序号变，这样一格一格排开时不像印出来的花纹——眼睛找到重复比找到文字快，完全规整的占位看起来像 bug。
 */
function SkeletonCard({ index = 0 }: { index?: number }) {
	const title = [92, 116, 78, 104][index % 4] ?? 96;
	const second = [82, 64, 90, 71][index % 4] ?? 78;

	return (
		<div className="flex items-start gap-3 p-3" aria-hidden>
			<span className="plume-skeleton block shrink-0 rounded-lg" style={{ width: 36, height: 36 }} />
			<div className="min-w-0 flex-1 pt-0.5">
				<SkeletonBar width={`${title}px`} height={11} />
				<SkeletonBar width="100%" height={9} className="mt-2.5" />
				<SkeletonBar width={`${second}%`} height={9} className="mt-1.5" />
			</div>
			<span className="plume-skeleton mt-0.5 block shrink-0 rounded-lg" style={{ width: 58, height: 26 }} />
		</div>
	);
}

/** 设置列表的一行：标志、标题、一行说明，和开关。 */
function SkeletonRow({ index = 0 }: { index?: number }) {
	const title = [70, 96, 58, 84][index % 4] ?? 76;
	const detail = [68, 84, 56, 76][index % 4] ?? 70;

	return (
		<div className="flex items-center gap-3 py-3.5" aria-hidden>
			<span className="plume-skeleton block shrink-0 rounded-lg" style={{ width: 32, height: 32 }} />
			<div className="min-w-0 flex-1">
				<SkeletonBar width={`${title}px`} height={11} />
				<SkeletonBar width={`${detail}%`} height={9} className="mt-2" />
			</div>
			<span className="plume-skeleton block shrink-0 rounded-full" style={{ width: 34, height: 20 }} />
		</div>
	);
}

/**
 * 一格卡片，和目录自己的两栏排版一致。
 *
 * `label` 是告诉读屏的话，代替那些对它毫无意义的形状。
 */
export function SkeletonGrid({ count = 6, label = translate("common.reading") }: { count?: number; label?: string }) {
	return (
		<div className="pt-6" role="status" aria-label={label}>
			<div className="grid grid-cols-1 gap-x-4 @2xl:grid-cols-2">
				{Array.from({ length: count }, (_, index) => (
					<SkeletonCard key={index} index={index} />
				))}
			</div>
		</div>
	);
}

/** 一摞设置行，和它们代替的那个列表一致。 */
export function SkeletonList({ count = 5, label = translate("common.reading") }: { count?: number; label?: string }) {
	return (
		<div role="status" aria-label={label}>
			{Array.from({ length: count }, (_, index) => (
				<SkeletonRow key={index} index={index} />
			))}
		</div>
	);
}
