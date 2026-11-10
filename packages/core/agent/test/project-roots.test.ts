import { expect, it } from "vitest";
import { projectRootsFor } from "../src/project-roots.ts";

it("多源目录按项目 id 授权，工作树和相似前缀不会得到原项目权限", () => {
	const projects = [{ id: "p", name: "项目", path: "/work/app", folders: ["/work/app", "/work/lib", "/work/lib"] }];
	expect(projectRootsFor(projects, "/work/app/src", "p")).toEqual(["/work/app", "/work/lib"]);
	expect(projectRootsFor(projects, "/work/lib", "p")).toEqual(["/work/app", "/work/lib"]);
	for (const [cwd, id] of [
		["/work/app-copy", "p"],
		["/worktree/app", "p"],
		["/work/app", "other"],
		["/work/app", undefined],
	])
		expect(projectRootsFor(projects, cwd!, id)).toEqual([]);
});
