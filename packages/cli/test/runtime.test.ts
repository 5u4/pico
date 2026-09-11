import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { assert, describe, it } from "@effect/vitest";

const fixturePath = Bun.fileURLToPath(new URL("./runtime.fixture.ts", import.meta.url));
const mainPath = Bun.fileURLToPath(new URL("../src/main.ts", import.meta.url));

const pump = async (
  stream: ReadableStream<Uint8Array>,
  append: (chunk: string) => void,
): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    append(decoder.decode(result.value, { stream: true }));
  }

  append(decoder.decode());
};

const spawnChild = (script: string, args: ReadonlyArray<string>) => {
  let stdout = "";
  let stderr = "";
  const child = Bun.spawn({
    cmd: [process.execPath, script, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const drained = Promise.all([
    pump(child.stdout, (chunk) => {
      stdout += chunk;
    }),
    pump(child.stderr, (chunk) => {
      stderr += chunk;
    }),
  ]).then(() => undefined);

  return {
    child,
    drained,
    output: () => ({ stdout, stderr }),
  };
};

type Spawned = ReturnType<typeof spawnChild>;

const withTimeout = <A>(promise: PromiseLike<A>, timeoutMs: number, label: string): Promise<A> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const waitForMarker = async (
  spawned: Spawned,
  marker: string,
  timeoutMs = 2_000,
): Promise<void> => {
  const attempts = Math.ceil(timeoutMs / 10);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const output = spawned.output();
    if (`${output.stdout}${output.stderr}`.includes(marker)) return;
    if (spawned.child.exitCode !== null) {
      throw new Error(
        `Child exited before ${marker}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      );
    }
    await Bun.sleep(10);
  }

  const output = spawned.output();
  throw new Error(
    `Timed out waiting for ${marker}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
  );
};

const finish = async (spawned: Spawned, timeoutMs = 2_000) => {
  const exitCode = await withTimeout(spawned.child.exited, timeoutMs, "child exit");
  await withTimeout(spawned.drained, timeoutMs, "child output");
  return { exitCode, ...spawned.output() };
};

const terminate = async (spawned: Spawned): Promise<void> => {
  if (spawned.child.exitCode === null) spawned.child.kill("SIGKILL");
  await withTimeout(spawned.child.exited, 2_000, "child cleanup");
  await withTimeout(spawned.drained, 2_000, "child output cleanup");
};

const spawnFixture = (mode: string) => spawnChild(fixturePath, [mode]);

const assertGracefulSignal = async (signal: "SIGINT" | "SIGTERM") => {
  const spawned = spawnFixture("graceful");
  try {
    await waitForMarker(spawned, "READY");
    spawned.child.kill(signal);
    const result = await finish(spawned);
    const stopping = `pico: stopping on ${signal}; send SIGINT or SIGTERM again to force exit`;

    assert.strictEqual(result.exitCode, signal === "SIGINT" ? 130 : 143, result.stderr);
    assert.include(result.stderr, stopping);
    assert.include(result.stderr, "FINALIZER_COMPLETED");
    assert.isBelow(result.stderr.indexOf(stopping), result.stderr.indexOf("FINALIZER_COMPLETED"));
  } finally {
    await terminate(spawned);
  }
};

describe("CLI foreground shutdown", () => {
  it("gracefully stops on SIGINT", () => assertGracefulSignal("SIGINT"));

  it("gracefully stops on SIGTERM", () => assertGracefulSignal("SIGTERM"));

  it("remembers SIGINT received during startup", async () => {
    const spawned = spawnFixture("startup-signal");
    try {
      const result = await finish(spawned);
      const stopping = "pico: stopping on SIGINT; send SIGINT or SIGTERM again to force exit";

      assert.strictEqual(result.exitCode, 130, result.stderr);
      assert.strictEqual(result.stderr.split(stopping).length - 1, 1, result.stderr);
      assert.include(result.stderr, "FINALIZER_COMPLETED");
    } finally {
      await terminate(spawned);
    }
  });

  it("forces exit through an active OMP process guard", async () => {
    const spawned = spawnFixture("guarded-hanging");
    try {
      await waitForMarker(spawned, "READY");
      spawned.child.kill("SIGINT");
      await waitForMarker(spawned, "FINALIZER_STARTED");
      spawned.child.kill("SIGTERM");
      const result = await finish(spawned);

      assert.strictEqual(result.exitCode, 130, result.stderr);
      assert.include(result.stderr, "pico: stopping on SIGINT");
      assert.include(result.stderr, "pico: received SIGTERM while stopping; forcing exit");
    } finally {
      await terminate(spawned);
    }
  });

  it("allows graceful finalization to complete", async () => {
    const spawned = spawnFixture("completing");
    try {
      await waitForMarker(spawned, "READY");
      spawned.child.kill("SIGINT");
      const result = await finish(spawned);

      assert.strictEqual(result.exitCode, 130, result.stderr);
      assert.include(result.stderr, "FINALIZER_COMPLETED");
    } finally {
      await terminate(spawned);
    }
  });

  it("cleans listeners for an immediately completed effect", async () => {
    const spawned = spawnFixture("immediate");
    try {
      const result = await finish(spawned);

      assert.strictEqual(result.exitCode, 0, result.stderr);
      assert.include(result.stdout, "LISTENERS_CLEAN");
    } finally {
      await terminate(spawned);
    }
  });

  it("preserves Effect teardown exit codes and error reporting", async () => {
    const spawned = spawnFixture("failure");
    try {
      const result = await finish(spawned);

      assert.strictEqual(result.exitCode, 23, result.stderr);
      assert.include(`${result.stdout}${result.stderr}`, "fixture failure");
    } finally {
      await terminate(spawned);
    }
  });

  it("removes the actual CLI lock when SIGINT immediately follows readiness", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "pico-cli-shutdown-"));
    const root = join(temporaryDirectory, "root");
    const lockFile = join(root, ".pico.lock");
    const spawned = spawnChild(mainPath, ["start", root]);

    try {
      await waitForMarker(spawned, "pico.daemon.ready", 15_000);
      spawned.child.kill("SIGINT");
      const result = await finish(spawned, 10_000);

      assert.strictEqual(result.exitCode, 130, result.stderr);
      assert.include(result.stderr, "pico: stopping on SIGINT");
      assert.isFalse(await Bun.file(lockFile).exists());
    } finally {
      await terminate(spawned);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
