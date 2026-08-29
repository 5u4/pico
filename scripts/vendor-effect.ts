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
import { dirname, isAbsolute, join, relative } from "node:path";
import { spawnSync } from "bun";

const repository = "https://github.com/Effect-TS/effect.git";
const destination = "repos/effect";

function warn(message: string): void {
  console.warn(`vendor-effect: ${message}`);
}

function hasEffectDependency(manifest: unknown): boolean {
  if (typeof manifest !== "object" || manifest === null) return false;
  for (const key of ["dependencies", "devDependencies"] as const) {
    if (!(key in manifest)) continue;
    const dependencies = manifest[key];
    if (typeof dependencies === "object" && dependencies !== null && "effect" in dependencies) {
      return true;
    }
  }
  return false;
}

function installedEffectVersion(): string | null {
  const root = process.cwd();
  const workspaceManifests = new Bun.Glob("{packages,apps}/*/package.json");
  const manifests = [
    join(root, "package.json"),
    ...workspaceManifests.scanSync({ cwd: root, absolute: true }).toArray().sort(),
  ];
  let installedVersion: string | null = null;

  for (const workspaceManifest of manifests) {
    const workspace: unknown = JSON.parse(readFileSync(workspaceManifest, "utf8"));
    if (!hasEffectDependency(workspace)) continue;

    let manifest: unknown;
    try {
      const manifestPath = Bun.resolveSync("effect/package.json", dirname(workspaceManifest));
      const relativeManifestPath = relative(root, manifestPath);
      if (
        relativeManifestPath === ".." ||
        relativeManifestPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(relativeManifestPath)
      ) {
        throw new Error(`effect resolved outside the workspace from ${workspaceManifest}`);
      }
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (cause) {
      throw new Error(
        `${workspaceManifest} declares effect but its installation cannot be resolved`,
        { cause },
      );
    }

    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("version" in manifest) ||
      typeof manifest.version !== "string"
    ) {
      throw new Error(`effect/package.json resolved from ${workspaceManifest} has no version`);
    }
    if (installedVersion !== null && installedVersion !== manifest.version) {
      throw new Error(`mixed Effect versions: ${installedVersion} and ${manifest.version}`);
    }
    installedVersion = manifest.version;
  }

  return installedVersion;
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
    ["git", "clone", "--depth", "1", "--branch", tag, "--single-branch", repository, staging],
    { stdout: "inherit", stderr: "pipe" },
  );

  if (clone.exitCode !== 0) {
    rmSync(staging, { recursive: true, force: true });
    warn(`could not clone ${tag}; skipping vendored source`);
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

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function pathKind(path: string): "missing" | "symlink" | "other" {
  try {
    return lstatSync(path).isSymbolicLink() ? "symlink" : "other";
  } catch (error) {
    if (isEnoent(error)) return "missing";
    throw error;
  }
}

function linkWorktree(cacheDir: string): boolean {
  const kind = pathKind(destination);
  if (kind === "symlink") {
    let target: string | null;
    try {
      target = realpathSync(destination);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      target = null;
    }
    if (target !== null && target === realpathSync(cacheDir)) return true;
    unlinkSync(destination);
  } else if (kind === "other") {
    warn(`refusing to replace non-symlink path ${destination}`);
    return false;
  }

  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(cacheDir, destination, process.platform === "win32" ? "junction" : "dir");
  console.log(`vendor-effect: linked ${destination} -> ${cacheDir}`);
  return true;
}

const version = installedEffectVersion();
if (version === null) {
  warn("effect is not declared in the root or a workspace; skipping vendored source");
  process.exit(0);
}

const tag = `effect@${version}`;
const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
const cacheDir = join(cacheRoot, "pico", "vendors", tag);

if (!populateCache(tag, cacheDir) || !linkWorktree(cacheDir)) process.exit(1);
if (!existsSync(join(destination, "LLMS.md"))) {
  warn(`${destination}/LLMS.md is missing for ${tag}`);
  process.exit(1);
}
