import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";

const fixturePath = Bun.fileURLToPath(new URL("./session-settings.fixture.ts", import.meta.url));

it("discovers bundled and custom skills repeatedly, with custom names taking precedence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-omp-discovery-")));
  try {
    // OMP captures home and cache paths at import time, before settings are loaded.
    const result = Bun.spawnSync({
      cmd: [process.execPath, fixturePath],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "home", ".omp", "agent"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });

    assert.strictEqual(result.exitCode, 0, result.stderr.toString());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
