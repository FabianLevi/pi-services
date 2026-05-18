import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync, closeSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { ServiceDefinition } from "./services-config.ts";
import { logPathFor } from "./services-state.ts";

export interface SpawnedService {
	child: ChildProcess;
	logPath: string;
	logFd: number;
	spawnError?: Error;
}

function resolveServiceCwd(projectCwd: string, cwd: string): string {
	if (isAbsolute(cwd)) {
		throw new Error(`service cwd must be relative to project root: ${cwd}`);
	}
	const resolved = resolve(projectCwd, cwd);
	const rel = relative(projectCwd, resolved);
	if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		throw new Error(`service cwd escapes project root: ${cwd}`);
	}
	return resolved;
}

export function spawnService(projectCwd: string, svc: ServiceDefinition): SpawnedService {
	const logPath = logPathFor(projectCwd, svc.name);
	mkdirSync(resolve(logPath, ".."), { recursive: true });
	const serviceCwd = resolveServiceCwd(projectCwd, svc.cwd);

	const logFd = openSync(logPath, "w");

	let child: ChildProcess;
	try {
		child = spawn(svc.cmd, [], {
			shell: true,
			cwd: serviceCwd,
			env: { ...process.env, ...svc.env },
			stdio: ["ignore", logFd, logFd],
			// detached:true makes the shell a process group leader so we can
			// signal the whole tree via process.kill(-pid, ...) — otherwise
			// SIGTERM hits only the shell and grandchildren may survive.
			detached: true,
		});
	} catch (err) {
		closeSync(logFd);
		throw err;
	}

	let closed = false;
	const closeFd = () => {
		if (closed) return;
		closed = true;
		try {
			closeSync(logFd);
		} catch {
			/* fd already closed */
		}
	};
	child.once("exit", closeFd);
	child.once("error", closeFd);

	return { child, logPath, logFd };
}

export interface WaitOptions {
	timeoutMs: number;
	pollMs: number;
}

export async function waitForReadyPattern(
	logPath: string,
	pattern: RegExp,
	opts: WaitOptions,
): Promise<{ matched: boolean; reason?: string }> {
	const start = Date.now();
	while (Date.now() - start < opts.timeoutMs) {
		try {
			const content = readFileSync(logPath, "utf8");
			if (pattern.test(content)) return { matched: true };
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") return { matched: false, reason: (err as Error).message };
		}
		await new Promise((r) => setTimeout(r, opts.pollMs));
	}
	return { matched: false, reason: "timeout" };
}

function signalGroupOrPid(pid: number, sig: NodeJS.Signals): void {
	// Try the process group first (negative pid). Falls back to the pid alone
	// if the leader isn't a group (ESRCH on -pid but pid is still alive).
	try {
		process.kill(-pid, sig);
		return;
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ESRCH" && code !== "EPERM") throw err;
	}
	try {
		process.kill(pid, sig);
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return;
		if (code !== "EPERM") throw err;
	}
}

export async function terminateProcess(pid: number, graceMs: number): Promise<void> {
	if (!Number.isInteger(pid) || pid <= 0) return;
	signalGroupOrPid(pid, "SIGTERM");
	await new Promise((r) => setTimeout(r, graceMs));
	signalGroupOrPid(pid, "SIGKILL");
}
