import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ServiceKind = "server" | "task";

export interface ServiceDefinition {
	name: string;
	kind: ServiceKind;
	cmd: string;
	cwd: string;
	env: Record<string, string>;
	autoStart: boolean;
	readyPattern?: string;
}

export interface ServicesConfig {
	services: Record<string, ServiceDefinition>;
}

export interface ConfigParseResult {
	config: ServicesConfig;
	warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	for (const v of Object.values(value)) {
		if (typeof v !== "string") return false;
	}
	return true;
}

export function configPathFor(projectCwd: string): string {
	return join(projectCwd, ".pi", "services.json");
}

export function parseServicesConfig(raw: unknown): ConfigParseResult {
	const warnings: string[] = [];
	const result: ServicesConfig = { services: {} };

	if (!isRecord(raw)) {
		warnings.push("services.json: top level must be an object");
		return { config: result, warnings };
	}

	const rawServices = raw.services;
	if (rawServices === undefined) {
		warnings.push("services.json: missing 'services' key");
		return { config: result, warnings };
	}

	if (!isRecord(rawServices)) {
		warnings.push("services.json: 'services' must be an object");
		return { config: result, warnings };
	}

	for (const [name, def] of Object.entries(rawServices)) {
		const parsed = parseServiceDefinition(name, def, warnings);
		if (parsed) result.services[name] = parsed;
	}

	return { config: result, warnings };
}

function parseServiceDefinition(
	name: string,
	def: unknown,
	warnings: string[],
): ServiceDefinition | null {
	if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
		warnings.push(`service '${name}': name must start with a letter and contain only letters, digits, '-', '_'`);
		return null;
	}

	if (!isRecord(def)) {
		warnings.push(`service '${name}': definition must be an object`);
		return null;
	}

	const kind = def.kind;
	if (kind !== "server" && kind !== "task") {
		warnings.push(`service '${name}': 'kind' must be 'server' or 'task'`);
		return null;
	}

	const cmd = def.cmd;
	if (typeof cmd !== "string" || cmd.trim() === "") {
		warnings.push(`service '${name}': 'cmd' must be a non-empty string`);
		return null;
	}

	const cwd = typeof def.cwd === "string" && def.cwd.trim() !== "" ? def.cwd : ".";

	let env: Record<string, string> = {};
	if (def.env !== undefined) {
		if (!isStringRecord(def.env)) {
			warnings.push(`service '${name}': 'env' must be a string-to-string map; ignoring`);
		} else {
			env = def.env;
		}
	}

	const autoStart = def.autoStart === true;

	let readyPattern: string | undefined;
	if (def.readyPattern !== undefined) {
		if (typeof def.readyPattern !== "string") {
			warnings.push(`service '${name}': 'readyPattern' must be a string; ignoring`);
		} else {
			try {
				new RegExp(def.readyPattern);
				readyPattern = def.readyPattern;
			} catch {
				warnings.push(`service '${name}': 'readyPattern' is not a valid regex; ignoring`);
			}
		}
	}

	if (kind === "task" && autoStart) {
		warnings.push(`service '${name}': 'autoStart' is ignored for kind:task`);
	}

	return { name, kind, cmd, cwd, env, autoStart, readyPattern };
}

export function loadServicesConfig(projectCwd: string): ConfigParseResult & { path: string; missing: boolean } {
	const path = configPathFor(projectCwd);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { config: { services: {} }, warnings: [], path, missing: true };
		}
		return {
			config: { services: {} },
			warnings: [`services.json: ${(err as Error).message}`],
			path,
			missing: false,
		};
	}
	const { config, warnings } = parseServicesConfig(raw);
	return { config, warnings, path, missing: false };
}
