import { Bug, FlaskConical, Hammer, ListChecks, Play, Wrench } from "@plume/ui/icons";
import type { ScriptIconId } from "./types.ts";

export function ScriptIcon({ icon, size = 14 }: { icon: ScriptIconId; size?: number }) {
	switch (icon) {
		case "test":
			return <FlaskConical size={size} strokeWidth={1.8} aria-hidden />;
		case "lint":
			return <ListChecks size={size} strokeWidth={1.8} aria-hidden />;
		case "configure":
			return <Wrench size={size} strokeWidth={1.8} aria-hidden />;
		case "build":
			return <Hammer size={size} strokeWidth={1.8} aria-hidden />;
		case "debug":
			return <Bug size={size} strokeWidth={1.8} aria-hidden />;
		default:
			return <Play size={size} strokeWidth={1.8} aria-hidden />;
	}
}
