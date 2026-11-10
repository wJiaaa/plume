import { useEffect, useState } from "react";

/**
 * 此刻的时间，`active` 时每 `every` 毫秒重画一次：给秒表、倒计时这类在走的读数用，不走的时候一次也不重画。
 *
 * 变成 `active` 的那一下先对一次表：不对的话，挂上以后过了很久才开始走的读数，头一拍显示的是挂上那一刻。
 */
export function useNow(active: boolean, every: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), every);
		return () => clearInterval(timer);
	}, [active, every]);
	return now;
}
