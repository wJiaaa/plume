import { useRef, type ComponentPropsWithRef, type DOMAttributes, type KeyboardEvent } from "react";
import { composingKey, markComposition } from "../keyboard.ts";

/** 组字交给原生编辑器，包括在候选词里移动。 */
function useComposition<T extends HTMLElement>(props: DOMAttributes<T>) {
	const composing = useRef(false);
	const guard = (handler?: (event: KeyboardEvent<T>) => void) => (event: KeyboardEvent<T>) => {
		if (composing.current || composingKey(event.nativeEvent)) {
			// 不 preventDefault：输入法还要用 Enter、方向键、空格和 Esc。
			event.stopPropagation();
			return;
		}
		handler?.(event);
	};
	return {
		onCompositionStart: (event: React.CompositionEvent<T>) => {
			composing.current = true;
			markComposition(event.currentTarget, true);
			props.onCompositionStart?.(event);
		},
		onCompositionEnd: (event: React.CompositionEvent<T>) => {
			composing.current = false;
			markComposition(event.currentTarget, false);
			props.onCompositionEnd?.(event);
		},
		onBlur: (event: React.FocusEvent<T>) => {
			composing.current = false;
			markComposition(event.currentTarget, false);
			props.onBlur?.(event);
		},
		onKeyDown: guard(props.onKeyDown),
		onKeyUp: guard(props.onKeyUp),
		onKeyDownCapture: guard(props.onKeyDownCapture),
		onKeyUpCapture: guard(props.onKeyUpCapture),
	};
}

/** 不带样式的原生控件：布局、ref、选区和撤销历史都留在调用方手里。 */
export function Input(props: ComponentPropsWithRef<"input">) {
	const handlers = useComposition(props);
	return <input {...props} {...handlers} />;
}

/** 同 `Input`，多行。要带框、滚动条和渐隐的多行框用 `TextArea`。 */
export function Textarea(props: ComponentPropsWithRef<"textarea">) {
	const handlers = useComposition(props);
	return <textarea {...props} {...handlers} />;
}
