/**
 * Grapheme-aware text limits.
 *
 * Titles are limited by Unicode grapheme cluster count, so an emoji or a
 * combining sequence counts as one. We never silently truncate a stored title:
 * an over-long title is rejected. Narrow-terminal truncation happens only in
 * rendering.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Count Unicode grapheme clusters in `text`. */
export function graphemeLength(text: string): number {
	let n = 0;
	for (const _segment of segmenter.segment(text)) n++;
	return n;
}

// C0 and C1 control characters, which include \n, \r and \t.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

export interface TitleCheck {
	ok: boolean;
	/** Trimmed value when `ok`; otherwise the original input is irrelevant. */
	value: string;
	error?: string;
}

/**
 * Validate a title for one layer.
 *
 * Rules: trim leading/trailing whitespace, reject empty, reject any control
 * character (including newlines and tabs), and reject a grapheme length above
 * `max`. Returns the trimmed value on success.
 */
export function validateTitle(raw: unknown, max: number, layer: string): TitleCheck {
	if (typeof raw !== "string") {
		return { ok: false, value: "", error: `${layer} title must be a string` };
	}
	const value = raw.trim();
	if (value.length === 0) {
		return { ok: false, value: "", error: `${layer} title must not be empty` };
	}
	if (CONTROL_CHARS.test(value)) {
		return { ok: false, value: "", error: `${layer} title must not contain control characters or line breaks` };
	}
	const length = graphemeLength(value);
	if (length > max) {
		return { ok: false, value: "", error: `${layer} title must be at most ${max} characters (got ${length})` };
	}
	return { ok: true, value };
}
