import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tailLogFile, extractRecentErrors, clampString } from "../lib/services-logs.ts";

function tmpFile(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-logs-"));
	const path = join(dir, "test.log");
	writeFileSync(path, content);
	return path;
}

test("tailLogFile returns empty when file missing", () => {
	const r = tailLogFile(join(tmpdir(), "definitely-not-a-file.log"), { tail: 10 });
	assert.deepEqual(r, { lines: [], truncated: false });
});

test("tailLogFile returns last N lines", () => {
	const path = tmpFile("a\nb\nc\nd\ne\n");
	const r = tailLogFile(path, { tail: 3 });
	assert.deepEqual(r.lines, ["c", "d", "e"]);
	assert.equal(r.truncated, true);
});

test("tailLogFile not truncated when fewer lines than tail", () => {
	const path = tmpFile("a\nb\n");
	const r = tailLogFile(path, { tail: 10 });
	assert.deepEqual(r.lines, ["a", "b"]);
	assert.equal(r.truncated, false);
});

test("tailLogFile filters by grep (case-insensitive)", () => {
	const path = tmpFile("hello\nERROR boom\nok\nerror two\n");
	const r = tailLogFile(path, { tail: 10, grep: "error" });
	assert.deepEqual(r.lines, ["ERROR boom", "error two"]);
});

test("tailLogFile ignores invalid grep regex and warns", () => {
	const path = tmpFile("a\nb\n");
	const r = tailLogFile(path, { tail: 10, grep: "(" });
	assert.deepEqual(r.lines, ["a", "b"]);
	assert.ok(r.warnings && r.warnings.length === 1, "expected one warning");
	assert.match(r.warnings![0]!, /invalid grep regex/);
});

test("tailLogFile warns about invalid grep even when log file is missing", () => {
	const r = tailLogFile(join(tmpdir(), "definitely-not-a-file.log"), {
		tail: 10,
		grep: "(",
	});
	assert.deepEqual(r.lines, []);
	assert.equal(r.truncated, false);
	assert.ok(r.warnings && r.warnings.length === 1, "expected warning even on ENOENT");
	assert.match(r.warnings![0]!, /invalid grep regex/);
});

test("tailLogFile filters by since when lines have leading timestamps", () => {
	const path = tmpFile(
		"2026-05-18T00:00:00Z early\n2026-05-18T12:00:00Z mid\nno-ts line\n2026-05-18T23:00:00Z late\n",
	);
	const r = tailLogFile(path, { tail: 10, since: "2026-05-18T10:00:00Z" });
	assert.deepEqual(r.lines, ["2026-05-18T12:00:00Z mid", "no-ts line", "2026-05-18T23:00:00Z late"]);
});

test("extractRecentErrors returns matching lines bounded by max", () => {
	const path = tmpFile("ok\nERROR 1\nfine\nfail 2\nwarn 3\nexception 4\ntraceback 5\nok\n");
	const matches = extractRecentErrors(path, 100, 3);
	assert.equal(matches.length, 3);
	assert.deepEqual(matches, ["warn 3", "exception 4", "traceback 5"]);
});

test("clampString truncates with ellipsis", () => {
	assert.equal(clampString("hello", 10), "hello");
	assert.equal(clampString("hello world", 6), "hello…");
});

test("tailLogFile reads only the trailing window for very large files", () => {
	// Build a file > 1 MiB so the bounded reader has to skip the prefix.
	// Each line is 100 bytes; 20_000 lines = ~2 MiB.
	const line = "x".repeat(99);
	const huge = Array.from({ length: 20_000 }, (_, i) => `${line.slice(0, 90)}${String(i).padStart(8, "0")}`).join("\n") + "\n";
	const path = tmpFile(huge);
	const r = tailLogFile(path, { tail: 5 });
	assert.equal(r.truncated, true);
	assert.equal(r.lines.length, 5);
	// Should be the last 5 logical lines — i.e., end with the highest index.
	assert.match(r.lines[r.lines.length - 1]!, /00019999$/);
});
