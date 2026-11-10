import type { OpResult } from "../api.ts";

/**
 * 跑一个 git 操作，说它成没成。
 *
 * 每颗会改仓库的按钮都经过它：之后重读、失败时报出来，都在一处做，不在每个调用点各写一遍。
 */
export type Act = (operation: () => PromiseLike<OpResult>) => Promise<boolean>;
