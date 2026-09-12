import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";

const fixturePath = Bun.fileURLToPath(
  new URL("./fixtures/runtime-initialization.ts", import.meta.url),
);

describe("OMP extension runtime", () => {
  it("initializes each live session before use and keeps actions available through shutdown", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pico-omp-runtime-")));
    try {
      const child = Bun.spawn({
        cmd: [process.execPath, "--no-env-file", fixturePath],
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          PI_CODING_AGENT_DIR: join(root, ".omp", "agent"),
          PI_TEST_RUNTIME: "1",
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_CACHE_HOME: join(root, "cache"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
        killSignal: "SIGKILL",
      });
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        assert.strictEqual(exitCode, 0, `${stdout}\n${stderr}`);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
