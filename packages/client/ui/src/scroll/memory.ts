/**
 * 读的人读到了哪里，和读的是什么分开存。
 *
 * 阅读位置要是和转录缓存放在一起，就没用了：你在别处时一个会话说了新东西，它缓存的转录会被丢掉
 * ——这是对的，事件里的信息不够重建它——阅读位置也跟着一起没了。而还在后台跑的那个会话，恰恰是
 * 你最想回到原处的那一个。
 *
 * 所以单独一份存储，按界面分键，只放错了也不要紧的东西。这里每个字段缺了都能退回一个合理的默认值，
 * 这也是它可以是一个模块级的普通 Map、而不是应用状态一部分的原因——别处不用读它，它变了不用重新
 * 渲染，全丢了也只是多滚一次到底。
 */

import type { Marker } from "./follow.ts";

export interface FollowSnapshot {
	/** 意图，比位置优先：跟随的意思是「带我到末尾」，不管末尾现在在哪。 */
	following: boolean;
	/** 只在不跟随时有意义。 */
	scrollTop: number;
	/** 转录已经看过多少，未读数离开再回来也还在。 */
	seen: Marker | null;
}

/**
 * 记住多少个界面。
 *
 * 够在一个项目里来回走一下午。每条只有四个数；这个上限是为了长时间用下来不无限增长，不是为了省内存。
 *
 * 也是为什么**没有**一个「会话删掉了就把它的位置忘掉」的函数：不调用它的代价，是一条已经不存在的
 * 会话占着 64 个槽位里的一个，直到被这里淘汰掉，也就是几乎没有代价。想加的人先读这一段：那件事
 * 这个上限已经做了，多一个调用点只多一处会忘记跟着改的地方。
 */
const LIMIT = 64;

const stores = new Map<string, Map<string, FollowSnapshot>>();

/**
 * 某一**类**界面的那张表。
 *
 * 分命名空间，是因为一个会话 id 同时标识对话和挂在它上面的侧聊，两者各滚各的。委派在自己的命名
 * 空间里用 `${sessionId}:${agentId}` 作键，也是这个原因。
 */
function storeFor(namespace: string): Map<string, FollowSnapshot> {
	let store = stores.get(namespace);
	if (!store) {
		store = new Map();
		stores.set(namespace, store);
	}
	return store;
}

export function readFollow(namespace: string, id: string): FollowSnapshot | undefined {
	return storeFor(namespace).get(id);
}

export function writeFollow(namespace: string, id: string, snapshot: FollowSnapshot): void {
	const store = storeFor(namespace);
	// 删了再插，遍历顺序才是新近顺序，下面的淘汰靠的就是这个。
	store.delete(id);
	store.set(id, snapshot);
	if (store.size > LIMIT) {
		const oldest = store.keys().next();
		if (!oldest.done) store.delete(oldest.value);
	}
}
