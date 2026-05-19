#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const STATUS = {
	RUNNING: "running",
	EXITED: "exited",
};

function usage(exitCode = 1) {
	const out = exitCode === 0 ? process.stdout : process.stderr;
	out.write(
		`Usage:\n  pi-services run <service> -- <cmd> [args...]\n\nExample:\n  pi-services run frontend -- pnpm dev\n`,
	);
	process.exit(exitCode);
}

function fail(message, exitCode = 1) {
	process.stderr.write(`pi-services: ${message}\n`);
	process.exit(exitCode);
}

function findProjectCwd(start) {
	let cur = resolve(start);
	while (true) {
		if (existsSync(join(cur, ".pi", "services.json"))) return cur;
		const parent = dirname(cur);
		if (parent === cur) return resolve(start);
		cur = parent;
	}
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		fail(`failed to read ${path}: ${err.message}`);
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadService(projectCwd, name) {
	const configPath = join(projectCwd, ".pi", "services.json");
	const raw = readJson(configPath);
	if (!isRecord(raw.services))
		fail(`${configPath}: missing object key 'services'`);
	const svc = raw.services[name];
	if (!isRecord(svc)) fail(`unknown service '${name}' in ${configPath}`);
	if (svc.kind !== "server" && svc.kind !== "task") {
		fail(`service '${name}': 'kind' must be 'server' or 'task'`);
	}
	const cmd = typeof svc.cmd === "string" ? svc.cmd : "";
	const cwd =
		typeof svc.cwd === "string" && svc.cwd.trim() !== "" ? svc.cwd : ".";
	const env = isRecord(svc.env)
		? Object.fromEntries(
				Object.entries(svc.env).filter(([, v]) => typeof v === "string"),
			)
		: {};
	return { name, kind: svc.kind, cmd, cwd, env };
}

function resolveServiceCwd(projectCwd, cwd) {
	if (isAbsolute(cwd))
		fail(`service cwd must be relative to project root: ${cwd}`);
	const resolved = resolve(projectCwd, cwd);
	const rel = relative(projectCwd, resolved);
	if (
		rel === ".." ||
		rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
	) {
		fail(`service cwd escapes project root: ${cwd}`);
	}
	return resolved;
}

function stateDir(projectCwd) {
	return join(projectCwd, ".pi", "services");
}

function logDir(projectCwd) {
	return join(stateDir(projectCwd), "logs");
}

function statePath(projectCwd) {
	return join(stateDir(projectCwd), "state.json");
}

function logPathFor(projectCwd, name) {
	return join(logDir(projectCwd), `${name}.log`);
}

function readState(projectCwd) {
	try {
		const parsed = JSON.parse(readFileSync(statePath(projectCwd), "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeState(projectCwd, state) {
	mkdirSync(stateDir(projectCwd), { recursive: true });
	mkdirSync(logDir(projectCwd), { recursive: true });
	const target = statePath(projectCwd);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(tmp, target);
}

function shellQuotePart(part) {
	if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(part)) return part;
	return `'${part.replaceAll("'", `'\\''`)}'`;
}

function displayCommand(args) {
	return args.map(shellQuotePart).join(" ");
}

function exitCodeFor(code, signal) {
	if (typeof code === "number") return code;
	if (signal === "SIGINT") return 130;
	if (signal === "SIGTERM") return 143;
	return 1;
}

function writeEntry(projectCwd, name, patch) {
	const state = readState(projectCwd);
	writeState(projectCwd, { ...state, [name]: patch });
}

function patchEntryForPid(projectCwd, name, pid, patch) {
	const state = readState(projectCwd);
	const current = state[name];
	if (!current || current.pid !== pid) return;
	writeState(projectCwd, { ...state, [name]: { ...current, ...patch } });
}

async function runService(args) {
	const service = args[1];
	if (!service || args[2] !== "--" || args.length < 4) usage();
	const cmdArgs = args.slice(3);
	const projectCwd = findProjectCwd(process.cwd());
	const svc = loadService(projectCwd, service);
	const serviceCwd = resolveServiceCwd(projectCwd, svc.cwd);
	const logPath = logPathFor(projectCwd, service);
	mkdirSync(dirname(logPath), { recursive: true });

	const log = createWriteStream(logPath, { flags: "w" });
	const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
		cwd: serviceCwd,
		env: { ...process.env, ...svc.env },
		stdio: ["inherit", "pipe", "pipe"],
	});

	let settled = false;
	let requestedSignal = null;

	child.stdout?.on("data", (chunk) => {
		process.stdout.write(chunk);
		log.write(chunk);
	});
	child.stderr?.on("data", (chunk) => {
		process.stderr.write(chunk);
		log.write(chunk);
	});

	child.once("spawn", () => {
		writeEntry(projectCwd, service, {
			pid: child.pid,
			status: STATUS.RUNNING,
			kind: svc.kind,
			cmd: displayCommand(cmdArgs),
			runner: "attached",
			startedAt: new Date().toISOString(),
		});
	});

	child.once("error", (err) => {
		settled = true;
		log.end();
		writeEntry(projectCwd, service, {
			pid: child.pid ?? 0,
			status: STATUS.EXITED,
			kind: svc.kind,
			cmd: displayCommand(cmdArgs),
			runner: "attached",
			startedAt: new Date().toISOString(),
			exitedAt: new Date().toISOString(),
			exitSignal: "ERROR",
		});
		fail(`failed to start '${service}': ${err.message}`);
	});

	const forward = (signal) => {
		requestedSignal = signal;
		if (typeof child.pid === "number") {
			try {
				child.kill(signal);
			} catch {
				/* already gone */
			}
		}
	};
	process.once("SIGINT", () => forward("SIGINT"));
	process.once("SIGTERM", () => forward("SIGTERM"));

	child.once("exit", (code, signal) => {
		if (settled) return;
		settled = true;
		log.end(() => {
			if (typeof child.pid === "number") {
				patchEntryForPid(projectCwd, service, child.pid, {
					status: STATUS.EXITED,
					exitedAt: new Date().toISOString(),
					exitCode: code ?? undefined,
					exitSignal: signal ?? requestedSignal ?? undefined,
				});
			}
			process.exit(exitCodeFor(code, signal ?? requestedSignal));
		});
	});
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") usage(0);
if (args[0] === "run") {
	await runService(args);
} else {
	usage();
}
