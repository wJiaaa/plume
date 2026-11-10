import assert from "node:assert/strict";
import { test } from "node:test";
import { motionReduced } from "../../../packages/client/ui/src/motion/reduced.ts";

test("减少动效的 on / off 优先于系统，system 和未设置跟随系统，切换后立即生效", (t) => {
	const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
	const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
	t.after(() => {
		if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
		else Reflect.deleteProperty(globalThis, "document");
		if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
		else Reflect.deleteProperty(globalThis, "window");
	});

	const dataset: { reduceMotion?: string } = {};
	let systemReduced = false;
	Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset } } });
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			matchMedia(query: string) {
				assert.equal(query, "(prefers-reduced-motion: reduce)");
				return { matches: systemReduced };
			},
		},
	});

	for (const reduced of [false, true]) {
		systemReduced = reduced;
		for (const setting of [undefined, "system", "on", "off"]) {
			if (setting === undefined) delete dataset.reduceMotion;
			else dataset.reduceMotion = setting;
			assert.equal(motionReduced(), setting === "on" || (setting !== "off" && reduced), `${setting ?? "默认"}，系统减少动效 ${reduced}`);
		}
	}
});
