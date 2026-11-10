/**
 * 依赖方向（`pnpm arch`，`pnpm check` 的一部分）：packages/README.md「依赖方向」和 spec/safety.md 第 4 条写的那几条，
 * 变成机器查的规则，而不是只靠文档请人遵守。
 *
 * 插件那一侧（插件仓库的 `plugins/*`、`packages/builtin/*` 只引用公开接口）由 `pnpm check:plugins` 查，这里不重复。
 * 市场插件在旁边的插件仓库里，从这里引用它们的路径是 `../plume-plugins/`，下面的规则照样拦。
 *
 * 已有的违规登记在 `.dependency-cruiser-known-violations.json`，照常通过；新加的违规直接失败。基线只能
 * 有意地重新生成（`pnpm arch:baseline`），变小是清理，变大要说得出理由。
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "no-circular",
			comment:
				"值之间的循环会让一个模块在运行时只初始化了一半：其中一个拿到的是 undefined，报错说的是属性而不是循环。" +
				"只有类型的循环不算：编译后就没了，为了它压平类型没有意义。",
			severity: "error",
			from: {},
			to: { circular: true, dependencyTypesNot: ["type-only"] },
		},

		{
			name: "packages-do-not-reach-apps",
			comment: "apps/ 可以依赖 packages/；packages/ 不能依赖 apps/。",
			severity: "error",
			from: { path: "^packages/" },
			to: { path: "^apps/" },
		},

		{
			name: "infra-stands-alone",
			comment: "infra/ 是和产品无关的通用基础设施，换个产品也能用：不依赖其他组和 contract，也不认识插件。",
			severity: "error",
			from: { path: "^packages/infra/" },
			to: { path: "^(packages/(contract|core|client|builtin|sdk)|\\.\\./plume-plugins)/" },
		},

		{
			name: "rpc-runs-in-every-process",
			comment: "infra/rpc 跑在主进程、agent 进程、渲染进程三处：不引用 Node、Electron 的模块和第三方依赖，测试除外。",
			severity: "error",
			from: { path: "^packages/infra/rpc/src/" },
			to: { dependencyTypes: ["core", "npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown"] },
		},

		{
			name: "core-knows-no-plugin",
			comment:
				"循环不认识任何具体插件，插件由应用传给 createAgent：core/ 不依赖 client/、builtin/ 和市场插件。" +
				"core/agent 的端到端测试带上内置插件的源码，只在测试里。",
			severity: "error",
			from: { path: "^packages/core/", pathNot: "^packages/core/[^/]+/test/" },
			to: { path: "^(packages/(client|builtin)|\\.\\./plume-plugins)/" },
		},

		{
			name: "contract-is-types-only",
			comment:
				"contract 只放共享类型，经 import map 和 SDK 给插件：它在别处只拿类型（消息类型来自 core/llm，CallContext 来自 infra/rpc），" +
				"拿一个值就会把那个包拖进每个用它的构建。",
			severity: "error",
			from: { path: "^packages/contract/src/" },
			to: { pathNot: "^packages/contract/src/", dependencyTypesNot: ["type-only"] },
		},

		{
			name: "client-stays-in-the-renderer",
			comment: "client/ 是渲染进程的共享库，产品界面和插件界面入口都用：不引 agent 进程的 core/、内置插件、SDK、桌面端和插件。",
			severity: "error",
			from: { path: "^packages/client/" },
			to: { path: "^(packages/(core|builtin|sdk)|apps|\\.\\./plume-plugins)/" },
		},

		{
			name: "styles-below-ui",
			comment: "依赖方向是 ui → styles：styles 不引 ui。",
			severity: "error",
			from: { path: "^packages/client/styles/" },
			to: { path: "^packages/client/ui/" },
		},

		{
			name: "renderer-does-not-reach-into-main",
			comment: "渲染进程和主进程只经预加载脚本和 RPC 通信；直接引主进程的文件，会把 Electron 和 Node 的模块拖进浏览器的包。",
			severity: "error",
			from: { path: "^apps/desktop/src/renderer/" },
			to: { path: "^apps/desktop/src/(main|preload)/" },
		},

		{
			name: "main-does-not-reach-into-renderer",
			comment: "主进程不引界面的代码；两边都要的放进 shared/。",
			severity: "error",
			from: { path: "^apps/desktop/src/(main|preload)/" },
			to: { path: "^apps/desktop/src/renderer/" },
		},

		{
			name: "shared-belongs-to-neither",
			comment: "shared/ 是主进程、预加载脚本和渲染进程共用的：它引哪一边，另一边就跟着拖进来。",
			severity: "error",
			from: { path: "^apps/desktop/src/shared/" },
			to: { path: "^apps/desktop/src/(main|preload|renderer)/" },
		},

		{
			name: "renderer-takes-only-types-from-agent",
			comment: "渲染进程从 agent 进程的包里拿值，会把 node:fs、node:child_process 打进浏览器的包，窗口一打开就白屏；类型编译后就没了。",
			severity: "error",
			from: { path: "^apps/desktop/src/renderer/" },
			to: { path: "^packages/(core|builtin)/", dependencyTypesNot: ["type-only"] },
		},

		{
			name: "no-orphans",
			comment: "没人引的模块，要么已经死了，要么本该接上却没接。",
			severity: "warn",
			from: {
				orphan: true,
				pathNot: ["\\.d\\.ts$", "(^|/)(index|main|preload|ui)\\.tsx?$", "(^|/)(test|scripts|bin|lib|template)/", "\\.(config|conf)\\.(ts|js|cjs|mjs)$"],
			},
			to: {},
		},
	],

	options: {
		doNotFollow: { path: "node_modules" },
		/*
		 * 用 swc 解析：默认的 tsc 解析要 TypeScript 6 以下的 JS API，仓库用的 TypeScript 7 是原生程序、没有这套 API，
		 * 用 tsc 时 ts/tsx 一个都解析不到，结果却照样全绿。等 dependency-cruiser 支持 TypeScript 7 再换回去。
		 */
		parser: "swc",
		// 分得出 `import type` 和值的 import，上面「只许类型」的几条才写得出来。
		tsPreCompilationDeps: "specify",
		tsConfig: { fileName: "tsconfig.base.json" },
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "require", "default", "types"],
			extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
			mainFields: ["module", "main", "types"],
		},
		exclude: { path: "node_modules|\\.d\\.ts$|/(dist|out|\\.stage|release)/" },
	},
};
