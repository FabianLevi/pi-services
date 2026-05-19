#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));

const requiredPaths = [
	"bin/pi-services.mjs",
	"extensions/services.ts",
	"lib/services-config.ts",
	"lib/services-state.ts",
	"lib/services-logs.ts",
	"lib/services-process.ts",
	"README.md",
	"LICENSE",
];

const missing = requiredPaths.filter((rel) => {
	const abs = join(root, rel);
	return !existsSync(abs) || !statSync(abs).isFile();
});

if (missing.length > 0) {
	console.error("pi-services package is missing required files:");
	for (const rel of missing) console.error(`- ${rel}`);
	console.error("\nRefusing to pack/publish.");
	process.exit(1);
}

console.log(
	`pi-services package resource check passed (${requiredPaths.length} files).`,
);
