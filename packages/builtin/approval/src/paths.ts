/**
 * 判断「在不在里面」的两个小工具。
 *
 * 问 `node:path`，不手拼分隔符：顺手的写法是 `target.startsWith(root + "/")`，而 `/a/project-backup` 和 `/a/project`
 * 就差在这一个分隔符上。往外走只认单独的 `..` 或 `..` 加分隔符，不认前缀：`..cache` 是根下面一个名字恰好以两个点开头的目录。
 * 相对路径不在任何东西里面：这个问题只在两个都钉死了的位置之间才有意义。
 */

import { isAbsolute, relative, sep } from "node:path";

/** 从 `root` 往下走到 `target` 的相对路径；`root` 自己是 `""`，不在里面时是 null。 */
function relativeInside(root: string, target: string): string | null {
	if (!isAbsolute(root) || !isAbsolute(target)) return null;
	const step = relative(root, target);
	if (step === ".." || step.startsWith(`..${sep}`) || isAbsolute(step)) return null;
	return step;
}

/** `target` 在 `root` 下面；`root` 自己不算在它自己里面。 */
export const within = (root: string, target: string): boolean => Boolean(relativeInside(root, target));

/** 同 `within`，但 `root` 自己也算：问的是「能不能写这里」，不是「是不是在下面」。 */
export const withinOrIs = (root: string, target: string): boolean => relativeInside(root, target) !== null;
