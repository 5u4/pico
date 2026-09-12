import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const mode = process.argv[2];
assert.ok(mode === undefined || mode === "isolation", `Unknown IPC probe mode: ${mode}`);
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
  const cancellation = new AbortController();
  const execute = (owner: string, code: string, signal = AbortSignal.timeout(8_000)) =>
    executeInVmContext({
      sessionKey: owner,
      sessionId: owner,
      ownerId: owner,
      cwd: root,
      session,
      code,
      filename: join(root, `${owner}.ts`),
      runState: {
        signal,
        onDisplay(value) {
          if (value.type === "json") output.push(value.data);
        },
        onText(text) {
          if (text.includes("abort-ready")) cancellation.abort(new Error("probe cancellation"));
        },
      },
    });

  try {
    if (mode === "isolation") {
      await execute("ipc-B", "retained = 73; undefined;");
      await assert.rejects(
        execute("ipc-A", 'print("abort-ready"); await new Promise(() => {});', cancellation.signal),
        /probe cancellation/,
      );
      await execute("ipc-B", "display({ retained });");
      assert.deepEqual(output, [{ retained: 73 }]);
    } else {
      await assert.rejects(
        execute(
          "ipc-A",
          'comments = agent("review", { agent: "task" }); print("issued"); undefined;',
        ),
        /async job manager; unavailable here/,
      );
      await assert.rejects(
        execute("ipc-A", "await comments;"),
        /async job manager; unavailable here/,
      );
      await execute("ipc-A", "display({ recovered: 4 });");
      assert.deepEqual(output, [{ recovered: 4 }]);
    }
  } finally {
    await Promise.all([disposeVmContextsByOwner("ipc-A"), disposeVmContextsByOwner("ipc-B")]);
  }
} finally {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify({ result: "passed" })}\n`);
