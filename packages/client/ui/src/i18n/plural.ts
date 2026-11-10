/**
 * Which form of a sentence a number takes, in the language the sentence is being said in.
 *
 * A catalogue entry used to be one string with the count pasted in, so the archive said
 * "1 conversations". English wants two forms and Chinese wants none; `Intl.PluralRules` knows which
 * CLDR category a number falls in, so a catalogue only gives one sentence per category its language
 * uses — see `PluralForms` next to `MessageCatalog`.
 *
 * The count is always the variable `{n}`. That keeps "which number decides" out of the catalogue: a
 * sentence with two counts in it takes its form from the one called `n`.
 */

import type { PluralForms, ResolvedUiLocale } from "./messages/index.ts";

const rules = new Map<ResolvedUiLocale, Intl.PluralRules>();

/** The plural category `count` falls in for `locale`; `other` for anything that is not a finite number. */
export function pluralCategory(locale: ResolvedUiLocale, count: number): Intl.LDMLPluralRule {
	if (!Number.isFinite(count)) return "other";
	let rule = rules.get(locale);
	if (!rule) {
		rule = new Intl.PluralRules(locale);
		rules.set(locale, rule);
	}
	return rule.select(count);
}

/** The sentence `message` says for the count `n`. A plain string is the same sentence for every number. */
export function pluralForm(locale: ResolvedUiLocale, message: string | PluralForms, n: unknown): string {
	if (typeof message === "string") return message;
	return message[pluralCategory(locale, countOf(n))] ?? message.other;
}

/**
 * `n` as a number. Some callers format the count first (`toLocaleString()`, a compact "1.2K"); bare
 * digits still count, anything else takes `other` — right in English, whose `one` is only 1.
 */
function countOf(n: unknown): number {
	if (typeof n === "number") return n;
	if (typeof n === "string" && /^-?\d+(?:\.\d+)?$/.test(n)) return Number(n);
	return Number.NaN;
}
