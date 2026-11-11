/**
 * 把构建好的插件装进本机的 Plume：复制 package.json、README.md、images/、icon.png、dist/、随包的 skills/、.mcp.json 和 LICENSE 到 `~/.plume/local-plugins/<目录名>/`，
 * 和 Plume 里「从本地上传」的放在同一个地方：不跟市场更新，和市场装的同名时这一份生效。Plume 监视这个目录，开着的话当场加载（已经装过的就换成新的）。
 *
 * 先复制进旁边的暂存目录再整个换上去：Plume 看到的要么是旧的一份，要么是新的一份，不会是复制到一半的。
 *
 * 换的时候先把旧目录挪开、再把新目录挪进来，最后才删旧的；不先 `rm -r`：Windows 上旧版本里还有开着的文件
 * （插件起的 `.exe`、编辑器打开着的文件）时删不掉，`rm -r` 会把它周围的删光、卡在它上面，留下一个删了一半的插件。
 * 挪开整个目录在这时是整个被拒的，什么都不动，旧的那份照常能用。和应用里市场的装法（apps/desktop 的 plugin-swap.ts）一样。
 */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DIR_NAME, PLUGIN_ENTRY, SHIPPED } from "./manifest.mjs";

/**
 * @param {string} source 插件目录
 * @param {string} [root] 装到哪个目录下，缺省 Plume 数据目录（`PLUME_HOME`，没设是 ~/.plume）下的 local-plugins
 * @returns {string} 装到的目录
 */
export function installPlugin(source, root = join(process.env.PLUME_HOME || join(homedir(), ".plume"), "local-plugins")) {
	const dir = resolve(source);
	const key = basename(dir);
	if (!DIR_NAME.test(key)) throw new Error(`目录名 ${key} 不行：只能用小写字母、数字和连字符`);
	if (!existsSync(join(dir, PLUGIN_ENTRY))) throw new Error(`没有 ${PLUGIN_ENTRY}，先构建`);
	const target = join(root, key);
	// 暂存目录不在 root 里面：Plume 只认 root 下一层的目录，暂存的不会被当成插件。
	const staging = join(root, "..", ".plugins-staging", key);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	for (const name of SHIPPED) {
		if (existsSync(join(dir, name))) cpSync(join(dir, name), join(staging, name), { recursive: true });
	}
	mkdirSync(root, { recursive: true });
	const retired = join(root, "..", ".plugins-retired", `${Date.now()}-${randomUUID().slice(0, 8)}-${key}`);
	if (existsSync(target)) {
		mkdirSync(dirname(retired), { recursive: true });
		try {
			renameWithRetry(target, retired);
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			throw busy(error);
		}
	}
	try {
		renameWithRetry(staging, target);
	} catch (error) {
		if (existsSync(retired)) renameSync(retired, target);
		rmSync(staging, { recursive: true, force: true });
		throw busy(error);
	}
	// 尽力删：还有文件开着的留在 .plugins-retired 里，Plume 下次换插件时清掉。
	rmSync(retired, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	return target;
}

/** Windows 上别的进程开着文件（或目录里的文件）时改名报的错。 */
const HELD_OPEN = new Set(["EPERM", "EBUSY", "EACCES"]);
const heldOpen = (error) => process.platform === "win32" && HELD_OPEN.has(error?.code);

/** 改名；Windows 上被占用时等一等再试（杀毒软件、索引会去读刚写完的文件），每次多等 50ms，一共 8 次。 */
function renameWithRetry(from, to) {
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			if (attempt >= 8 || !heldOpen(error)) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
		}
	}
}

function busy(error) {
	return heldOpen(error)
		? new Error("插件的文件正被占用（多半是它启动的程序，或打开着它的编辑器），什么都没有改动。关掉占用它的程序后再试。", { cause: error })
		: error;
}
