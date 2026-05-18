import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	readState,
	writeState,
	statePath,
	isProcessAlive,
	reconcileStaleEntries,
	updateEntry,
	type ServicesState,
} from "../lib/services-state.ts";

function tmpProject(): string {
	return mkdtempSync(join(tmpdir(), "pi-services-"));
}

test("readState returns {} when file missing", () => {
	const cwd = tmpProject();
	assert.deepEqual(readState(cwd), {});
});

test("writeState then readState round-trips", () => {
	const cwd = tmpProject();
	const state: ServicesState = {
		backend: {
			pid: 12345,
			status: "running",
			kind: "server",
			cmd: "echo hi",
			startedAt: "2026-05-18T00:00:00.000Z",
		},
	};
	writeState(cwd, state);
	assert.ok(existsSync(statePath(cwd)));
	assert.deepEqual(readState(cwd), state);
});

test("writeState writes atomically (no .tmp left behind)", () => {
	const cwd = tmpProject();
	writeState(cwd, {});
	assert.ok(!existsSync(`${statePath(cwd)}.tmp`));
});

test("readState returns {} on corrupt JSON", () => {
	const cwd = tmpProject();
	writeState(cwd, {});
	const path = statePath(cwd);
	writeFileSync(path, "{not json");
	assert.deepEqual(readState(cwd), {});
});

test("isProcessAlive(self) is true", () => {
	assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive returns false for unlikely pid", () => {
	assert.equal(isProcessAlive(2 ** 22), false);
});

test("reconcileStaleEntries removes running entries whose pid is dead", () => {
	const state: ServicesState = {
		alive: {
			pid: process.pid,
			status: "running",
			kind: "server",
			cmd: "x",
			startedAt: "now",
		},
		dead: {
			pid: 2 ** 22,
			status: "running",
			kind: "server",
			cmd: "x",
			startedAt: "now",
		},
		exited: {
			pid: 2 ** 22,
			status: "exited",
			kind: "task",
			cmd: "x",
			startedAt: "now",
		},
	};
	const { state: next, removed } = reconcileStaleEntries(state);
	assert.deepEqual(removed, ["dead"]);
	assert.ok(next.alive);
	assert.ok(next.exited);
	assert.equal(next.dead, undefined);
});

test("updateEntry patches in place", () => {
	const state: ServicesState = {
		foo: {
			pid: 1,
			status: "starting",
			kind: "server",
			cmd: "x",
			startedAt: "now",
		},
	};
	const next = updateEntry(state, "foo", { status: "running" });
	assert.equal(next.foo!.status, "running");
	assert.equal(state.foo!.status, "starting");
});

test("updateEntry throws for unknown service", () => {
	assert.throws(() => updateEntry({}, "ghost", { status: "running" }), /not in state/);
});
