// color-exempt：xterm 画在 canvas 上，只认字面色值：十六个 ANSI 槽是程序说的「红」「绿」，不能映射成 token；读不到 CSS 变量时的底色、字色兜底同理
/**
 * 终端的配色和字体，从当前主题的 CSS 变量里读：xterm 画在 canvas 上，只认字面的值。
 */

import { withHanFallback } from "@plume/ui";
import type { Terminal } from "@xterm/xterm";

/**
 * 终端的行高：够让下伸部和框线字符接上，不多给。
 *
 * 代码外观里的行高和字距是阅读用的设置，终端不跟：终端是一张格子，机器上每个终端都按 1.2 左右、不加字距来画它，
 * 在里面画框线和进度条的程序也正是照这个设计的。
 */
const TERMINAL_LINE_HEIGHT = 1.2;

/** 终端不加字距：格子的宽度就是字的宽度。 */
const TERMINAL_LETTER_SPACING = 0;

function readVar(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 字体和字号跟代码一样，取当前的 CSS 变量；读不到时用调用方给的兜底。 */
export function typography(defaults: { codeFont: string; codeFontSize: number }) {
	return {
		// 终端读的是字体栈字符串，不是 CSS 变量，所以要同样的中文兜底。
		fontFamily: withHanFallback(readVar("--plume-font-mono") || defaults.codeFont),
		fontSize: Number.parseFloat(readVar("--plume-code-size")) || defaults.codeFontSize,
		lineHeight: TERMINAL_LINE_HEIGHT,
		letterSpacing: TERMINAL_LETTER_SPACING,
	};
}

/**
 * xterm 要字面的颜色，所以底色和字色从当前的 CSS 变量里读出来：代码的底，不是应用外壳的底，终端和旁边的代码
 * 看上去是同一类东西。
 *
 * 十六个 ANSI 槽是写死的而不是推出来的：程序说「红」「绿」指的就是它们，映射成应用的强调色会让
 * `git diff` 在哪些行是新增的这件事上撒谎。
 */
export function paletteFromTheme(): Terminal["options"]["theme"] {
	const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	const background = readVar("--plume-code-bg") || (dark ? "#171717" : "#ffffff");
	const foreground = readVar("--plume-code-fg") || (dark ? "#ededed" : "#1a1c1f");
	return {
		background,
		foreground,
		cursor: foreground,
		cursorAccent: background,
		selectionBackground: dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.12)",
		black: dark ? "#3b3b3b" : "#2c2c2c",
		red: dark ? "#f07171" : "#c8402f",
		green: dark ? "#7fc98a" : "#33803f",
		yellow: dark ? "#e3c07b" : "#9a6a00",
		blue: dark ? "#79b8ff" : "#2b62c6",
		magenta: dark ? "#c39ac9" : "#8a45a5",
		cyan: dark ? "#6fd2c8" : "#0f7d78",
		white: dark ? "#d6d6d6" : "#5f5f5f",
		brightBlack: dark ? "#6b6b6b" : "#8a8a8a",
		brightRed: dark ? "#ff8f8f" : "#d94f3d",
		brightGreen: dark ? "#98e3a3" : "#3d9950",
		brightYellow: dark ? "#f2d69a" : "#b07d0d",
		brightBlue: dark ? "#9ecbff" : "#3a76dd",
		brightMagenta: dark ? "#d6b3db" : "#9d59b8",
		brightCyan: dark ? "#8fe4db" : "#12938d",
		brightWhite: dark ? "#ffffff" : "#2c2c2c",
	};
}
