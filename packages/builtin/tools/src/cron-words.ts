/**
 * cron 表达式的人话：「每 5 分钟」「每天 09:00」「工作日 18:30」。用在点开定时任务、轮询那一行的「频率」上（「每 5 分钟」后面接着原式），原式照旧在旁边：
 * 人话只认几种常见写法，认不出的（列表、范围、步长混在一起）返回 undefined，只显示原式，不猜。
 */

import type { Locale } from "@plume/contract";
import { MESSAGES } from "./messages.ts";

const NUMBER = /^\d+$/;

export function cronWords(cron: string, locale: Locale): string | undefined {
	const words = MESSAGES[locale];
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) return undefined;
	const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
	if (day !== "*" || month !== "*") return undefined;
	const pad = (value: string) => value.padStart(2, "0");
	const step = /^\*\/(\d+)$/;
	if (hour === "*" && weekday === "*") {
		if (minute === "*") return words.everyMinute;
		const every = step.exec(minute);
		if (every) return Number(every[1]) === 1 ? words.everyMinute : words.everyMinutes(Number(every[1]));
		if (NUMBER.test(minute) && Number(minute) < 60) return words.hourlyAt(pad(minute));
		return undefined;
	}
	if (!NUMBER.test(minute) || Number(minute) >= 60) return undefined;
	const hours = step.exec(hour);
	if (hours && weekday === "*") return words.everyHours(Number(hours[1]), pad(minute));
	if (!NUMBER.test(hour) || Number(hour) >= 24) return undefined;
	const time = `${pad(hour)}:${pad(minute)}`;
	if (weekday === "*") return words.dailyAt(time);
	if (weekday === "1-5") return words.weekdaysAt(time);
	if (NUMBER.test(weekday) && Number(weekday) <= 7) return words.weeklyAt(Number(weekday), time);
	return undefined;
}
