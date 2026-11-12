/**
 * 工作区：替模型读这台机器时本体守的线，和在宿主上安全地读仓库。
 *
 * 本体的一部分，插件换不掉：插件的工具经 `ToolRun.files` 读（`@plume/agent` 的 `run-files.ts` 为每次调用装好），插件经 `ctx.workspace`
 * 列项目文件、经 `ctx.resources` 登记资源地址。这里只认路径、目录、数据目录，不认会话、不认循环。
 *
 * - 读边界（`read-access.ts`）：哪里不问、哪里要问、批准覆盖多大，一条命令写明要读哪些路径。
 * - 资源地址（`resources/`）：`scheme://` 的路由和本体自己的四个 scheme。
 * - 隔离视图下的 git（`host-git.ts`）和项目文件清单（`project-files.ts`）。
 */

export { authorizeCommandReads, type ReadRequest, type ReadScope } from "./read-access.ts";
export { readTarget } from "./read.ts";
export { openRepo, withRepoView } from "./host-git.ts";
export { gitListedFiles } from "./project-files.ts";
export { ArtifactStore, artifactResource, pluginResource, scratchResource, sessionResource } from "./resources/handlers.ts";
export { readOnly, ResourceRouter } from "./resources/router.ts";
