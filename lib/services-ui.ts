import { watch, type FSWatcher } from "node:fs";
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { ServiceDefinition } from "./services-config.ts";
import {
	readState,
	logPathFor,
	STATUS,
	type ServiceStateEntry,
	type ServiceStatus,
} from "./services-state.ts";
import { tailLogFile } from "./services-logs.ts";

const TAIL_LINES = 500;
const POLL_MS = 1000;

export interface ServicesUiActions {
	start(name: string): Promise<void>;
	stop(name: string): Promise<void>;
	restart(name: string): Promise<void>;
}

export interface ServicesUiResult {
	action: "close";
}

export async function showServicesUi(
	ctx: ExtensionContext,
	cwd: string,
	declared: Map<string, ServiceDefinition>,
	actions: ServicesUiActions,
): Promise<ServicesUiResult> {
	return ctx.ui.custom<ServicesUiResult>(
		(tui, theme, _kb, done) => new ServicesOverlay(tui, theme, cwd, declared, actions, done),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "92%", maxHeight: "88%", minWidth: 70 },
		},
	);
}

type TuiHandle = { terminal: { rows?: number }; requestRender(): void };

class ServicesOverlay {
	private mode: "list" | "tail" = "list";
	private selectionIndex = 0;
	private tailName: string | undefined;
	private tailLines: string[] = [];
	private tailScroll = 0;
	private tailFollow = true;
	private logWatcher: FSWatcher | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private busy: string | undefined;

	private readonly tui: TuiHandle;
	private readonly theme: Theme;
	private readonly cwd: string;
	private readonly declared: Map<string, ServiceDefinition>;
	private readonly actions: ServicesUiActions;
	private readonly done: (r: ServicesUiResult) => void;

	constructor(
		tui: TuiHandle,
		theme: Theme,
		cwd: string,
		declared: Map<string, ServiceDefinition>,
		actions: ServicesUiActions,
		done: (r: ServicesUiResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.cwd = cwd;
		this.declared = declared;
		this.actions = actions;
		this.done = done;
		this.pollTimer = setInterval(() => this.tui.requestRender(), POLL_MS);
	}

	dispose(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.closeWatcher();
	}

	handleInput(data: string): void {
		if (this.mode === "tail") return this.handleTailInput(data);
		this.handleListInput(data);
	}

	render(width: number): string[] {
		return this.mode === "tail" ? this.renderTail(width) : this.renderList(width);
	}

	invalidate(): void {}

	// --- list mode ---

	private rowNames(): string[] {
		const state = readState(this.cwd);
		const names = new Set<string>([...this.declared.keys(), ...Object.keys(state)]);
		return Array.from(names).sort();
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.done({ action: "close" });
			return;
		}
		const names = this.rowNames();
		if (matchesKey(data, Key.up)) {
			this.selectionIndex = clamp(this.selectionIndex - 1, 0, Math.max(0, names.length - 1));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectionIndex = clamp(this.selectionIndex + 1, 0, Math.max(0, names.length - 1));
			this.tui.requestRender();
			return;
		}
		const selected = names[this.selectionIndex];
		if (!selected) return;
		if (matchesKey(data, Key.enter) || data === "t") {
			this.enterTail(selected);
			return;
		}
		if (data === "s") {
			void this.runAction(selected, "start");
			return;
		}
		if (data === "x") {
			void this.runAction(selected, "stop");
			return;
		}
		if (data === "r") {
			void this.runAction(selected, "restart");
		}
	}

	private async runAction(name: string, kind: "start" | "stop" | "restart"): Promise<void> {
		this.busy = `${kind} ${name}…`;
		this.tui.requestRender();
		try {
			if (kind === "start") await this.actions.start(name);
			else if (kind === "stop") await this.actions.stop(name);
			else await this.actions.restart(name);
		} catch (err) {
			this.busy = `${kind} ${name} failed: ${(err as Error).message}`;
			this.tui.requestRender();
			return;
		}
		this.busy = undefined;
		this.tui.requestRender();
	}

	private renderList(width: number): string[] {
		const innerWidth = Math.max(40, width - 2);
		const state = readState(this.cwd);
		const names = this.rowNames();
		this.selectionIndex = clamp(this.selectionIndex, 0, Math.max(0, names.length - 1));

		const top = this.border("┌", "┐", innerWidth);
		const bottom = this.border("└", "┘", innerWidth);
		const divider = this.frame(this.theme.fg("borderMuted", "─".repeat(innerWidth)), innerWidth);

		const title = this.theme.fg("accent", this.theme.bold("pi-services"));
		const hint = this.theme.fg("dim", `${names.length} ${names.length === 1 ? "service" : "services"}`);
		const spacing = Math.max(1, innerWidth - visibleWidth(title) - visibleWidth(hint));
		const header = this.frame(`${title}${" ".repeat(spacing)}${hint}`, innerWidth);

		const body: string[] = [];
		if (names.length === 0) {
			body.push(this.frame(this.theme.fg("dim", "  No services. Create .pi/services.json."), innerWidth));
		} else {
			for (let i = 0; i < names.length; i += 1) {
				const name = names[i]!;
				body.push(this.frame(this.renderRow(name, state[name], i === this.selectionIndex, innerWidth - 2), innerWidth));
			}
		}

		const footerLines = [
			this.frame(this.theme.fg("dim", " ↑↓ select  ·  enter/t live tail  ·  s start  ·  x stop  ·  r restart"), innerWidth),
			this.frame(this.theme.fg("dim", this.busy ? ` ${this.busy}` : " esc/q close"), innerWidth),
		];

		return [top, header, divider, ...body, divider, ...footerLines, bottom];
	}

	private renderRow(name: string, entry: ServiceStateEntry | undefined, selected: boolean, width: number): string {
		const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
		const status: ServiceStatus = entry?.status ?? STATUS.STOPPED;
		const glyph = statusGlyph(status);
		const color = statusColor(status);
		const def = this.declared.get(name);
		const extra =
			status === STATUS.EXITED && entry?.exitCode !== undefined ? ` (exit ${entry.exitCode})` : "";
		const pidPart = entry ? `pid=${entry.pid} ` : "";
		const cmd = def?.cmd ?? entry?.cmd ?? "";
		const head = `${prefix}${this.theme.fg(color, glyph)} ${this.theme.fg(selected ? "accent" : "text", padRight(name, 16))} ${this.theme.fg(color, padRight(status + extra, 18))} ${this.theme.fg("dim", pidPart)}`;
		const headWidth = visibleWidth(head);
		const cmdStr = cmd ? this.theme.fg("dim", truncateToWidth(cmd, Math.max(0, width - headWidth - 2))) : "";
		return truncateToWidth(` ${head}${cmdStr}`, width + 1);
	}

	// --- tail mode ---

	private enterTail(name: string): void {
		this.mode = "tail";
		this.tailName = name;
		this.tailScroll = 0;
		this.tailFollow = true;
		this.loadTail();
		this.openWatcher(name);
		this.tui.requestRender();
	}

	private exitTail(): void {
		this.closeWatcher();
		this.mode = "list";
		this.tailName = undefined;
		this.tailLines = [];
		this.tui.requestRender();
	}

	private openWatcher(name: string): void {
		this.closeWatcher();
		const path = logPathFor(this.cwd, name);
		try {
			this.logWatcher = watch(path, { persistent: false }, () => {
				this.loadTail();
				this.tui.requestRender();
			});
			this.logWatcher.on("error", () => {});
		} catch {
			// File may not exist yet; periodic poll will retry via loadTail on next render path.
		}
	}

	private closeWatcher(): void {
		if (this.logWatcher) {
			try {
				this.logWatcher.close();
			} catch {}
			this.logWatcher = undefined;
		}
	}

	private loadTail(): void {
		if (!this.tailName) return;
		const { lines } = tailLogFile(logPathFor(this.cwd, this.tailName), { tail: TAIL_LINES });
		this.tailLines = lines;
	}

	private handleTailInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.exitTail();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.tailFollow = false;
			this.tailScroll = Math.max(0, this.tailScroll - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.tailScroll += 1;
			this.tui.requestRender();
			return;
		}
		if (data === "g") {
			this.tailFollow = false;
			this.tailScroll = 0;
			this.tui.requestRender();
			return;
		}
		if (data === "G" || data === "f") {
			this.tailFollow = true;
			this.tui.requestRender();
			return;
		}
		if (data === "x") {
			if (this.tailName) void this.runAction(this.tailName, "stop");
			return;
		}
		if (data === "r") {
			if (this.tailName) void this.runAction(this.tailName, "restart");
		}
	}

	private renderTail(width: number): string[] {
		const innerWidth = Math.max(40, width - 2);
		const name = this.tailName!;
		const entry = readState(this.cwd)[name];
		const status: ServiceStatus = entry?.status ?? STATUS.STOPPED;
		const color = statusColor(status);

		const top = this.border("┌", "┐", innerWidth);
		const bottom = this.border("└", "┘", innerWidth);
		const divider = this.frame(this.theme.fg("borderMuted", "─".repeat(innerWidth)), innerWidth);

		const title = `${this.theme.fg("accent", this.theme.bold(name))} ${this.theme.fg(color, statusGlyph(status))} ${this.theme.fg(color, status)}${entry ? this.theme.fg("dim", `  pid=${entry.pid}`) : ""}`;
		const followBadge = this.tailFollow ? this.theme.fg("success", "● follow") : this.theme.fg("dim", "○ paused");
		const spacing = Math.max(1, innerWidth - visibleWidth(title) - visibleWidth(followBadge));
		const header = this.frame(`${title}${" ".repeat(spacing)}${followBadge}`, innerWidth);

		const rows = this.tui.terminal.rows ?? 28;
		const viewport = Math.max(8, Math.floor(rows * 0.82) - 6);
		const total = this.tailLines.length;
		const maxScroll = Math.max(0, total - viewport);
		if (this.tailFollow) this.tailScroll = maxScroll;
		else this.tailScroll = clamp(this.tailScroll, 0, maxScroll);

		const slice = this.tailLines.slice(this.tailScroll, this.tailScroll + viewport);
		const body: string[] = [];
		if (total === 0) {
			body.push(this.frame(this.theme.fg("dim", "  (no log yet)"), innerWidth));
		} else {
			for (const line of slice) {
				body.push(this.frame(` ${truncateToWidth(line, innerWidth - 1)}`, innerWidth));
			}
		}
		while (body.length < viewport) body.push(this.frame("", innerWidth));

		const positionInfo =
			total > viewport
				? `${this.tailScroll + 1}-${Math.min(total, this.tailScroll + viewport)}/${total}`
				: `${total}/${total}`;
		const footerLines = [
			this.frame(
				this.theme.fg("dim", ` ↑↓ scroll  ·  g top  ·  G follow  ·  x stop  ·  r restart  ·  esc back  ·  ${positionInfo}`),
				innerWidth,
			),
			this.frame(this.theme.fg("dim", this.busy ? ` ${this.busy}` : " "), innerWidth),
		];

		return [top, header, divider, ...body, divider, ...footerLines, bottom];
	}

	// --- helpers ---

	private frame(content: string, innerWidth: number): string {
		const clipped = truncateToWidth(content, innerWidth);
		const pad = Math.max(0, innerWidth - visibleWidth(clipped));
		const bar = this.theme.fg("borderAccent", "│");
		return `${bar}${clipped}${" ".repeat(pad)}${bar}`;
	}

	private border(left: string, right: string, innerWidth: number): string {
		return this.theme.fg("borderAccent", `${left}${"─".repeat(innerWidth)}${right}`);
	}
}

function clamp(n: number, lo: number, hi: number): number {
	return n < lo ? lo : n > hi ? hi : n;
}

function padRight(s: string, n: number): string {
	if (s.length >= n) return s;
	return s + " ".repeat(n - s.length);
}

function statusGlyph(s: ServiceStatus): string {
	switch (s) {
		case STATUS.RUNNING:
			return "●";
		case STATUS.STARTING:
			return "◐";
		case STATUS.STOPPING:
			return "◓";
		case STATUS.EXITED:
			return "✗";
		case STATUS.STOPPED:
			return "○";
	}
}

function statusColor(s: ServiceStatus): ThemeColor {
	switch (s) {
		case STATUS.RUNNING:
			return "success";
		case STATUS.STARTING:
		case STATUS.STOPPING:
			return "warning";
		case STATUS.EXITED:
			return "error";
		case STATUS.STOPPED:
			return "dim";
	}
}
