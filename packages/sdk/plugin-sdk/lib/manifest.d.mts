// manifest.mjs 的类型。说明的形状定义在 @plume/contract，这里引 typecheck 生成到 dist/ 的那份声明：发到 npm 的包里没有 @plume/contract。
import type { PluginManifest } from "../dist/contract/src/index.d.ts";

export declare const DIR_NAME: RegExp;
export declare const PLUGIN_ENTRY: string;
export declare const SHIPPED: readonly string[];
export declare function readManifest(raw: unknown): PluginManifest;
export declare function readCatalogInfo(raw: unknown): (PluginManifest & { name: string }) | null;
export declare function manifestProblems(raw: unknown): string[];
