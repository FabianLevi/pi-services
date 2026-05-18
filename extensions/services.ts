import type {
	ExtensionAPI,
	ExtensionContext,
	BeforeAgentStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
	loadServicesConfig,
	type ServiceDefinition,
} from "../lib/services-config.ts";
import {
	readState,
	writeState,
	reconcileStaleEntries,
	updateEntry,
	logPathFor,
	STATUS,
	type ServiceStateEntry,
	type ServiceStatus,
} from "../lib/services-state.ts";
import {
	spawnService,
	waitForReadyPattern,
	terminateProcess,
} from "../lib/services-process.ts";
import {
	tailLogFile,
	extractRecentErrors,
	clampString,
	ERROR_PATTERN,
} from "../lib/services-logs.ts";

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 200;
const STOP_GRACE_MS = 2_000;
const HEADER_ERRORS_PER_SERVICE = 2;
const HEADER_ERROR_SCAN_LINES = 200;
const PROMPT_ERRORS_PER_SERVICE = 5;
const PROMPT_ERROR_SCAN_LINES = 200;
const PROMPT_ERROR_CLAMP = 200;
const TAIL_MIN = 1;
const TAIL_MAX = 500;
const TAIL_DEFAULT = 100;

interface ProjectRuntime {
	cwd: string;
	services: Map<string, ServiceDefinition>;
	// PIDs spawned by THIS runtime. We only signal these on session_shutdown
	// — entries persisted by a prior runtime may point at a reused PID owned
	// by an unrelated process, and killing them is unsafe.
	ownedPids: Set<number>;
}

const runtimes = new Map<string, ProjectRuntime>();

function ensureRuntime(cwd: string): ProjectRuntime {
	let rt = runtimes.get(cwd);
	if (!rt) {
		rt = { cwd, services: new Map(), ownedPids: new Set() };
		runtimes.set(cwd, rt);
	}
	return rt;
}

function nowIso(): string {
	return new Date().toISOString();
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

function fmtHeaderLine(name: string, entry: ServiceStateEntry): string {
	const extra =
		entry.status === STATUS.EXITED && entry.exitCode !== undefined
			? ` (exit ${entry.exitCode})`
			: "";
	return `  ${statusGlyph(entry.status)} ${name}  pid=${entry.pid}  ${entry.status}${extra}`;
}

interface HeaderLine {
	header: string;
	errors: string[];
}

interface HeaderSnapshot {
	lines: HeaderLine[];
}

function buildHeaderSnapshot(rt: ProjectRuntime): HeaderSnapshot | null {
	const state = readState(rt.cwd);
	const entries = Object.entries(state);
	if (entries.length === 0) return null;
	return {
		lines: entries.map(([name, entry]) => ({
			header: fmtHeaderLine(name, entry),
			errors: extractRecentErrors(
				logPathFor(rt.cwd, name),
				HEADER_ERROR_SCAN_LINES,
				HEADER_ERRORS_PER_SERVICE,
			),
		})),
	};
}

function refreshHeader(rt: ProjectRuntime, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const snapshot = buildHeaderSnapshot(rt);
	if (!snapshot) {
		ctx.ui.setHeader(undefined);
		return;
	}
	ctx.ui.setHeader((_tui, theme) => ({
		invalidate(): void {},
		render(width: number): string[] {
			const out: string[] = [theme.fg("accent", "services")];
			for (const { header, errors } of snapshot.lines) {
				out.push(header);
				for (const e of errors) {
					out.push(`      ${clampString(e, Math.max(40, width - 10))}`);
				}
			}
			return out;
		},
	}));
}

function notify(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

interface StartResult {
	ok: boolean;
	reason?: string;
	entry?: ServiceStateEntry;
}

async function startService(
	rt: ProjectRuntime,
	svc: ServiceDefinition,
	ctx: ExtensionContext,
): Promise<StartResult> {
	const existing = readState(rt.cwd)[svc.name];
	if (existing && (existing.status === STATUS.RUNNING || existing.status === STATUS.STARTING)) {
		return { ok: true, reason: "already running", entry: existing };
	}

	const spawned = spawnService(rt.cwd, svc);
	const pid = spawned.child.pid;
	if (typeof pid !== "number" || pid <= 0) {
		return { ok: false, reason: "spawn failed: no pid" };
	}

	let spawnError: Error | null = null;
	spawned.child.once("error", (err) => {
		spawnError = err;
		rt.ownedPids.delete(pid);
		const cur = readState(rt.cwd);
		if (cur[svc.name]) {
			writeState(
				rt.cwd,
				updateEntry(cur, svc.name, {
					status: STATUS.EXITED,
					exitedAt: nowIso(),
					exitSignal: "ERROR",
				}),
			);
			refreshHeader(rt, ctx);
		}
	});

	const entry: ServiceStateEntry = {
		pid,
		status: STATUS.STARTING,
		kind: svc.kind,
		cmd: svc.cmd,
		startedAt: nowIso(),
	};
	writeState(rt.cwd, { ...readState(rt.cwd), [svc.name]: entry });
	rt.ownedPids.add(pid);
	refreshHeader(rt, ctx);

	spawned.child.once("exit", (code, signal) => {
		rt.ownedPids.delete(pid);
		const cur = readState(rt.cwd);
		if (!cur[svc.name]) return;
		writeState(
			rt.cwd,
			updateEntry(cur, svc.name, {
				status: STATUS.EXITED,
				exitedAt: nowIso(),
				exitCode: code ?? undefined,
				exitSignal: signal ?? undefined,
			}),
		);
		refreshHeader(rt, ctx);
	});

	// Give the OS one tick to surface a synchronous spawn failure (ENOENT etc.)
	// before declaring success. Without this, kind:"task" and readyPattern-less
	// servers can return ok:true even though the child failed immediately.
	await new Promise((r) => setImmediate(r));
	if (spawnError) {
		return { ok: false, reason: `spawn error: ${(spawnError as Error).message}` };
	}

	if (svc.kind === "task") return { ok: true, entry };

	if (svc.readyPattern) {
		const pattern = new RegExp(svc.readyPattern);
		const result = await waitForReadyPattern(spawned.logPath, pattern, {
			timeoutMs: READY_TIMEOUT_MS,
			pollMs: READY_POLL_MS,
		});
		if (spawnError) return { ok: false, reason: `spawn error: ${(spawnError as Error).message}` };
		const cur = readState(rt.cwd);
		if (result.matched && cur[svc.name]?.status === STATUS.STARTING) {
			writeState(rt.cwd, updateEntry(cur, svc.name, { status: STATUS.RUNNING }));
			refreshHeader(rt, ctx);
			return { ok: true, entry: cur[svc.name] };
		}
		// Ready pattern didn't match — kill the orphan and let the exit handler
		// transition state to "exited". Otherwise the process keeps running
		// while the caller believes startup failed.
		await terminateProcess(pid, STOP_GRACE_MS);
		return { ok: false, reason: `readyPattern ${result.reason ?? "no match"}` };
	}

	const cur = readState(rt.cwd);
	if (cur[svc.name]?.status === STATUS.STARTING) {
		writeState(rt.cwd, updateEntry(cur, svc.name, { status: STATUS.RUNNING }));
		refreshHeader(rt, ctx);
	}
	return { ok: true, entry: cur[svc.name] };
}

async function stopService(
	rt: ProjectRuntime,
	name: string,
	ctx: ExtensionContext,
): Promise<boolean> {
	const state = readState(rt.cwd);
	const entry = state[name];
	if (!entry) return false;
	if (entry.status === STATUS.RUNNING || entry.status === STATUS.STARTING) {
		if (!rt.ownedPids.has(entry.pid)) {
			// Stale entry from a prior runtime — the PID may have been reused.
			// Don't signal it; just mark the entry stopped so the user can move on.
			writeState(
				rt.cwd,
				updateEntry(state, name, { status: STATUS.STOPPED, exitedAt: nowIso() }),
			);
			refreshHeader(rt, ctx);
			return true;
		}
		writeState(rt.cwd, updateEntry(state, name, { status: STATUS.STOPPING }));
		refreshHeader(rt, ctx);
		await terminateProcess(entry.pid, STOP_GRACE_MS);
		// exit handler transitions to "exited" and updates the entry; do not delete here.
	}
	return true;
}

function summarizeStateForPrompt(rt: ProjectRuntime): string {
	const state = readState(rt.cwd);
	if (Object.keys(state).length === 0 && rt.services.size === 0) return "";
	const lines: string[] = [];
	lines.push("[services]");
	lines.push(
		"Project services declared in .pi/services.json. Use the `service_logs` tool to read live logs by name.",
	);
	const declared = Array.from(rt.services.values());
	if (declared.length > 0) {
		lines.push("Declared:");
		for (const d of declared) lines.push(`  - ${d.name} (${d.kind}): ${d.cmd}`);
	}
	const running = Object.entries(state);
	if (running.length > 0) {
		lines.push("Live state:");
		for (const [name, e] of running) {
			lines.push(
				`  - ${name}: ${e.status} pid=${e.pid}${e.exitCode !== undefined ? ` exit=${e.exitCode}` : ""}`,
			);
			const errs = extractRecentErrors(
				logPathFor(rt.cwd, name),
				PROMPT_ERROR_SCAN_LINES,
				PROMPT_ERRORS_PER_SERVICE,
			);
			for (const err of errs) lines.push(`      ${clampString(err, PROMPT_ERROR_CLAMP)}`);
		}
	}
	return lines.join("\n");
}

const serviceLogsSchema = Type.Object({
	service: Type.String({
		description: "Service name as declared in .pi/services.json",
	}),
	tail: Type.Optional(
		Type.Integer({ minimum: TAIL_MIN, maximum: TAIL_MAX, default: TAIL_DEFAULT }),
	),
	grep: Type.Optional(
		Type.String({ description: "Case-insensitive regex filter" }),
	),
	since: Type.Optional(
		Type.String({
			description:
				"ISO timestamp; only lines with leading timestamps newer than this are kept",
		}),
	),
	errorsOnly: Type.Optional(Type.Boolean({ default: false })),
});

type ServiceLogsParams = Static<typeof serviceLogsSchema>;

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const rt = ensureRuntime(ctx.cwd);
		const loaded = loadServicesConfig(ctx.cwd);
		for (const w of loaded.warnings) notify(ctx, w, "warning");
		rt.services.clear();
		for (const [name, def] of Object.entries(loaded.config.services)) {
			rt.services.set(name, def);
		}

		const { state: reconciled, removed } = reconcileStaleEntries(readState(rt.cwd));
		if (removed.length > 0) {
			writeState(rt.cwd, reconciled);
			notify(ctx, `pi-services: cleared stale entries: ${removed.join(", ")}`);
		}

		const toStart = Array.from(rt.services.values()).filter((s) => {
			if (s.kind !== "server" || !s.autoStart) return false;
			const entry = reconciled[s.name];
			return !entry || entry.status === STATUS.EXITED || entry.status === STATUS.STOPPED;
		});
		for (const svc of toStart) {
			const r = await startService(rt, svc, ctx);
			if (!r.ok)
				notify(
					ctx,
					`pi-services: ${svc.name} failed to start: ${r.reason}`,
					"error",
				);
		}
		// Only touch the header if we actually have something to display, so we
		// don't clobber other extensions' headers in projects with no services.
		if (Object.keys(readState(rt.cwd)).length > 0) refreshHeader(rt, ctx);
	});

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		const rt = ensureRuntime(ctx.cwd);
		const summary = summarizeStateForPrompt(rt);
		if (!summary) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${summary}` };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const rt = runtimes.get(ctx.cwd);
		if (!rt) return;
		// Only stop services this runtime spawned. Entries persisted by a
		// prior runtime point at PIDs the OS may have reused — see fix 3a.
		const state = readState(rt.cwd);
		for (const [name, entry] of Object.entries(state)) {
			if (rt.ownedPids.has(entry.pid)) await stopService(rt, name, ctx);
		}
	});

	pi.registerCommand("services", {
		description:
			"Manage project services. Subcommands: list (default), start <name>, stop <name>, restart <name>, logs <name> [tail].",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "list";
			const name = parts[1];
			const rt = ensureRuntime(ctx.cwd);

			if (sub === "list" || sub === "ls") {
				const state = readState(rt.cwd);
				const declared = Array.from(rt.services.values());
				if (declared.length === 0 && Object.keys(state).length === 0) {
					return notify(ctx, "No services declared. Create .pi/services.json.");
				}
				const lines = declared.map((d) => {
					const e = state[d.name];
					return `${statusGlyph(e?.status ?? STATUS.STOPPED)} ${d.name} (${d.kind})  ${e ? `pid=${e.pid} ${e.status}` : "stopped"}  — ${d.cmd}`;
				});
				return notify(ctx, lines.join("\n"));
			}

			if (sub === "start") {
				if (!name) return notify(ctx, "usage: /services start <name>", "warning");
				const svc = rt.services.get(name);
				if (!svc) return notify(ctx, `unknown service: ${name}`, "error");
				const r = await startService(rt, svc, ctx);
				return notify(ctx, r.ok ? `started ${name}` : `failed: ${r.reason}`, r.ok ? "info" : "error");
			}

			if (sub === "stop") {
				if (!name) return notify(ctx, "usage: /services stop <name>", "warning");
				const ok = await stopService(rt, name, ctx);
				return notify(ctx, ok ? `stopped ${name}` : `${name} was not running`);
			}

			if (sub === "restart") {
				if (!name) return notify(ctx, "usage: /services restart <name>", "warning");
				const svc = rt.services.get(name);
				if (!svc) return notify(ctx, `unknown service: ${name}`, "error");
				await stopService(rt, name, ctx);
				const r = await startService(rt, svc, ctx);
				return notify(ctx, r.ok ? `restarted ${name}` : `failed: ${r.reason}`, r.ok ? "info" : "error");
			}

			if (sub === "logs") {
				if (!name) return notify(ctx, "usage: /services logs <name> [tail]", "warning");
				const parsed = Number.parseInt(parts[2] ?? String(TAIL_DEFAULT), 10) || TAIL_DEFAULT;
				const tail = Math.max(TAIL_MIN, Math.min(TAIL_MAX, parsed));
				const { lines } = tailLogFile(logPathFor(rt.cwd, name), { tail });
				return notify(ctx, lines.length > 0 ? lines.join("\n") : "(no log yet)");
			}

			return notify(
				ctx,
				`unknown subcommand: ${sub}. usage: /services [list|start|stop|restart|logs] [<name>] [tail]`,
				"warning",
			);
		},
	});

	pi.registerTool({
		name: "service_logs",
		label: "service_logs",
		description:
			"Read live logs for a project service declared in .pi/services.json. Use this when debugging a long-running command instead of trying to run it again.",
		promptSnippet:
			"service_logs(service, tail?, grep?, since?, errorsOnly?): read recent log lines from a running service",
		parameters: serviceLogsSchema,
		executionMode: "parallel",
		async execute(_id, params: ServiceLogsParams, _signal, _onUpdate, ctx) {
			const rt = ensureRuntime(ctx.cwd);
			const logPath = logPathFor(rt.cwd, params.service);
			const tail = params.tail ?? TAIL_DEFAULT;
			const { lines, truncated, warnings } = tailLogFile(logPath, {
				tail,
				grep: params.errorsOnly ? ERROR_PATTERN.source : params.grep,
				since: params.since,
			});
			const entry = readState(rt.cwd)[params.service];
			const header = entry
				? `service=${params.service} status=${entry.status} pid=${entry.pid}${entry.exitCode !== undefined ? ` exit=${entry.exitCode}` : ""}`
				: `service=${params.service} status=not-running`;
			const warnLine = warnings && warnings.length > 0
				? `\nwarnings: ${warnings.join("; ")}`
				: "";
			const body = lines.length > 0 ? lines.join("\n") : "(no log content)";
			const text = `${header}${truncated ? `  (showing last ${tail} lines)` : ""}${warnLine}\n\n${body}`;
			return {
				content: [{ type: "text", text }],
				details: {
					service: params.service,
					lines,
					status: entry?.status ?? "not-running",
					warnings,
				},
			};
		},
	});
}
