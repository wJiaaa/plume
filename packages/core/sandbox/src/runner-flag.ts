/**
 * 标出「这个进程是沙箱 runner」的旗标。
 *
 * 单独一个文件：runner 的入口点名它不必导入后端，后端点名它也不必导入 runner。
 */
export const SANDBOX_RUNNER_FLAG = "--plume-sandbox-runner";
