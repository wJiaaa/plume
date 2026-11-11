import type { Locale } from "@plume/contract";

const zhCN = {
	reverted: "已撤销改动",
	revertFileConfirm: "撤销这个文件的改动？",
	revertAllConfirm: "撤销这次文件改动？",
	revertDetail: "仅撤销已记录的改动；后续修改会保留。",
	revertChanges: "撤销改动",
	fileChanges: "文件变更",
	revertThis: "撤销这次文件改动",
	reviewAll: "审核全部文件改动",
	collapse: "收起文件",
	showMore: "再显示 {n} 个文件",
	showMoreOne: "再显示 {n} 个文件",
	previewChanges: "文件变更预览",
	revertOne: "撤销此文件的改动",
	cannotRevert: "无法自动撤销，请核对后续修改",
	editedN: "已编辑 {n} 个文件",
	editedOne: "已编辑 {n} 个文件",
	revert: "撤销",
	review: "审核",
};

export const MESSAGES: Record<Locale, typeof zhCN> = {
	"zh-CN": zhCN,
	en: {
		reverted: "Changes reverted",
		revertFileConfirm: "Revert this file's changes?",
		revertAllConfirm: "Revert these file changes?",
		revertDetail: "Only the recorded changes go back; anything you did afterwards stays.",
		revertChanges: "Revert the changes",
		fileChanges: "File changes",
		revertThis: "Revert these file changes",
		reviewAll: "Review every file change",
		collapse: "Fold the files away",
		showMore: "Show {n} more files",
		showMoreOne: "Show {n} more file",
		previewChanges: "File change preview",
		revertOne: "Revert this file",
		cannotRevert: "Cannot revert automatically — check what changed since",
		editedN: "{n} files edited",
		editedOne: "{n} file edited",
		revert: "Revert",
		review: "Review",
	},
};

export function fill(template: string, values: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
