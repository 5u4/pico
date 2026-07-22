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
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";

const REPO = "https://github.com/Effect-TS/effect.git";
const DEST = "repos/effect";

function warn(message: string): void {
  console.warn(`vendor-effect: ${message}`);
}

function installedEffectVersion(): string | null {
  let manifest: string;
  try {
    manifest = Bun.resolveSync(
      "effect/package.json",
      `${process.cwd()}/packages/core`,
    );
  } catch {
    return null;
  }
  if (!existsSync(manifest)) return null;
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof parsed.version === "string"
  ) {
    return parsed.version;
  }
  return null;
}

function populateCache(tag: string, cacheDir: string): boolean {
  if (existsSync(join(cacheDir, ".vendored-tag"))) return true;

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
      REPO,
      staging,
    ],
    { stdout: "inherit", stderr: "pipe" },
  );
  if (clone.exitCode !== 0) {
    rmSync(staging, { recursive: true, force: true });
    warn(`could not clone ${tag} (offline?); skipping vendored source.`);
    warn(clone.stderr.toString().trim());
    return false;
  }

  rmSync(join(staging, ".git"), { recursive: true, force: true });
  writeFileSync(join(staging, ".vendored-tag"), `${tag}\n`);

  try {
    renameSync(staging, cacheDir);
    console.log(`vendor-effect: cached ${tag} at ${cacheDir}`);
  } catch {
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(join(cacheDir, ".vendored-tag"))) return false;
  }
  return true;
}

function linkWorktree(cacheDir: string): void {
  if (existsSync(DEST)) {
    if (
      lstatSync(DEST).isSymbolicLink() &&
      realpathSync(DEST) === realpathSync(cacheDir)
    ) {
      return;
    }
    rmSync(DEST, { recursive: true, force: true });
  }
  mkdirSync("repos", { recursive: true });
  symlinkSync(cacheDir, DEST);
  console.log(`vendor-effect: linked ${DEST} -> ${cacheDir}`);
}

const version = installedEffectVersion();
if (version === null) {
  warn("effect is not installed; skipping vendored source.");
  process.exit(0);
}

const tag = `effect@${version}`;
const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
const cacheDir = join(cacheRoot, "pico", "vendors", tag);

if (!populateCache(tag, cacheDir)) process.exit(0);
linkWorktree(cacheDir);
