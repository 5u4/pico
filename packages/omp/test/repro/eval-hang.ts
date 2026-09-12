import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const originalCwd = process.cwd();
const root = await realpath(await mkdtemp(join(tmpdir(), "pico-eval-hang-")));
try {
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = join(root, "home", ".omp", "agent");
  delete process.env.PI_CONFIG_FILES;
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  process.chdir(root);

  const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const { executeInVmContext, disposeVmContextsByOwner } = await import(
    "@oh-my-pi/pi-coding-agent/eval/js/context-manager"
  );
  const session: ToolSession = {
    cwd: root,
    hasUI: false,
    getSessionFile: () => null,
    getSessionSpawns: () => null,
    settings: Settings.isolated({ "async.enabled": false }),
  };
  const output: unknown[] = [];
  const execute = (code: string) =>
    executeInVmContext({
      sessionKey: "eval-hang",
      sessionId: "eval-hang",
      ownerId: "eval-hang",
      cwd: root,
      session,
      code,
      filename: join(root, "eval-hang.ts"),
      runState: {
        signal: AbortSignal.timeout(8_000),
        onDisplay(value) {
          if (value.type === "json") output.push(value.data);
        },
      },
    });

  try {
    await assert.rejects(
      execute('comments = agent("review", { agent: "task" }); undefined;'),
      /async job manager; unavailable here/,
    );
    await assert.rejects(execute("await comments;"), /async job manager; unavailable here/);
    await execute("display({ recovered: 4 });");
    assert.deepEqual(output, [{ recovered: 4 }]);
  } finally {
    await disposeVmContextsByOwner("eval-hang");
  }
} finally {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ result: "passed" })}\n`);
