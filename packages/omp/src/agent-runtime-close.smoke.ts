import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";

const fixturePath = Bun.fileURLToPath(
  new URL("../test/fixtures/runtime-close.ts", import.meta.url),
);

it("waits for both runtime close owners and preserves failures, defects, and interruption", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-runtime-close-")));
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", fixturePath],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        PI_CODING_AGENT_DIR: join(root, ".omp", "agent"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
