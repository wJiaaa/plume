/**
 * 从一张单子里选一个：`Select` 填满表单的一行，`InlineSelect` 放在一项设置的末尾或面板的标题行里。
 *
 * 放在基础组件里而不是设置页里：设置以外的地方（任务板、卡片上的调整项、模型画出来的界面卡片）也要用它。
 */

import { Check, ChevronDown } from "../icons/index.ts";
import { MENU_MAX_HEIGHT, MenuBody, MenuItem, Popover, usePopover } from "../overlay/Popover.tsx";

/**
 * 下拉框，用自己的弹层搭，而不是 `<select>`。
 *
 * 原生控件用平台自己的部件画：它的列表由操作系统渲染，所以不理会主题、字号档位和圆角，在 macOS 上
 * 打开时是一块盖住自己触发器的面板。界面里其他给一张选项单的东西都走 `Popover`——模型选择、思考强度、
 * 分支菜单——这个也一样，键盘处理和关闭方式都随它们。
 */
function Dropdown<T extends string>({
	value,
	onChange,
	options,
	size,
	ariaLabel,
	quiet,
	set,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
	/**
	 * `field` 填满表单的一行；`inline` 是放在一项设置末尾的紧凑款；`compact` 是给面板标题行的 26px 款，
	 * 和旁边的 `SearchField` 一样高。
	 */
	size: "field" | "inline" | "compact";
	/** 给自己的文字说不清是什么的下拉——两个并排、分别显示 `09` 和 `30` 的那种。 */
	ariaLabel?: string;
	/** 指到之前没有底——给在列表里一行行重复的控件。 */
	quiet?: boolean;
	/** 安静款里，这是不是有人选过的值，而不是透出来的默认值。 */
	set?: boolean;
}) {
	const menu = usePopover();
	const current = options.find((option) => option.value === value);
	const field = size === "field";
	const compact = size === "compact";

	return (
		<>
			<button
				type="button"
				onClick={menu.toggle}
				aria-label={ariaLabel}
				aria-haspopup="menu"
				aria-expanded={menu.open}
				data-plume-field=""
				data-plume-select=""
				data-set={set ? "" : undefined}
				className={`${quiet ? "plume-field-quiet" : "plume-field"} justify-between ${compact ? "plume-field-compact gap-1.5" : "gap-2"} ${field ? "w-full" : ""}`}
			>
				<span className="flex min-w-0 items-center gap-2">
					{current?.icon}
					<span className="min-w-0 truncate">{current?.label ?? value}</span>
				</span>
				<ChevronDown
					size={field ? 15 : compact ? 12 : 13}
					strokeWidth={1.9}
					className="shrink-0 text-ink-faint transition-transform duration-[var(--plume-t-quick)]"
					style={menu.open ? { transform: "rotate(180deg)" } : undefined}
				/>
			</button>

			{menu.open && (
				<Popover anchor={menu.anchor} onClose={menu.close} placement="bottom" align="end" width="default" maxHeight={MENU_MAX_HEIGHT}>
					{/*
					 * 图标那一列为整张单子留，不是每行各自留。
					 *
					 * 选项只在找得到图标时才带——比如「用什么打开」的下拉从本机读每个应用自己的图标，
					 * 没装的就没有。没图标的行把这一列收掉的话，它们的文字比其他行往左 26px，整张菜单
					 * 读起来像两张不小心叠在一起的单子。
					 */}
					<MenuBody insetIcons={options.some((option) => option.icon)}>
						{options.map((option) => (
							<MenuItem
								key={option.value}
								selected={option.value === value}
								detail={option.detail}
								icon={option.icon}
								trailing={option.value === value ? <Check size={13} strokeWidth={2.2} className={`shrink-0 ${option.detail ? "mt-[3px]" : ""}`} /> : undefined}
								onClick={() => {
									onChange(option.value);
									menu.close();
								}}
							>
								{option.label}
							</MenuItem>
						))}
					</MenuBody>
				</Popover>
			)}
		</>
	);
}

export function Select<T extends string>(props: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
	ariaLabel?: string;
}) {
	return <Dropdown {...props} size="field" />;
}

/** 设置行里用的紧凑行内下拉，像「Zed ˅」那样只有字和箭头。 */
export function InlineSelect<T extends string>(props: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; detail?: string; icon?: React.ReactNode }[];
	ariaLabel?: string;
	quiet?: boolean;
	set?: boolean;
	/** 给面板标题行而不是设置行——见 `Dropdown` 的 `size`。 */
	compact?: boolean;
}) {
	const { compact, ...rest } = props;
	return <Dropdown {...rest} size={compact ? "compact" : "inline"} />;
}
