import { useState } from "react";
import { translate } from "../i18n/translate.ts";
import { acceleratorLabel, composingKey, recordAccelerator } from "../keyboard.ts";

/**
 * 录一组快捷键：点一下进入录制，按下的那组键就是值（Electron accelerator 的写法）。Esc 放弃，⌫ / Delete 清空。
 */
export function ShortcutRecorder({ value, onChange, placeholder }: { value?: string; onChange: (shortcut: string) => void; placeholder?: string }) {
	const [recording, setRecording] = useState(false);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (!recording) return;
		if (composingKey(e.nativeEvent)) return;
		e.preventDefault();
		e.stopPropagation();

		if (e.key === "Escape") {
			setRecording(false);
			return;
		}

		if (e.key === "Backspace" || e.key === "Delete") {
			onChange("");
			setRecording(false);
			return;
		}

		const result = recordAccelerator(e.nativeEvent);
		if (!result) return;
		onChange(result);
		setRecording(false);
	};

	return (
		<button
			type="button"
			/*
			 * 框里的字是现在绑的那组键，不是这个控件叫什么。「⌥ A」对读屏来说是两个符号，听不出这是一个能改的快捷键，名字另外给。
			 */
			aria-label={translate("shortcut.press")}
			onClick={() => setRecording(true)}
			onBlur={() => setRecording(false)}
			onKeyDown={handleKeyDown}
			className={`plume-field min-w-[140px] justify-center gap-1.5 font-mono ${recording ? "bg-accent/10 text-accent" : value ? "" : "text-ink-muted"}`}
		>
			<span>{recording ? translate("shortcut.pressHint") : value ? acceleratorLabel(value) : (placeholder ?? translate("shortcut.press"))}</span>
		</button>
	);
}
