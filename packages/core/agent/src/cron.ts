/**
 * 标准 5 字段 cron：分 时 日 月 星期，按本地时区。
 *
 * 支持 `*`、单值、范围 `a-b`、列表 `a,b`、步长 `*\/n` `a-b/n` `a/n`（vixie 的写法：从 a 到上限），
 * 月份和星期的英文缩写（`JAN`、`MON`），星期的 7 也是周日。日和星期都不是 `*` 时两者任一对上就算
 * （vixie 的规矩，`0 9 1 * MON` 是每月 1 号和每周一）。不支持 `L`、`W`、`?`、`@hourly` 这类扩展。
 *
 * 纯函数，没有依赖：仓库里没有装 cron 库，为五个字段引一个不值得。
 */

export interface CronSchedule {
	/** 原文，规整过空白。 */
	source: string;
	minute: ReadonlySet<number>;
	hour: ReadonlySet<number>;
	day: ReadonlySet<number>;
	month: ReadonlySet<number>;
	/** 0 是周日。 */
	weekday: ReadonlySet<number>;
	/** 日、星期字段是不是以 `*` 开头——决定两者是「且」还是「或」，见文件头。 */
	anyDay: boolean;
	anyWeekday: boolean;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface Field {
	name: string;
	min: number;
	max: number;
	names?: string[];
	/** 名字对应的数：月份从 1 起，星期从 0 起。 */
	base?: number;
}

const FIELDS: Field[] = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12, names: MONTHS, base: 1 },
	{ name: "day of week", min: 0, max: 7, names: WEEKDAYS, base: 0 },
];

/** 解析一个表达式。写错了抛错，错误说的是哪个字段、哪里不对，模型据此能改对。 */
export function parseCron(expression: string): CronSchedule {
	const parts = expression.trim().split(/\s+/).filter(Boolean);
	if (parts.length !== 5) throw new Error(`A cron expression has 5 fields (minute hour day-of-month month day-of-week); "${expression}" has ${parts.length}.`);
	const [minute, hour, day, month, weekday] = parts.map((part, index) => parseField(part, FIELDS[index]!));
	// 7 和 0 都是周日。
	if (weekday!.has(7)) {
		weekday!.delete(7);
		weekday!.add(0);
	}
	return {
		source: parts.join(" "),
		minute: minute!,
		hour: hour!,
		day: day!,
		month: month!,
		weekday: weekday!,
		anyDay: parts[2]!.startsWith("*"),
		anyWeekday: parts[4]!.startsWith("*"),
	};
}

function parseField(text: string, field: Field): Set<number> {
	const values = new Set<number>();
	for (const piece of text.split(",")) {
		if (!piece) throw new Error(`Empty item in the ${field.name} field "${text}".`);
		const [range, stepText, extra] = piece.split("/");
		if (extra !== undefined) throw new Error(`Bad step in the ${field.name} field: "${piece}".`);
		const step = stepText === undefined ? 1 : integer(stepText, field, piece);
		if (step < 1) throw new Error(`The step in the ${field.name} field must be at least 1: "${piece}".`);
		let from: number;
		let to: number;
		if (range === "*") {
			from = field.min;
			to = field.max;
		} else if (range!.includes("-")) {
			const [a, b, more] = range!.split("-");
			if (more !== undefined || !a || !b) throw new Error(`Bad range in the ${field.name} field: "${piece}".`);
			from = value(a, field, piece);
			to = value(b, field, piece);
			if (from > to) throw new Error(`The range in the ${field.name} field runs backwards: "${piece}".`);
		} else {
			from = value(range!, field, piece);
			// `5/15` 是从 5 到上限每 15 一个；没有步长的单值就是它自己。
			to = stepText === undefined ? from : field.max;
		}
		for (let n = from; n <= to; n += step) values.add(n);
	}
	return values;
}

function value(text: string, field: Field, piece: string): number {
	const named = field.names?.indexOf(text.toUpperCase()) ?? -1;
	const n = named >= 0 ? named + field.base! : integer(text, field, piece);
	if (n < field.min || n > field.max) throw new Error(`${text} is outside the ${field.name} field's ${field.min}-${field.max}: "${piece}".`);
	return n;
}

function integer(text: string, field: Field, piece: string): number {
	if (!/^\d+$/.test(text)) throw new Error(`"${text}" is not a number in the ${field.name} field: "${piece}".`);
	return Number(text);
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
	const day = schedule.day.has(date.getDate());
	const weekday = schedule.weekday.has(date.getDay());
	return !schedule.anyDay && !schedule.anyWeekday ? day || weekday : day && weekday;
}

/** 一年多一点：覆盖「每年 2 月 29 日」以外的一切；再往后还对不上的表达式，对一个会话来说就是永不。 */
const DEFAULT_HORIZON_MS = 400 * 24 * 60 * 60_000;

/**
 * `after` 之后（不含）第一个对得上的整分钟，没有就是 null。`until` 是找到哪里为止（含），默认一年多。
 *
 * 用毫秒数往前走、拿本地时间的读数去比，而不是去 `setHours`：夏令时回拨那一小时本地时间出现两次，
 * 本地时间的 setter 会落到较早的那一次，倒退回 `after` 之前。日子或小时对不上时整段跳过，
 * 不是一分钟一分钟地数。
 */
export function nextCronTime(schedule: CronSchedule, after: number, until = after + DEFAULT_HORIZON_MS): number | null {
	let at = Math.floor(after / 60_000) * 60_000 + 60_000;
	while (at <= until) {
		const date = new Date(at);
		if (!schedule.month.has(date.getMonth() + 1) || !dayMatches(schedule, date)) {
			// 下一个本地零点。零点本身不存在（个别时区在零点拨表）时 Date 会往后挪，仍然在前进。
			at = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
			continue;
		}
		if (!schedule.hour.has(date.getHours())) {
			at += (60 - date.getMinutes()) * 60_000;
			continue;
		}
		if (schedule.minute.has(date.getMinutes())) return at;
		at += 60_000;
	}
	return null;
}
