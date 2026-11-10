import type { Skin } from "@plume/contract/ui";

/** 整套校验后才创建样式表，坏数据不能留下半套皮肤。 */
export function skinValues(skin: unknown, hasToken: (token: string) => boolean) {
	if (typeof skin !== "object" || skin === null || Array.isArray(skin)) throw new Error("Skin requires { light, dark }");
	const value = skin as Skin;
	if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80)) throw new Error("Invalid skin name");
	if (value.mode !== undefined && value.mode !== "system" && value.mode !== "light" && value.mode !== "dark") throw new Error("Invalid skin mode");
	const managed = value.name !== undefined && value.mode !== undefined ? { name: value.name.trim(), mode: value.mode } : undefined;
	const schemes: Array<[scheme: "light" | "dark", tokens: Array<[string, string]>]> = [];
	for (const scheme of ["light", "dark"] as const) {
		const tokens = value[scheme];
		if (tokens === undefined) continue;
		if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) throw new Error(`Invalid ${scheme} skin tokens`);
		const entries = Object.entries(tokens);
		for (const [token, entry] of entries) {
			if (!hasToken(token)) throw new Error(`Unknown skin token ${token}`);
			if (typeof entry !== "string" || !entry.trim()) throw new Error(`Invalid skin token ${token}`);
		}
		schemes.push([scheme, entries]);
	}
	return { managed, schemes };
}
