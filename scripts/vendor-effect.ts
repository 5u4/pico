#!/usr/bin/env bun
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "bun";

const repository = "https://github.com/Effect-TS/effect.git";
const destination = "repos/effect";

function warn(message: string): void {
	console.warn(`vendor-effect: ${message}`);
}

function installedEffectVersion(): string | null {
	const workspaceManifests = new Bun.Glob("{packages,apps}/*/package.json");
	for (const workspaceManifest of workspaceManifests.scanSync({
		cwd: process.cwd(),
		absolute: true,
	})) {
		const workspace: unknown = JSON.parse(
			readFileSync(workspaceManifest, "utf8"),
		);
		if (
			typeof workspace !== "object" ||
			workspace === null ||
			!("dependencies" in workspace) ||
			typeof workspace.dependencies !== "object" ||
			workspace.dependencies === null ||
			!("effect" in workspace.dependencies)
		) {
			continue;
		}

		let manifest: unknown;
		try {
			const manifestPath = Bun.resolveSync(
				"effect/package.json",
				dirname(workspaceManifest),
			);
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch {
			manifest = undefined;
		}
		if (
			typeof manifest === "object" &&
			manifest !== null &&
			"version" in manifest &&
			typeof manifest.version === "string"
		) {
			return manifest.version;
		}
	}
	return null;
}

function cachedTag(cacheDir: string): string | null {
	const marker = join(cacheDir, ".vendored-tag");
	if (!existsSync(marker)) return null;
	return readFileSync(marker, "utf8").trim();
}

function populateCache(tag: string, cacheDir: string): boolean {
	if (cachedTag(cacheDir) === tag) return true;
	if (existsSync(cacheDir)) {
		warn(`refusing to replace unmanaged cache path ${cacheDir}`);
		return false;
	}

	mkdirSync(dirname(cacheDir), { recursive: true });
	const staging = `${cacheDir}.${process.pid}.tmp`;
	rmSync(staging, { recursive: true, force: true });

	const clone = spawnSync(
		[
			"git",
			"clone",
			"--depth",
			"1",
			"--branch",
			tag,
			"--single-branch",
			repository,
			staging,
		],
		{ stdout: "inherit", stderr: "pipe" },
	);

	if (clone.exitCode !== 0) {
		rmSync(staging, { recursive: true, force: true });
		warn(`could not clone ${tag} (offline?); skipping vendored source`);
		const error = clone.stderr.toString().trim();
		if (error.length > 0) warn(error);
		return false;
	}

	rmSync(join(staging, ".git"), { recursive: true, force: true });
	writeFileSync(join(staging, ".vendored-tag"), `${tag}\n`);

	try {
		renameSync(staging, cacheDir);
		console.log(`vendor-effect: cached ${tag} at ${cacheDir}`);
		return true;
	} catch {
		rmSync(staging, { recursive: true, force: true });
		if (cachedTag(cacheDir) === tag) return true;
		warn(`could not publish cache at ${cacheDir}`);
		return false;
	}
}

function pathKind(path: string): "missing" | "symlink" | "other" {
	try {
		return lstatSync(path).isSymbolicLink() ? "symlink" : "other";
	} catch {
		return "missing";
	}
}

function linkWorktree(cacheDir: string): boolean {
	const kind = pathKind(destination);
	if (kind === "symlink") {
		try {
			if (realpathSync(destination) === realpathSync(cacheDir)) return true;
		} catch {
			unlinkSync(destination);
		}
		if (pathKind(destination) === "symlink") unlinkSync(destination);
	} else if (kind === "other") {
		warn(`refusing to replace non-symlink path ${destination}`);
		return false;
	}

	mkdirSync(dirname(destination), { recursive: true });
	symlinkSync(
		cacheDir,
		destination,
		process.platform === "win32" ? "junction" : "dir",
	);
	console.log(`vendor-effect: linked ${destination} -> ${cacheDir}`);
	return true;
}

const version = installedEffectVersion();
if (version === null) {
	warn("effect is not installed; skipping vendored source");
	process.exit(0);
}

const tag = `effect@${version}`;
const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
const cacheDir = join(cacheRoot, "pico", "vendors", tag);

if (populateCache(tag, cacheDir)) linkWorktree(cacheDir);
