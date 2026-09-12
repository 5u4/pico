import { assert, it } from "@effect/vitest";
import { evalWorkerScenarios } from "./eval-worker-scenarios.ts";

const fixturePath = Bun.fileURLToPath(new URL("./fixtures/eval-worker.ts", import.meta.url));
const reproPath = Bun.fileURLToPath(new URL("./repro/eval-hang.ts", import.meta.url));

function runFixture(path: string, ...args: string[]): void {
  const result = Bun.spawnSync({
    cmd: [process.execPath, path, ...args],
    env: { PATH: process.env.PATH ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  assert.strictEqual(
    result.exitCode,
    0,
    `${path} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
}

for (const [scenario, description] of evalWorkerScenarios) {
  it(description, () => runFixture(fixturePath, scenario));
}

it("reports real IPC bridge errors and recovers after awaiting them in the next cell", () => {
  runFixture(reproPath);
});

it("cancels a real IPC worker without losing another worker's state", () => {
  runFixture(reproPath, "isolation");
});
