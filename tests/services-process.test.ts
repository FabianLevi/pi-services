import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	spawnService,
	waitForReadyPattern,
	terminateProcess,
} from "../lib/services-process.ts";
import { isProcessAlive } from "../lib/services-state.ts";

function tmpProject(): string {
	return mkdtempSync(join(tmpdir(), "pi-proc-"));
}

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

test("spawnService captures stdout to log file", async () => {
	const cwd = tmpProject();
	const spawned = spawnService(cwd, {
		name: "echo",
		kind: "task",
		cmd: "echo hello-world",
		cwd: ".",
		env: {},
		autoStart: false,
	});
	await new Promise((r) => spawned.child.once("exit", r));
	const log = readFileSync(spawned.logPath, "utf8");
	assert.match(log, /hello-world/);
});

test("waitForReadyPattern matches when log eventually contains pattern", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ready-"));
	const path = join(dir, "ready.log");
	writeFileSync(path, "starting...\n");
	setTimeout(() => writeFileSync(path, "starting...\nlistening on :8080\n"), 80);
	const r = await waitForReadyPattern(path, /listening on/, {
		timeoutMs: 1000,
		pollMs: 30,
	});
	assert.equal(r.matched, true);
});

test("waitForReadyPattern reports timeout reason when pattern never appears", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ready-"));
	const path = join(dir, "ready.log");
	writeFileSync(path, "nothing of interest\n");
	const r = await waitForReadyPattern(path, /never/, {
		timeoutMs: 150,
		pollMs: 30,
	});
	assert.equal(r.matched, false);
	assert.equal(r.reason, "timeout");
});

test("terminateProcess kills the shell AND its grandchild via process group", async () => {
	const cwd = tmpProject();
	// Shell spawns a sleeping grandchild and prints its pid so we can verify it dies.
	const spawned = spawnService(cwd, {
		name: "tree",
		kind: "server",
		cmd: "node -e \"const c=require('child_process').spawn('sleep',['30']); console.log('CHILD_PID='+c.pid); setTimeout(()=>{}, 60000);\"",
		cwd: ".",
		env: {},
		autoStart: false,
	});
	const shellPid = spawned.child.pid;
	assert.ok(shellPid && shellPid > 0);
	// Wait for grandchild pid to appear in the log.
	let childPid = 0;
	for (let i = 0; i < 50; i++) {
		await sleep(50);
		const m = readFileSync(spawned.logPath, "utf8").match(/CHILD_PID=(\d+)/);
		if (m) {
			childPid = Number.parseInt(m[1]!, 10);
			break;
		}
	}
	assert.ok(childPid > 0, "did not capture grandchild pid");
	assert.equal(isProcessAlive(childPid), true);

	await terminateProcess(shellPid!, 200);
	// Give the OS a moment to reap.
	await sleep(150);
	assert.equal(isProcessAlive(shellPid!), false, "shell still alive");
	assert.equal(isProcessAlive(childPid), false, "grandchild still alive");
});

test("spawnService rejects absolute cwd in service definition", () => {
	const cwd = tmpProject();
	assert.throws(
		() =>
			spawnService(cwd, {
				name: "abs",
				kind: "task",
				cmd: "true",
				cwd: "/etc",
				env: {},
				autoStart: false,
			}),
		/must be relative/,
	);
});

test("spawnService rejects cwd that escapes the project root", () => {
	const cwd = tmpProject();
	assert.throws(
		() =>
			spawnService(cwd, {
				name: "esc",
				kind: "task",
				cmd: "true",
				cwd: "../..",
				env: {},
				autoStart: false,
			}),
		/escapes project root/,
	);
});

test("terminateProcess ignores invalid pid", async () => {
	await terminateProcess(0, 10);
	await terminateProcess(-5, 10);
	// Just ensure no throw.
	assert.ok(true);
});
