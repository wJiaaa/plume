import type { ModelConfig, ThinkingLevel, ThinkingOption } from "../types/provider.ts";
import { thinkingDialect } from "./vendors/index.ts";

/** 标准档位，从浅到深。选中的档位模型没有时，按这个顺序就近找。 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const TEXT: Record<string, Pick<ThinkingOption, "label" | "detail">> = {
	off: { label: "关闭", detail: "不推理，直接作答。最快。" },
	minimal: { label: "极简", detail: "只做最低限度的思考。" },
	low: { label: "低", detail: "简单任务够用。" },
	medium: { label: "中", detail: "日常编码的默认档。" },
	high: { label: "高", detail: "复杂重构、疑难排查。" },
	xhigh: { label: "超高", detail: "更深层次的逻辑推演。" },
	max: { label: "最高", detail: "把预算拉满，最慢也最稳。" },
	ultra: { label: "极致", detail: "极致推理模式，算力全开。" },
};

/**
 * 一组标准档位的选项。默认档是 `preferredDefault`（没给就是 medium）在这组里就近落到的那一档。
 *
 * 模型目录（pi 的 `thinkingLevelMap`）和模型编辑器都用它把「支持哪几档」变成模型配置里的
 * `thinkingOptions`。列表里没有 `off`，就表示这个模型关不掉思考。
 */
export function thinkingOptionsFor(levels: readonly ThinkingLevel[], preferredDefault: ThinkingLevel = "medium"): ThinkingOption[] {
	const options: ThinkingOption[] = THINKING_LEVELS.filter((level) => levels.includes(level)).map((id) => ({ id, ...TEXT[id] }));
	const fallback = nearest(options, preferredDefault);
	return options.map((option) => (option === fallback ? { ...option, isDefault: true } : option));
}

/**
 * 没配置档位的模型用这一组：几乎所有推理接口都认的四档。
 *
 * 档位不再按模型名猜。按名字写死的表和厂商的实际能力对不上（给不认 `minimal` 的模型 `minimal`、
 * 给关不掉思考的模型「关闭」），猜错了也不报错。真实档位从模型目录填入，或在模型编辑器里勾选。
 */
export const DEFAULT_THINKING_OPTIONS: ThinkingOption[] = thinkingOptionsFor(["off", "low", "medium", "high"]);

/**
 * 模型可选的档位：配置了就用配置的，否则用默认那一组；不支持思考的模型一档都没有。
 *
 * 关不掉思考的模型（`vendors/` 的 `alwaysOn`）不给「关闭」：适配器对它们什么都不发，选了「关闭」照样思考、
 * 照样计费，界面却显示已关。`catalogFill` 填配置时已经去掉，但没配档位的（默认那一组带 `off`）、在那之前
 * 保存的配置都还带着，所以在这里统一再收一次。这里只有模型名、没有端点，只按模型名的规则判。
 */
export function resolveModelThinkingOptions(model?: ModelConfig | null): ThinkingOption[] {
	if (!model || model.supportsThinking === false) return [];
	const options = model.thinkingOptions ?? DEFAULT_THINKING_OPTIONS;
	if (!thinkingDialect("", model.modelId).alwaysOn) return options;
	const thinking = options.filter((option) => option.id !== "off");
	return thinking.length > 0 ? thinking : options;
}

/**
 * 选中的档位在这个模型上实际是哪一档。
 *
 * 模型没有这一档时就近取：先往深找，再往浅找（和 pi 的 `clampThinkingLevel` 同一个规则）。
 * 换模型后留下的「最高」落到新模型最深的那档，而不是退回默认的「中」；没有「关闭」的模型上
 * 选「关闭」，落到它最浅的那档。只有不在标准序列里的自定义档位名才退回模型的默认档。
 */
export function resolveThinkingOption(level: ThinkingLevel, model?: ModelConfig | null): ThinkingOption | undefined {
	return nearest(resolveModelThinkingOptions(model), level);
}

function nearest(options: ThinkingOption[], level: ThinkingLevel): ThinkingOption | undefined {
	const exact = options.find((option) => option.id === level);
	if (exact) return exact;
	const index = THINKING_LEVELS.indexOf(level);
	if (index !== -1) {
		// 往浅找不落到「关闭」：要的是思考，就近也得是一档思考。都没有时用默认档。
		const shallower = THINKING_LEVELS.slice(0, index).reverse().filter((candidate) => candidate !== "off");
		for (const candidate of [...THINKING_LEVELS.slice(index + 1), ...shallower]) {
			const found = options.find((option) => option.id === candidate);
			if (found) return found;
		}
	}
	return options.find((option) => option.isDefault) ?? options[0];
}

/** 发给接口的推理档位；`undefined` 表示关闭思考。和界面显示的是同一档。 */
export function resolveReasoningEffort(level: ThinkingLevel | undefined, model?: ModelConfig | null): string | undefined {
	if (!level) return undefined;
	const selected = resolveThinkingOption(level, model);
	return selected && selected.id !== "off" ? selected.id : undefined;
}
