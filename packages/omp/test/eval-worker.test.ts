import { assert, it } from "@effect/vitest";

const reproPath = Bun.fileURLToPath(new URL("./repro/eval-hang.ts", import.meta.url));

it("reports real IPC bridge errors and recovers after awaiting them in the next cell", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, reproPath],
    env: { PATH: process.env.PATH ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  assert.strictEqual(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
});
