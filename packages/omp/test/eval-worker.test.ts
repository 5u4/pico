import { assert, it } from "@effect/vitest";
import { evalWorkerScenarios } from "./eval-worker-scenarios.ts";

const fixturePath = Bun.fileURLToPath(new URL("./fixtures/eval-worker.ts", import.meta.url));

for (const [scenario, description] of evalWorkerScenarios) {
  it(description, () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, fixturePath, scenario],
      env: { PATH: process.env.PATH ?? "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    assert.strictEqual(result.exitCode, 0, `${scenario}\n${result.stdout}\n${result.stderr}`);
  });
}
