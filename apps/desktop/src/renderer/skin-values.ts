import type { Skin, SkinBackground } from "@plume/contract/ui";

const MAX_SKIN_BACKGROUND_BYTES = 5 * 1024 * 1024;
const BACKGROUND_EFFECTS = new Set(["none", "dither", "ascii", "halftone", "scanlines", "grid", "haze"]);
const BACKGROUND_FITS = new Set(["cover", "tile"]);

export interface ManagedSkin {
	name: string;
	mode: "system" | "light" | "dark";
	background?: Required<SkinBackground>;
}

function hasSignature(mime: string, bytes: Uint8Array): boolean {
	if (mime === "png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
	if (mime === "jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mime === "gif")
		return bytes.length >= 6 && (new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF87a" || new TextDecoder().decode(bytes.subarray(0, 6)) === "GIF89a");
	return (
		mime === "webp" &&
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	);
}

function backgroundValue(value: unknown): Required<SkinBackground> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid skin background");
	const raw = value as Record<string, unknown>;
	if (typeof raw.image !== "string") throw new Error("Invalid skin background image");
	const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw.image);
	if (!match || match[2]!.length % 4 !== 0 || match[2]!.length > Math.ceil((MAX_SKIN_BACKGROUND_BYTES * 4) / 3) + 4) {
		throw new Error("Invalid skin background image");
	}
	let decoded: string;
	try {
		decoded = atob(match[2]!);
	} catch {
		throw new Error("Invalid skin background image");
	}
	if (decoded.length > MAX_SKIN_BACKGROUND_BYTES) throw new Error("Skin background is too large");
	const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	if (!hasSignature(match[1]!, bytes)) throw new Error("Invalid skin background image");
	const fit = raw.fit ?? "cover";
	const effect = raw.effect ?? "none";
	const opacity = raw.opacity ?? 0.24;
	if (typeof fit !== "string" || !BACKGROUND_FITS.has(fit)) throw new Error("Invalid skin background fit");
	if (typeof effect !== "string" || !BACKGROUND_EFFECTS.has(effect)) throw new Error("Invalid skin background effect");
	if (typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0.05 || opacity > 0.65) throw new Error("Invalid skin background opacity");
	if (raw.onNewChat !== undefined && typeof raw.onNewChat !== "boolean") throw new Error("Invalid skin background placement");
	if (raw.inChat !== undefined && typeof raw.inChat !== "boolean") throw new Error("Invalid skin background placement");
	return {
		image: raw.image,
		fit: fit as Required<SkinBackground>["fit"],
		effect: effect as Required<SkinBackground>["effect"],
		opacity,
		onNewChat: raw.onNewChat ?? true,
		inChat: raw.inChat ?? true,
	};
}

/** 整套校验后才创建样式表，坏数据不能留下半套皮肤。 */
export function skinValues(skin: unknown, hasToken: (token: string) => boolean) {
	if (typeof skin !== "object" || skin === null || Array.isArray(skin)) throw new Error("Skin requires { light, dark }");
	const value = skin as Skin;
	if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80)) throw new Error("Invalid skin name");
	if (value.mode !== undefined && value.mode !== "system" && value.mode !== "light" && value.mode !== "dark") throw new Error("Invalid skin mode");
	const background = backgroundValue(value.background);
	const managed =
		value.name !== undefined && value.mode !== undefined ? { name: value.name.trim(), mode: value.mode, ...(background && { background }) } : undefined;
	if (background && !managed) throw new Error("Skin background requires name and mode");
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
