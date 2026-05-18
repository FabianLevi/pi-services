import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension from "../extensions/services.ts";
import { readState, isProcessAlive } from "../lib/services-state.ts";

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

interface RegisteredTool {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
}

// Minimal in-memory mock of ExtensionAPI / ExtensionContext. We deliberately
// set hasUI:false so the extension skips ui.* calls (their absence in the mock
// would otherwise throw).
function makeHarness(cwd: string) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>();
	const commands = new Map<string, RegisteredCommand>();
	let registeredTool: RegisteredTool | null = null;

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, opts: RegisteredCommand) {
			commands.set(name, opts);
		},
		registerTool(opts: RegisteredTool) {
			registeredTool = opts;
		},
	};

	const ctx = { cwd, hasUI: false };

	return {
		pi,
		ctx,
		async fire(event: string, payload: unknown = {}) {
			const h = handlers.get(event);
			if (!h) throw new Error(`no handler for ${event}`);
			return await h(payload, ctx);
		},
		async runCommand(name: string, args: string) {
			const c = commands.get(name);
			if (!c) throw new Error(`no command ${name}`);
			await c.handler(args, ctx);
		},
		callTool(params: unknown) {
			if (!registeredTool) throw new Error("tool not registered");
			return registeredTool.execute("test-id", params, undefined, undefined, ctx);
		},
		commandNames: () => Array.from(commands.keys()),
		hasTool: () => registeredTool !== null,
	};
}

function makeProject(servicesJson: unknown): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-svc-e2e-"));
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "services.json"), JSON.stringify(servicesJson, null, 2));
	return cwd;
}

test("extension registers session hooks, the services command, and the service_logs tool", () => {
	const cwd = makeProject({ services: {} });
	const h = makeHarness(cwd);
	// Cast away the strict ExtensionAPI typing — our mock only fulfils the subset the extension uses.
	extension(h.pi as unknown as Parameters<typeof extension>[0]);
	assert.deepEqual(h.commandNames().sort(), ["services"]);
	assert.equal(h.hasTool(), true);
});

test("autoStart server reaches running, service_logs returns content, shutdown reaps it", async () => {
	const cwd = makeProject({
		services: {
			tick: {
				kind: "server",
				// Prints READY then ticks every 100ms forever. Stays alive until we kill it.
				cmd: "node -e \"console.log('READY'); setInterval(()=>console.log('tick '+Date.now()), 100);\"",
				autoStart: true,
				readyPattern: "READY",
			},
		},
	});
	const h = makeHarness(cwd);
	extension(h.pi as unknown as Parameters<typeof extension>[0]);

	await h.fire("session_start");

	const state = readState(cwd);
	assert.ok(state.tick, "tick not in state");
	assert.equal(state.tick.status, "running");
	const pid = state.tick.pid;
	assert.equal(isProcessAlive(pid), true);

	// Give the ticker a moment so the log has something past READY.
	await sleep(250);

	const result = await h.callTool({ service: "tick", tail: 10 });
	assert.match(result.content[0]!.text, /service=tick status=running/);
	assert.match(result.content[0]!.text, /READY/);

	await h.fire("session_shutdown");
	await sleep(200);

	assert.equal(isProcessAlive(pid), false, "process still alive after shutdown");
	const after = readState(cwd);
	assert.equal(after.tick?.status, "exited", `expected exited, got ${after.tick?.status}`);
});

test("invalid grep surfaces a warning in tool details and text", async () => {
	const cwd = makeProject({
		services: {
			noop: {
				kind: "task",
				cmd: "echo hello",
			},
		},
	});
	const h = makeHarness(cwd);
	extension(h.pi as unknown as Parameters<typeof extension>[0]);
	await h.fire("session_start");
	// Tasks are not autoStarted; run it explicitly so the log file exists,
	// otherwise tailLogFile's ENOENT path returns early and skips grep validation.
	await h.runCommand("services", "start noop");
	await sleep(150);
	const result = await h.callTool({ service: "noop", grep: "(" });
	const details = result.details as { warnings?: string[] };
	assert.ok(details.warnings && details.warnings.length === 1, "expected warning");
	assert.match(result.content[0]!.text, /invalid grep regex/);
});
