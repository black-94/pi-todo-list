import { buildReadResult, type ReadResult } from "../domain/view.ts";
import type { DerivedStatus, Snapshot } from "../domain/types.ts";
import type { WritableSnapshot } from "../domain/snapshot.ts";
import type { WriteSummary } from "../domain/write.ts";

function glyph(status: DerivedStatus): string {
	if (status === "completed") return "✓";
	if (status === "in_progress") return "◐";
	return "○";
}

function deps(blockedByNumbers: readonly string[], blockedBy: readonly string[], isBlocked: boolean): string {
	if (blockedBy.length === 0) return "";
	const refs = blockedByNumbers.map((n, i) => `${n}(${blockedBy[i]})`).join(",");
	return ` blockedBy=${refs}${isBlocked ? " blocked" : ""}`;
}

/** Full, ID-bearing tree text. */
export function formatTreeWithIds(read: ReadResult): string[] {
	const lines: string[] = [];
	for (const topic of read.topics) {
		if (topic.leafCount === 1 && topic.items.length === 1) {
			const only = topic.items[0]!;
			const leaf = only.type === "leaf" ? only : only.subtasks[0];
			if (leaf) {
				lines.push(`${glyph(leaf.status)} ${leaf.title} [leaf ${leaf.id}]${deps(leaf.blockedByNumbers, leaf.blockedBy, leaf.isBlocked)}`);
				continue;
			}
		}
		lines.push(`${glyph(topic.status)} ${topic.title} [topic ${topic.id}] (${topic.completedLeafCount}/${topic.leafCount} leaves)`);
		topic.items.forEach((item, itemIndex) => {
			if (item.type === "leaf") {
				lines.push(
					`  ${glyph(item.status)} ${itemIndex + 1} ${item.title} [item-leaf ${item.id}]${deps(item.blockedByNumbers, item.blockedBy, item.isBlocked)}`,
				);
				return;
			}
			lines.push(`  ${glyph(item.status)} ${itemIndex + 1} ${item.title} [container ${item.id}]`);
			item.subtasks.forEach((leaf, subtaskIndex) => {
				lines.push(
					`    ${glyph(leaf.status)} ${itemIndex + 1}.${subtaskIndex + 1} ${leaf.title} [leaf ${leaf.id}]${deps(leaf.blockedByNumbers, leaf.blockedBy, leaf.isBlocked)}`,
				);
			});
		});
	}
	return lines;
}

function writableJson(writable: WritableSnapshot): string {
	return JSON.stringify({ expectedRevision: writable.revision, topics: writable.topics });
}

/** Full, ID-bearing tree text for `todo_read`, plus the canonical re-writable input. */
export function formatReadText(read: ReadResult): string {
	const lines: string[] = [];
	lines.push(
		`revision: ${read.revision || "(none)"} | topics: ${read.counts.topics} (active ${read.activeTopicCount}, completed ${read.completedTopicCount}) | leaves: ${read.counts.completed}/${read.counts.leaves} completed`,
	);
	if (read.counts.leaves === 0) {
		lines.push("(empty todo tree)");
	} else {
		lines.push(...formatTreeWithIds(read));
	}
	if (read.flattened.length > 0) {
		lines.push(`single-leaf flattened topics: ${read.flattened.map((f) => `${f.topicId}->${f.leafId}`).join(", ")}`);
	}
	lines.push("writable (copy into todo_write, adjusting statuses/blockedBy as needed):");
	lines.push(writableJson(read.writable));
	return lines.join("\n");
}

export interface WriteReportInput {
	changed: boolean;
	revision: string;
	snapshot: Snapshot;
	summary: WriteSummary;
}

/** Model-facing text after a successful write: revision, summary, IDs, canonical input. */
export function formatWriteText(report: WriteReportInput): string {
	const read = buildReadResult(report.snapshot);
	const lines: string[] = [];
	if (!report.changed) {
		lines.push(`No change. revision: ${report.revision || "(none)"}`);
	} else {
		const created: string[] = [];
		if (report.summary.createdTopics) created.push(`${report.summary.createdTopics} topic(s)`);
		if (report.summary.createdContainers) created.push(`${report.summary.createdContainers} container(s)`);
		if (report.summary.createdLeaves) created.push(`${report.summary.createdLeaves} leaf/leaves`);
		const bits: string[] = [];
		if (created.length) bits.push(`created ${created.join(", ")}`);
		if (report.summary.completedLeaves) bits.push(`completed ${report.summary.completedLeaves} leaf/leaves`);
		if (report.summary.completedTopics.length) {
			bits.push(`completed topic(s) kept and folded: ${report.summary.completedTopics.join(", ")}`);
		}
		if (report.summary.evictedTopics.length) {
			bits.push(`evicted completed topic(s) to make room for new topics: ${report.summary.evictedTopics.join(", ")}`);
		}
		if (report.summary.cancelled.length) bits.push(`cancelled: ${report.summary.cancelled.join("; ")}`);
		lines.push(`Updated. revision: ${report.revision}`);
		if (bits.length) lines.push(bits.join("; "));
	}
	lines.push(
		`topics: ${read.counts.topics} (active ${read.activeTopicCount}, completed ${read.completedTopicCount}) | leaves: ${read.counts.completed}/${read.counts.leaves} completed | in progress: ${read.counts.inProgress}`,
	);
	if (read.counts.leaves > 0) lines.push(...formatTreeWithIds(read));
	lines.push("writable (copy into the next todo_write):");
	lines.push(writableJson(read.writable));
	return lines.join("\n");
}
