import type { LeafView, ReadResult, TopicView } from "../domain/view.ts";
import type { DerivedStatus } from "../domain/types.ts";

/** Minimal theme surface used by rendering, so tests can pass a plain stub. */
export interface RenderTheme {
	fg(token: string, text: string): string;
}

export interface RenderOptions {
	width: number;
	expanded: boolean;
	/** Body rows allowed in compact mode (excludes heading). */
	maxRows: number;
	theme: RenderTheme;
	truncate: (line: string, width: number, ellipsis?: string) => string;
}

const ICON: Record<DerivedStatus, string> = { pending: "○", in_progress: "◐", completed: "✓" };
const STATUS_COLOR: Record<DerivedStatus, string> = { pending: "text", in_progress: "accent", completed: "success" };

function icon(status: DerivedStatus, theme: RenderTheme): string {
	return theme.fg(STATUS_COLOR[status], ICON[status]);
}

function titleColor(status: DerivedStatus): string {
	return status === "completed" ? "dim" : "text";
}

function dependencyMarker(blockedByNumbers: readonly string[], isBlocked: boolean, theme: RenderTheme): string {
	if (blockedByNumbers.length === 0) return "";
	return ` ${theme.fg(isBlocked ? "warning" : "dim", `⛓ ${blockedByNumbers.join(",")}`)}`;
}

function connector(prefix: string, isLast: boolean, theme: RenderTheme): string {
	return theme.fg("dim", `${prefix}${isLast ? "└─" : "├─"}`);
}

function leafBody(leaf: LeafView, number: string | null, theme: RenderTheme): string {
	const numberPart = number === null ? "" : `${theme.fg("accent", number)} `;
	return `${icon(leaf.status, theme)} ${numberPart}${theme.fg(titleColor(leaf.status), leaf.title)}${dependencyMarker(leaf.blockedByNumbers, leaf.isBlocked, theme)}`;
}

interface TopicBlock {
	overview: string;
	descendants: string[];
}

function buildTopicBlock(topic: TopicView, topicIsLast: boolean, theme: RenderTheme): TopicBlock {
	const singleItem = topic.items[0];
	if (topic.leafCount === 1 && topic.items.length === 1 && singleItem) {
		const leaf = singleItem.type === "leaf" ? singleItem : singleItem.subtasks[0];
		if (leaf) return { overview: `${connector("", topicIsLast, theme)} ${leafBody(leaf, null, theme)}`, descendants: [] };
	}

	const overview = `${connector("", topicIsLast, theme)} ${icon(topic.status, theme)} ${theme.fg("muted", topic.title)}`;
	// A completed topic is folded to one summary row. Its descendants stay in the
	// read data but are never rendered, even when the panel or tools are expanded.
	if (topic.completed) return { overview, descendants: [] };
	const childPrefix = topicIsLast ? "   " : "│  ";
	const descendants: string[] = [];
	topic.items.forEach((item, itemIndex) => {
		const itemIsLast = itemIndex === topic.items.length - 1;
		if (item.type === "leaf") {
			descendants.push(`${connector(childPrefix, itemIsLast, theme)} ${leafBody(item, `${itemIndex + 1}`, theme)}`);
			return;
		}
		descendants.push(
			`${connector(childPrefix, itemIsLast, theme)} ${icon(item.status, theme)} ${theme.fg("accent", `${itemIndex + 1}`)} ${theme.fg(titleColor(item.status), item.title)}`,
		);
		const leafPrefix = childPrefix + (itemIsLast ? "   " : "│  ");
		item.subtasks.forEach((leaf, subtaskIndex) => {
			const leafIsLast = subtaskIndex === item.subtasks.length - 1;
			descendants.push(`${connector(leafPrefix, leafIsLast, theme)} ${leafBody(leaf, `${itemIndex + 1}.${subtaskIndex + 1}`, theme)}`);
		});
	});
	return { overview, descendants };
}

function heading(read: ReadResult, theme: RenderTheme): string {
	// The glyph/color still reflect activity (any unfinished leaf), but the
	// count is completed/total, not unfinished/total.
	const unfinished = read.counts.pending + read.counts.inProgress;
	const active = unfinished > 0;
	const color = active ? "accent" : "dim";
	return `${theme.fg(color, active ? "●" : "○")} ${theme.fg(color, `TODOS (${read.counts.completed}/${read.counts.leaves})`)}`;
}

/**
 * Render the widget (heading plus rows). Pure: takes a read result and a
 * theme-like object, returns lines already truncated to `width`.
 *
 * Compact mode keeps every topic's overview visible and gives each topic an
 * equal share of the remaining rows, so one large topic cannot hide the others.
 * Numbers are never recomputed for the subset, so they stay correct; overflow
 * is reported per topic.
 */
export function renderTodoLines(read: ReadResult, options: RenderOptions): string[] {
	const { theme, truncate, width } = options;
	if (read.counts.leaves === 0) return [];

	const blocks = read.topics.map((topic, index) => buildTopicBlock(topic, index === read.topics.length - 1, theme));
	const lines: string[] = [truncate(heading(read, theme), width, "…")];

	if (options.expanded) {
		for (const block of blocks) {
			lines.push(block.overview);
			lines.push(...block.descendants);
		}
	} else {
		const count = blocks.length;
		const perTopic = count > 0 ? Math.max(0, Math.floor((options.maxRows - 2 * count) / count)) : 0;
		for (const block of blocks) {
			lines.push(block.overview);
			const shown = block.descendants.slice(0, perTopic);
			lines.push(...shown);
			const hidden = block.descendants.length - shown.length;
			if (hidden > 0) lines.push(`${theme.fg("dim", "   └─")} ${theme.fg("dim", `+${hidden} more`)}`);
		}
	}

	for (let i = 1; i < lines.length; i++) lines[i] = truncate(lines[i]!, width, "…");
	lines.push("");
	return lines;
}
