import { translate, Input } from "@plume/ui";

import { useEffect, useRef, useState } from "react";

import { splitExtension } from "./paths.ts";

export function NameEditor({
	initial,
	selectStem = true,
	onCommit,
	onCancel,
}: {
	initial: string;

	selectStem?: boolean;

	onCommit: (name: string) => void;
	onCancel: () => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(initial);

	const done = useRef(false);

	useEffect(() => {
		const element = input.current;
		if (!element) return;
		element.focus();
		const [stem] = splitExtension(initial);
		element.setSelectionRange(0, selectStem ? stem.length : initial.length);
	}, [initial, selectStem]);
	const problem = value === initial ? null : nameProblem(value);

	const commit = () => {
		if (done.current) return;
		if (problem || value.trim() === "") return cancel();
		done.current = true;
		onCommit(value.trim());
	};

	const cancel = () => {
		if (done.current) return;
		done.current = true;
		onCancel();
	};

	return (
		<Input
			ref={input}
			value={value}
			spellCheck={false}
			data-plume-tip={problem ?? undefined}
			aria-label={translate("nameEditor.name")}
			aria-invalid={problem ? true : undefined}
			onChange={(event) => setValue(event.target.value)}

			onBlur={() => {
				if (document.hasFocus()) commit();
			}}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Enter") {
					event.preventDefault();
					commit();
				} else if (event.key === "Escape") {
					event.preventDefault();
					cancel();
				}
			}}
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={(event) => event.stopPropagation()}
			className={`plume-name-input min-w-0 flex-1 rounded-sm border bg-input px-1 py-px text-detail text-ink outline-none ${
				problem ? "border-danger" : "border-accent"
			}`}
		/>
	);
}

function nameProblem(name: string): string | null {
	if (name.trim() === "") return translate("path.emptyName");
	if (name === "." || name === "..") return translate("path.dotName");
	if (name.includes("/") || name.includes("\\")) return translate("path.slashInName");
	if (name !== name.trim()) return translate("path.spaceAround");
	return null;
}
