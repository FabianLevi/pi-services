import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ServiceKind } from "./services-config.ts";

export const STATUS = {
	STARTING: "starting",
	RUNNING: "running",
	STOPPING: "stopping",
	STOPPED: "stopped",
	EXITED: "exited",
} as const;

export type ServiceStatus = (typeof STATUS)[keyof typeof STATUS];

export interface ServiceStateEntry {
	pid: number;
	status: ServiceStatus;
	kind: ServiceKind;
	cmd: string;
	startedAt: string;
	exitedAt?: string;
	exitCode?: number;
	exitSignal?: string;
}

export type ServicesState = Record<string, ServiceStateEntry>;

export function stateDir(projectCwd: string): string {
	return join(projectCwd, ".pi", "services");
}

export function statePath(projectCwd: string): string {
	return join(stateDir(projectCwd), "state.json");
}

export function logDir(projectCwd: string): string {
	return join(stateDir(projectCwd), "logs");
}

export function logPathFor(projectCwd: string, name: string): string {
	return join(logDir(projectCwd), `${name}.log`);
}

export function readState(projectCwd: string): ServicesState {
	try {
		const raw = readFileSync(statePath(projectCwd), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as ServicesState;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		return {};
	}
}

export function writeState(projectCwd: string, state: ServicesState): void {
	const dir = stateDir(projectCwd);
	mkdirSync(dir, { recursive: true });
	mkdirSync(logDir(projectCwd), { recursive: true });
	const target = statePath(projectCwd);
	const tmp = `${target}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(tmp, target);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		return code === "EPERM";
	}
}

export function reconcileStaleEntries(state: ServicesState): {
	state: ServicesState;
	removed: string[];
} {
	const next: ServicesState = {};
	const removed: string[] = [];
	const liveStatuses: ServiceStatus[] = [STATUS.RUNNING, STATUS.STARTING, STATUS.STOPPING];
	for (const [name, entry] of Object.entries(state)) {
		if (liveStatuses.includes(entry.status) && !isProcessAlive(entry.pid)) {
			removed.push(name);
			continue;
		}
		next[name] = entry;
	}
	return { state: next, removed };
}

export function updateEntry(
	state: ServicesState,
	name: string,
	patch: Partial<ServiceStateEntry>,
): ServicesState {
	const existing = state[name];
	if (!existing) {
		throw new Error(`service '${name}' not in state`);
	}
	return { ...state, [name]: { ...existing, ...patch } };
}
