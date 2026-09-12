#!/usr/bin/env bun
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { evalWorkerScenarios } from "../packages/omp/test/eval-worker-scenarios.ts";

const packageName = "@oh-my-pi/pi-coding-agent";
const repository = Bun.fileURLToPath(new URL("../", import.meta.url));
const exactVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function requestedVersion(): string {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error("Usage: bun scripts/check-omp-eval.ts [exact-version]");
  let version = args[0];
  if (version === undefined) {
    const manifest: unknown = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      !("workspaces" in manifest) ||
      typeof manifest.workspaces !== "object" ||
      manifest.workspaces === null ||
      !("catalog" in manifest.workspaces) ||
      typeof manifest.workspaces.catalog !== "object" ||
      manifest.workspaces.catalog === null ||
      !(packageName in manifest.workspaces.catalog) ||
      typeof manifest.workspaces.catalog[packageName] !== "string"
    ) {
      throw new Error(
        `Root package.json has no workspaces.catalog[${JSON.stringify(packageName)}] version`,
      );
    }
    version = manifest.workspaces.catalog[packageName];
  }
  if (exactVersion.exec(version)?.[0] !== version) {
    throw new Error(
      `Expected an exact semver version, not a range, tag, URL or command: ${JSON.stringify(version)}`,
    );
  }
  return version;
}

function reportFailure(result: Bun.SyncSubprocess<"pipe", "pipe">): void {
  console.error(
    `exit=${result.exitCode} signal=${result.signalCode ?? "none"} ` +
      `timeout=${result.exitedDueToTimeout ?? false} output-limit=${result.exitedDueToMaxBuffer ?? false}`,
  );
  if (result.stdout.byteLength > 0) process.stderr.write(result.stdout);
  if (result.stderr.byteLength > 0) process.stderr.write(result.stderr);
}

function checkVersion(version: string): number {
  const tempBase = realpathSync(tmpdir());
  const fromRepository = relative(realpathSync(repository), tempBase);
  if (
    fromRepository === "" ||
    (fromRepository !== ".." &&
      !fromRepository.startsWith(`..${sep}`) &&
      !isAbsolute(fromRepository))
  ) {
    throw new Error("The system temporary directory must be outside this checkout");
  }
  const root = mkdtempSync(join(tempBase, "pico-omp-upstream-"));
  let failures = 0;
  try {
    const home = join(root, "home");
    const scratch = join(root, "tmp");
    const agentDirectory = join(home, ".omp", "agent");
    for (const directory of [home, scratch, agentDirectory])
      mkdirSync(directory, { recursive: true });
    const environment = {
      PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
      HOME: home,
      PI_CODING_AGENT_DIR: agentDirectory,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      BUN_INSTALL: join(home, ".bun"),
      BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
      NPM_CONFIG_USERCONFIG: join(root, ".npmrc"),
      NPM_CONFIG_GLOBALCONFIG: join(root, ".npmrc"),
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      CI: "1",
      NO_COLOR: "1",
      DO_NOT_TRACK: "1",
    };
    writeFileSync(join(root, ".npmrc"), "");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "pico-omp-upstream-check",
        private: true,
        type: "module",
        dependencies: { [packageName]: version },
      }),
    );
    console.log(`Installing pristine ${packageName}@${version} with Bun ${Bun.version}`);
    const installation = Bun.spawnSync({
      cmd: [
        process.execPath,
        "install",
        "--ignore-scripts",
        "--no-progress",
        "--registry",
        "https://registry.npmjs.org",
      ],
      cwd: root,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (!installation.success) {
      reportFailure(installation);
      throw new Error(
        `Pristine installation failed for ${packageName}@${version}; no regression conclusion`,
      );
    }
    const installed: unknown = JSON.parse(
      readFileSync(join(root, "node_modules", packageName, "package.json"), "utf8"),
    );
    if (
      typeof installed !== "object" ||
      installed === null ||
      !("version" in installed) ||
      installed.version !== version
    ) {
      throw new Error(`Installed package does not match requested ${packageName}@${version}`);
    }
    const fixture = join(root, "eval-worker.ts");
    copyFileSync(
      join(repository, "packages", "omp", "test", "fixtures", "eval-worker.ts"),
      fixture,
    );
    for (const [scenario, description] of evalWorkerScenarios) {
      try {
        const result = Bun.spawnSync({
          cmd: [process.execPath, "--no-install", fixture, scenario],
          cwd: root,
          env: environment,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
        });
        if (
          result.success &&
          result.stdout.includes(`${JSON.stringify({ scenario, result: "passed" })}\n`)
        ) {
          console.log(`PASS ${scenario}: ${description}`);
        } else {
          failures++;
          console.error(`FAIL ${scenario}: ${description}`);
          reportFailure(result);
          if (result.success) console.error("Fixture exited without its completion marker");
        }
      } catch (cause) {
        failures++;
        console.error(`FAIL ${scenario}: ${description}`);
        console.error(cause);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const passed = evalWorkerScenarios.length - failures;
  console.log(
    `Tested pristine ${packageName}@${version}: ${passed}/${evalWorkerScenarios.length} scenarios passed`,
  );
  if (failures > 0) {
    console.error(
      "Patch removal is NOT established. Failures may be regressions, module/API incompatibilities or execution errors; they do not by themselves confirm the original hang.",
    );
    return 1;
  }
  console.log(
    "Candidate meets this regression contract. This does not prove absolute safety or identify an upstream fix commit.",
  );
  return 0;
}

try {
  const version = requestedVersion();
  try {
    process.exitCode = checkVersion(version);
  } catch (cause) {
    console.error(`INCONCLUSIVE ${packageName}@${version}: setup or cleanup failed`);
    console.error(cause);
    console.error(
      "Patch removal is NOT established; this is not confirmation of the original hang.",
    );
    process.exitCode = 2;
  }
} catch (cause) {
  console.error(cause);
  process.exitCode = 2;
}
