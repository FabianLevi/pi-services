import { test } from "node:test";
import assert from "node:assert/strict";

import { parseServicesConfig } from "../lib/services-config.ts";

test("accepts a valid config with server + task", () => {
	const { config, warnings } = parseServicesConfig({
		services: {
			backend: {
				kind: "server",
				cmd: "uv run -m api.main",
				cwd: ".",
				env: { PORT: "8000" },
				autoStart: true,
				readyPattern: "Uvicorn running on",
			},
			migrate: { kind: "task", cmd: "uv run alembic upgrade head" },
		},
	});

	assert.deepEqual(warnings, []);
	assert.equal(Object.keys(config.services).length, 2);
	assert.equal(config.services.backend!.kind, "server");
	assert.equal(config.services.backend!.autoStart, true);
	assert.equal(config.services.backend!.readyPattern, "Uvicorn running on");
	assert.deepEqual(config.services.backend!.env, { PORT: "8000" });
	assert.equal(config.services.migrate!.kind, "task");
	assert.equal(config.services.migrate!.cwd, ".");
	assert.deepEqual(config.services.migrate!.env, {});
	assert.equal(config.services.migrate!.autoStart, false);
});

test("rejects non-object root", () => {
	const { config, warnings } = parseServicesConfig([]);
	assert.equal(Object.keys(config.services).length, 0);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /top level must be an object/);
});

test("warns when services key missing", () => {
	const { warnings } = parseServicesConfig({});
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /missing 'services'/);
});

test("rejects invalid service name", () => {
	const { config, warnings } = parseServicesConfig({
		services: { "1bad": { kind: "task", cmd: "echo" } },
	});
	assert.equal(Object.keys(config.services).length, 0);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /name must start with a letter/);
});

test("rejects missing kind", () => {
	const { config, warnings } = parseServicesConfig({
		services: { foo: { cmd: "echo" } },
	});
	assert.equal(Object.keys(config.services).length, 0);
	assert.match(warnings[0]!, /'kind' must be/);
});

test("rejects empty cmd", () => {
	const { config, warnings } = parseServicesConfig({
		services: { foo: { kind: "task", cmd: "  " } },
	});
	assert.equal(Object.keys(config.services).length, 0);
	assert.match(warnings[0]!, /'cmd' must be a non-empty string/);
});

test("ignores invalid env but keeps service", () => {
	const { config, warnings } = parseServicesConfig({
		services: { foo: { kind: "task", cmd: "echo", env: { PORT: 8000 } } },
	});
	assert.equal(config.services.foo!.cmd, "echo");
	assert.deepEqual(config.services.foo!.env, {});
	assert.match(warnings[0]!, /'env' must be a string-to-string map/);
});

test("ignores invalid regex in readyPattern", () => {
	const { config, warnings } = parseServicesConfig({
		services: { foo: { kind: "server", cmd: "echo", readyPattern: "(" } },
	});
	assert.equal(config.services.foo!.readyPattern, undefined);
	assert.match(warnings[0]!, /not a valid regex/);
});

test("warns when autoStart used with kind:task", () => {
	const { config, warnings } = parseServicesConfig({
		services: { foo: { kind: "task", cmd: "echo", autoStart: true } },
	});
	assert.equal(config.services.foo!.autoStart, true);
	assert.match(warnings[0]!, /autoStart' is ignored for kind:task/);
});
