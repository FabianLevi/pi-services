import { closeSync, openSync, readSync, statSync } from "node:fs";

const MAX_TAIL_READ_BYTES = 1024 * 1024;

export const ERROR_PATTERN = /error|warn|fail|exception|traceback/i;

export interface TailOptions {
	tail: number;
	grep?: string;
	since?: string;
}

export interface TailResult {
	lines: string[];
	truncated: boolean;
	warnings?: string[];
}

export function tailLogFile(path: string, opts: TailOptions): TailResult {
	const warnings: string[] = [];
	let grepRegex: RegExp | undefined;
	if (opts.grep !== undefined) {
		try {
			grepRegex = new RegExp(opts.grep, "i");
		} catch (err) {
			grepRegex = undefined;
			warnings.push(`invalid grep regex, ignored: ${(err as Error).message}`);
		}
	}

	let content: string;
	let omittedPrefix = false;
	try {
		const stat = statSync(path);
		const bytesToRead = Math.min(stat.size, MAX_TAIL_READ_BYTES);
		omittedPrefix = stat.size > bytesToRead;
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(bytesToRead);
			readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
			content = buffer.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return warnings.length > 0
				? { lines: [], truncated: false, warnings }
				: { lines: [], truncated: false };
		}
		throw err;
	}

	let lines = content.split("\n");
	if (omittedPrefix && lines.length > 0) lines = lines.slice(1);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);

	if (grepRegex) lines = lines.filter((l) => grepRegex.test(l));

	if (opts.since !== undefined) {
		const cutoff = Date.parse(opts.since);
		if (!Number.isNaN(cutoff)) {
			lines = lines.filter((l) => {
				const ts = extractLeadingTimestamp(l);
				if (ts === null) return true;
				return ts >= cutoff;
			});
		}
	}

	const truncated = omittedPrefix || lines.length > opts.tail;
	if (lines.length > opts.tail) lines = lines.slice(-opts.tail);

	return warnings.length > 0 ? { lines, truncated, warnings } : { lines, truncated };
}

function extractLeadingTimestamp(line: string): number | null {
	const match = line.match(/^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?/);
	if (!match) return null;
	const parsed = Date.parse(match[1]!);
	return Number.isNaN(parsed) ? null : parsed;
}

export function extractRecentErrors(path: string, scanLines: number, maxMatches: number): string[] {
	const { lines } = tailLogFile(path, { tail: scanLines });
	const matches = lines.filter((l) => ERROR_PATTERN.test(l));
	return matches.slice(-maxMatches);
}

export function clampString(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}
