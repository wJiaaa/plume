import type { HTMLAttributes } from "react";

/**
 * 一枚圆形序号：把两处说的同一件东西对上号。
 *
 * 正文里划线的那段字末尾挂一枚，审批卡上那条评论前面挂同一个数——人看到卡上的「2」，回到正文里
 * 找的就是那枚「2」，不用再读一遍引文去认。实心强调色、白字、等宽数字：两位数也不变形，深浅两套底色上
 * 都看得清。
 */
export function MarkNumber({ n, className = "", ...rest }: { n: number; className?: string } & Omit<HTMLAttributes<HTMLSpanElement>, "children">) {
	return (
		<span
			{...rest}
			aria-hidden
			className={`inline-flex h-[16px] min-w-[16px] shrink-0 select-none items-center justify-center rounded-full bg-accent px-[4px] text-mark font-semibold leading-none tabular-nums text-on-accent ${className}`}
		>
			{n}
		</span>
	);
}
