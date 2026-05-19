import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("bin/pi-services.mjs");

function tmpProject(): string {
	return mkdtempSync(join(tmpdir(), "pi-services-cli-"));
}

function writeConfig(cwd: string): void {
	const piDir = join(cwd, ".pi");
	mkdirSync(piDir, { recursive: true });
	// Use node via shell-free CLI args in the tests; the configured cmd remains
	// a human hint for /services and documentation.
	writeFileSync(
		join(piDir, "services.json"),
		JSON.stringify(
			{ services: { frontend: { kind: "server", cmd: "pnpm dev" } } },
			null,
			2,
		),
	);
}

test("pi-services run tees stdout and stderr to the service log", () => {
	const cwd = tmpProject();
	writeConfig(cwd);

	const result = spawnSync(
		process.execPath,
		[
			CLI,
			"run",
			"frontend",
			"--",
			process.execPath,
			"-e",
			"console.log('hello-out'); console.error('hello-err');",
		],
		{ cwd, encoding: "utf8" },
	);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /hello-out/);
	assert.match(result.stderr, /hello-err/);

	const log = readFileSync(
		join(cwd, ".pi", "services", "logs", "frontend.log"),
		"utf8",
	);
	assert.match(log, /hello-out/);
	assert.match(log, /hello-err/);

	const state = JSON.parse(
		readFileSync(join(cwd, ".pi", "services", "state.json"), "utf8"),
	);
	assert.equal(state.frontend.status, "exited");
	assert.equal(state.frontend.runner, "attached");
	assert.equal(state.frontend.exitCode, 0);
});

test("pi-services run propagates command exit code", () => {
	const cwd = tmpProject();
	writeConfig(cwd);

	const result = spawnSync(
		process.execPath,
		[CLI, "run", "frontend", "--", process.execPath, "-e", "process.exit(7)"],
		{ cwd, encoding: "utf8" },
	);

	assert.equal(result.status, 7);
	const state = JSON.parse(
		readFileSync(join(cwd, ".pi", "services", "state.json"), "utf8"),
	);
	assert.equal(state.frontend.status, "exited");
	assert.equal(state.frontend.exitCode, 7);
});
