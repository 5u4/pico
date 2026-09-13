import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserKey } from "../../omp/src/browser-cli.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const installer = fileURLToPath(new URL("../../omp/src/browser-install.ts", import.meta.url));
const launcher = fileURLToPath(new URL("../../omp/src/browser-cli.ts", import.meta.url));

export const installDiagnostic = "ENOSPC: free disk space before installing Chrome";

export const runInstallFixture = async (mode: "failure" | "success") => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pico-cli-install-")));
  const root = join(directory, "root");
  const dependencies = join(directory, "node_modules");
  const omp = join(dependencies, "@pico", "omp");
  const browser = join(dependencies, "agent-browser");
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await Promise.all([
      mkdir(omp, { recursive: true }),
      mkdir(join(browser, "bin"), { recursive: true }),
      mkdir(join(directory, "home")),
    ]);
    for (const name of [
      "@effect/platform-bun",
      "@oh-my-pi/pi-utils",
      "@pico/contract",
      "@pico/daemon",
      "effect",
    ]) {
      const target = join(dependencies, name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(join(dirname(dirname(main)), "node_modules", name), target, "dir");
    }
    await Promise.all([
      copyFile(main, join(directory, "main.ts")),
      copyFile(join(dirname(main), "runtime.ts"), join(directory, "runtime.ts")),
      copyFile(installer, join(omp, "browser-install.ts")),
      copyFile(launcher, join(omp, "browser-cli.ts")),
      writeFile(
        join(omp, "package.json"),
        JSON.stringify({
          name: "@pico/omp",
          type: "module",
          exports: { "./browser-install": "./browser-install.ts" },
        }),
      ),
      writeFile(join(browser, "package.json"), '{"name":"agent-browser","type":"module"}'),
      writeFile(
        join(browser, "bin", "agent-browser.js"),
        `import assert from "node:assert/strict";
assert.equal(process.argv.at(-1), "install");
assert.equal(process.env.HOME, ${JSON.stringify(join(root, "browser", "home"))});
${mode === "failure" ? `process.stderr.write(${JSON.stringify(`\u001b[2J${installDiagnostic}\r\u001b]52;c;dW5zYWZl\u0007\u202e\n`)}); process.exit(27);` : "process.exit(0);"}
`,
      ),
    ]);
    child = Bun.spawn({
      cmd: [process.execPath, join(directory, "main.ts"), "browser", "install", root],
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: join(directory, "home"),
        NO_COLOR: "1",
        BUN_OPTIONS: "--no-env-file",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(
      join(
        process.platform === "win32" ? join(root, "browser") : "/tmp",
        `pico-browser-${process.getuid?.() ?? "user"}`,
        "namespaces",
        browserKey(root).slice(0, 16),
      ),
      { recursive: true, force: true },
    );
    await rm(directory, { recursive: true, force: true });
  }
};
