#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { spawnSync } from "bun";

const PATHSPEC = [
	"*.ts",
	"*.tsx",
	"*.js",
	"*.jsx",
	"*.mjs",
	"*.cjs",
	":!node_modules/*",
	":!*/node_modules/*",
];

type Violation = { file: string; line: number; text: string };

function resolveRange(argv: string[]): string[] {
	if (argv[0] === "--range") {
		if (!argv[1]) {
			console.error("usage: lint-comments.ts --range <git-range>");
			process.exit(2);
		}
		return [argv[1]];
	}
	if (argv[0]) return [argv[0]];
	return ["--cached"];
}

function readDiff(range: string[]): string {
	const proc = spawnSync([
		"git",
		"diff",
		...range,
		"--unified=0",
		"--",
		...PATHSPEC,
	]);
	if (proc.exitCode !== 0 && proc.exitCode !== 1) {
		console.error(
			`lint-comments: \`git diff ${range.join(" ")}\` failed (exit ${proc.exitCode}).`,
		);
		console.error(proc.stderr.toString());
		process.exit(proc.exitCode ?? 2);
	}
	return proc.stdout.toString();
}

function isExempt(content: string): boolean {
	return (
		content.startsWith("biome-ignore") ||
		content.includes("SPDX-License-Identifier")
	);
}

function scan(diff: string): Violation[] {
	const violations: Violation[] = [];
	let file = "";
	let lineNo = 0;
	let inBlock = false;

	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++ b/")) {
			file = raw.slice(6);
			inBlock = false;
			continue;
		}
		if (raw.startsWith("@@ ")) {
			const plus = raw.split("+")[1];
			const start = plus ? Number.parseInt(plus, 10) : 0;
			lineNo = Number.isNaN(start) ? 0 : start;
			inBlock = false;
			continue;
		}
		if (raw.startsWith("-") || raw.startsWith("---")) continue;
		if (!raw.startsWith("+")) continue;

		const text = raw.slice(1);
		const content = text.replace(/^\s+/, "");
		const verdict = classify(content, inBlock);
		inBlock = verdict.inBlock;
		if (verdict.flagged) {
			violations.push({ file, line: lineNo, text });
		}
		lineNo++;
	}
	return violations;
}

function classify(
	content: string,
	inBlock: boolean,
): { flagged: boolean; inBlock: boolean } {
	if (inBlock) {
		return { flagged: true, inBlock: !content.includes("*/") };
	}
	if (content.startsWith("//")) {
		const body = content.slice(2).replace(/^\s+/, "");
		return { flagged: !isExempt(body), inBlock: false };
	}
	if (content.startsWith("*")) return { flagged: true, inBlock: false };
	if (content.startsWith("/*")) {
		const body = content.slice(2).replace(/^\s+/, "");
		return { flagged: !isExempt(body), inBlock: !content.includes("*/") };
	}
	return { flagged: false, inBlock: false };
}

const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function scanAll(): Violation[] {
	const proc = spawnSync(["git", "ls-files", "-z", "--", ...PATHSPEC]);
	if (proc.exitCode !== 0) {
		console.error("lint-comments: `git ls-files` failed.");
		console.error(proc.stderr.toString());
		process.exit(proc.exitCode ?? 2);
	}
	const files = proc.stdout
		.toString()
		.split("\0")
		.filter((f) => f !== "" && SOURCE_RE.test(f));
	const violations: Violation[] = [];
	for (const file of files) {
		let inBlock = false;
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((raw, index) => {
			const content = raw.replace(/^\s+/, "");
			const verdict = classify(content, inBlock);
			inBlock = verdict.inBlock;
			if (verdict.flagged) {
				violations.push({ file, line: index + 1, text: raw });
			}
		});
	}
	return violations;
}

const argv = process.argv.slice(2);
const violations =
	argv[0] === "--all" ? scanAll() : scan(readDiff(resolveRange(argv)));
if (violations.length === 0) process.exit(0);

console.error("lint-comments: comments are banned (see rule://no-comments).");
console.error("Allowed only: `// biome-ignore ...` and SPDX headers.\n");
for (const v of violations) {
	console.error(`  ${v.file}:${v.line}: ${v.text.trim()}`);
}
process.exit(1);
