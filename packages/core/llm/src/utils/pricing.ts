import type { ModelConfig, ModelPricing, Usage } from "../types.ts";

export interface SelectedPricingRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Select the long-context tier for this request, then make every token bucket explicitly priced. */
export function selectPricingRates(usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">, pricing: ModelPricing): SelectedPricingRates {
	const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const tier = pricing.tiers
		?.filter((candidate) => contextTokens > candidate.aboveTokens)
		.sort((a, b) => b.aboveTokens - a.aboveTokens)[0];
	const input = tier?.input ?? pricing.input;
	return {
		input,
		output: tier?.output ?? pricing.output,
		cacheRead: tier?.cacheRead ?? pricing.cacheRead ?? input,
		cacheWrite: tier?.cacheWrite ?? pricing.cacheWrite ?? input,
	};
}

export function costAtRates(
	usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">,
	rates: SelectedPricingRates,
) {
	const per = (tokens: number, rate: number) => (tokens * rate) / 1_000_000;
	const input = per(usage.input, rates.input);
	const output = per(usage.output, rates.output);
	const cacheRead = per(usage.cacheRead, rates.cacheRead);
	const cacheWrite = per(usage.cacheWrite, rates.cacheWrite);
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** Fill in the cost breakdown from raw token counts and the model's per-million pricing. */
export function computeCost(usage: Usage, model: ModelConfig): Usage {
	const p = model.pricing;
	if (!p) return usage;
	const rates = selectPricingRates(usage, p);
	const cost = costAtRates(usage, rates);
	return {
		...usage,
		cost: {
			...cost,
			source: p.source ?? "manual",
			rates,
		},
	};
}
