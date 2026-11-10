import assert from "node:assert/strict";
import { test } from "node:test";
import { treeRows } from "../src/renderer/files/useFileTree.ts";
import { DRAGGED_PATHS, droppedPaths, isDescendantPath, joinPath, parentOf, relativeTo, splitExtension } from "../src/renderer/files/paths.ts";
import { connectFiles, findFile, openFileIn, fileOf, isFolder, moveFiles, removeFiles, setFileRemovedHandler } from "../src/renderer/files/open-file.ts";
import type { AgentService } from "@plume/contract";
import type { Remote } from "@plume/rpc";

const directory = (path: string) => ({ path, name: path.split("/").at(-1)!, isDirectory: true });
const file = (path: string) => ({ ...directory(path), isDirectory: false });
const children = {
	"/a": [directory("/a/src"), file("/a/README.md")],
	"/a/src": [file("/a/src/index.ts")],
	"/b": [file("/b/other.ts")],
};

test("多目录有根行，单目录直接列内容；筛选保留命中祖先", () => {
	assert.deepEqual(
		treeRows({ roots: ["/a"], children, expanded: new Set(), filter: "", scope: null }).map(({ entry, depth }) => [entry.path, depth]),
		[
			["/a/src", 0],
			["/a/README.md", 0],
		],
	);
	assert.deepEqual(
		treeRows({ roots: ["/a", "/b"], children, expanded: new Set(["/a"]), filter: "", scope: null }).map(({ entry, depth }) => [entry.path, depth]),
		[
			["/a", 0],
			["/a/src", 1],
			["/a/README.md", 1],
			["/b", 0],
		],
	);
	assert.deepEqual(
		treeRows({ roots: ["/a", "/b"], children, expanded: new Set(), filter: "index", scope: null }).map(({ entry }) => entry.path),
		["/a", "/a/src", "/a/src/index.ts"],
	);
	assert.deepEqual(
		treeRows({ roots: ["/a", "/b"], children, expanded: new Set(), filter: "", scope: "/a/src" }).map(({ entry, depth }) => [entry.path, depth]),
		[["/a/src/index.ts", 0]],
	);
});

test("路径边界和快捷操作认 Windows 分隔符，点文件不丢名称", () => {
	assert.equal(isDescendantPath("/a/b", "/a/bc"), false);
	assert.equal(isDescendantPath("C:\\App", "c:/app/src/file.ts"), true);
	assert.equal(relativeTo("C:\\App", "c:/app/src/file.ts"), "src\\file.ts");
	assert.equal(joinPath("C:\\App", "file.ts"), "C:\\App\\file.ts");
	assert.equal(parentOf("/a"), "/");
	assert.equal(parentOf("C:\\a"), "C:\\");
	assert.deepEqual(splitExtension(".gitignore"), [".gitignore", ""]);
});

test("打开文件随目录改名移动，删除只关闭受影响的标签", async () => {
	connectFiles({ readFile: async () => ({ text: "content", bytes: 7, truncated: false }) } as unknown as Remote<AgentService>);
	await openFileIn("inside", "session", "/project/src/index.ts");
	await openFileIn("outside", "session", "/project/src-other.ts");
	moveFiles("/project/src", "/project/lib");
	assert.equal(fileOf("inside").path, "/project/lib/index.ts");
	let removed: string[] = [];
	setFileRemovedHandler((paths) => {
		removed = paths;
	});
	removeFiles(["/project/lib"]);
	assert.deepEqual(removed, ["/project/lib"]);
	assert.equal(fileOf("inside").path, null);
	assert.equal(fileOf("outside").path, "/project/src-other.ts");
});

test("读不成文件的路径是不是文件夹，由 agent 按会话边界回答", async () => {
	connectFiles({
		readFile: async () => null,
		listDirectory: async (_sessionId: string, path: string) => {
			if (path === "/project/plugins/") return [file("/project/plugins/index.ts")];
			throw new Error("not a directory");
		},
	} as unknown as Remote<AgentService>);
	assert.equal(await isFolder("session", "/project/plugins/"), true);
	assert.equal(await isFolder("session", "/project/README.md"), false);
});

test("终端印的路径：绝对路径按会话边界认，相对路径只认唯一的文件", async () => {
	connectFiles({
		listDirectory: async (_sessionId: string, path: string) => {
			if (path === "/project/src") return [directory("/project/src/lib"), file("/project/src/a.ts")];
			throw new Error("outside");
		},
		locateFiles: async (_sessionId: string, relative: string) =>
			({ "a.ts": ["/project/src/a.ts"], "b.ts": ["/project/x/b.ts", "/project/y/b.ts"], lib: ["/project/src/lib/"] })[relative] ?? [],
	} as unknown as Remote<AgentService>);
	assert.equal(await findFile("session", "/project/src/a.ts"), "/project/src/a.ts");
	assert.equal(await findFile("session", "/project/src/lib"), null);
	assert.equal(await findFile("session", "/etc/passwd"), null);
	assert.equal(await findFile("session", "a.ts"), "/project/src/a.ts");
	assert.equal(await findFile("session", "b.ts"), null);
	assert.equal(await findFile("session", "lib"), null);
});

test("拖放带的路径：文件树的行先读，访达的文件现问，纯文字不算", () => {
	const transfer = (types: string[], data: Record<string, string> = {}, files: { name: string }[] = []) =>
		({ types, getData: (type: string) => data[type] ?? "", files }) as unknown as DataTransfer;
	const pathFor = (file: File) => `/Users/me/${file.name}`;
	assert.deepEqual(droppedPaths(transfer([DRAGGED_PATHS, "text/plain"], { [DRAGGED_PATHS]: JSON.stringify(["/p/a.ts", "/p/dir"]) }), pathFor), [
		"/p/a.ts",
		"/p/dir",
	]);
	assert.deepEqual(droppedPaths(transfer(["Files"], {}, [{ name: "a.txt" }, { name: "b c.txt" }]), pathFor), ["/Users/me/a.txt", "/Users/me/b c.txt"]);
	assert.deepEqual(droppedPaths(transfer([DRAGGED_PATHS]), pathFor), [], "dragover 时读不到内容");
	assert.equal(droppedPaths(transfer(["text/plain"]), pathFor), null);
});
