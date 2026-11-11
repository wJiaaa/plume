/**
 * release 里哪个文件是这台机器能装的。没有 Linux（Plume 不发 Linux 包）。
 *
 * 不引用 electron，能拿真实 release 的文件名直接测：一个 release 有好几个文件，只按扩展名挑，总有哪台机器挑错。
 */

import { CHECKSUM_ASSET } from "./update-checksum.ts";

export interface ReleaseAsset {
	name?: string;
	browser_download_url?: string;
	size?: number;
}

export interface PickedAsset {
	name: string;
	url: string;
	size: number;
}

/** 各家打包工具在文件名里怎么写架构：electron-builder 在 macOS、Windows 上写 `x64`，别处还有 `x86_64`、`amd64`。 */
const ARCH_TAGS: Record<string, string[]> = {
	arm64: ["arm64", "aarch64"],
	x64: ["x64", "x86_64", "amd64"],
};

/**
 * 这台机器能装的那一个，没有就 null（界面改给发布页）。
 *
 * macOS 拿 zip，不拿 dmg：dmg 只能打开、让人自己拖进「应用程序」，是披着自动外衣的手动安装；zip 里直接是 Plume.app，
 * 能解开原地替换。dmg 留在 release 里给第一次手动装的人。Windows 拿安装程序。
 *
 * **每个平台都看架构，对不上宁可什么都不给。** GitHub 按字母序返回文件，`arm64.exe` 排在 `x64.exe` 前面，只按扩展名挑的话
 * 每台 Intel 的 Windows 都会拿到 ARM 的安装程序，下完才失败。文件名里不带架构的当通用的：两个架构合在一起的 NSIS 安装程序就是这样。
 */
export function pickAsset(assets: ReleaseAsset[], platform: string = process.platform, arch: string = process.arch): PickedAsset | null {
	const named = assets.filter((asset): asset is Required<ReleaseAsset> => Boolean(asset.name && asset.browser_download_url && typeof asset.size === "number"));

	const mine = ARCH_TAGS[arch] ?? [];
	const others = Object.entries(ARCH_TAGS)
		.filter(([name]) => name !== arch)
		.flatMap(([, tags]) => tags);

	const forThisMachine = (name: string) => mine.some((tag) => name.includes(tag));
	// 名字里一个架构都没有才算通用：`x86_64` 不能读成「不是 arm64」。
	const universal = (name: string) => !mine.some((tag) => name.includes(tag)) && !others.some((tag) => name.includes(tag));

	const extensions = platform === "darwin" ? [".zip"] : platform === "win32" ? [".exe"] : [];

	for (const extension of extensions) {
		const candidates = named.filter((asset) => asset.name.toLowerCase().endsWith(extension));
		// 先找正好是这个架构的，再找说自己哪都能跑的。
		const match = candidates.find((asset) => forThisMachine(asset.name.toLowerCase())) ?? candidates.find((asset) => universal(asset.name.toLowerCase()));
		if (match) return { name: match.name, url: match.browser_download_url, size: match.size };
	}

	return null;
}

/** release 的校验文件；按确切的名字认，只有一个。 */
export function pickChecksums(assets: ReleaseAsset[]): { url: string } | null {
	const found = assets.find((asset) => asset.name === CHECKSUM_ASSET && asset.browser_download_url);
	return found ? { url: found.browser_download_url as string } : null;
}
