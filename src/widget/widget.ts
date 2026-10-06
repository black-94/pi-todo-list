import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { buildReadResult } from "../domain/view.ts";
import { getRenderSnapshot } from "../state/store.ts";
import { renderTodoLines, type RenderTheme } from "./render.ts";

const WIDGET_KEY = "pi-todo-list";
const MAX_BODY_ROWS = 12;

/**
 * Persistent widget above the editor. It reads the foreground session's
 * committed snapshot at render time; it never replays the branch itself, so a
 * refresh after a tool result always shows the state that was actually
 * committed.
 */
export class TodoWidget {
	private uiCtx: ExtensionUIContext | undefined;
	private registered = false;
	private tui: TUI | undefined;
	private expanded = false;

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity compare so repeated session_start handlers are idempotent and a
		// reload (new ui identity) forces re-registration.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	/** Refresh from the current foreground snapshot. Auto-hides when empty. */
	update(): void {
		if (!this.uiCtx) return;
		if (buildReadResult(getRenderSnapshot()).counts.leaves === 0) {
			if (this.registered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
			}
			return;
		}
		if (!this.registered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.render(this.uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {
							// No cached strings: render reads the live snapshot and theme.
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	toggleExpanded(): void {
		this.expanded = !this.expanded;
		// Height changes on expand/collapse need a full redraw.
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.registered;
	}

	private render(theme: Theme, width: number): string[] {
		const read = buildReadResult(getRenderSnapshot());
		const toolsExpanded = this.uiCtx?.getToolsExpanded?.() === true;
		return renderTodoLines(read, {
			width,
			expanded: this.expanded || toolsExpanded,
			maxRows: MAX_BODY_ROWS,
			theme: theme as unknown as RenderTheme,
			truncate: truncateToWidth,
		});
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.expanded = false;
	}
}
