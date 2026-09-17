import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

const fixturePath = Bun.fileURLToPath(new URL("./runtime.fixture.ts", import.meta.url));
const mainPath = Bun.fileURLToPath(new URL("../src/main.ts", import.meta.url));
const cliDirectory = Bun.fileURLToPath(new URL("../", import.meta.url));

const decodeLog = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      level: Schema.String,
      cause: Schema.optionalKey(Schema.String),
      annotations: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);

const readLogs = async (root: string) => {
  const directory = join(root, "logs");
  const files = (await readdir(directory)).filter((file) =>
    /^pico-\d{4}-\d{2}-\d{2}\.log$/.test(file),
  );
  const contents = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
  return contents.flatMap((content) => content.trim().split("\n").filter(Boolean).map(decodeLog));
};

const consoleErrors = (result: { readonly stdout: string; readonly stderr: string }) =>
  `${result.stdout}\n${result.stderr}`.match(/^\[[^\r\n]*\] ERROR \(#\d+\)/gm)?.length ?? 0;

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
  timeoutMs = 5_000,
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
      assert.strictEqual(consoleErrors(result), 1);
    } finally {
      await terminate(spawned);
    }
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "releases the root lock when the linked pico receives terminal Ctrl-C",
    async () => {
      const temporaryDirectory = await mkdtemp(join(tmpdir(), "pico-cli-shutdown-"));
      try {
        const bin = join(temporaryDirectory, "bun", "bin");
        const root = join(temporaryDirectory, "root");
        const lockFile = join(root, ".pico.lock");
        const env = {
          HOME: join(temporaryDirectory, "home"),
          BUN_INSTALL: join(temporaryDirectory, "bun"),
          BUN_INSTALL_GLOBAL_DIR: join(temporaryDirectory, "bun", "install", "global"),
          BUN_INSTALL_BIN: bin,
          BUN_INSTALL_CACHE_DIR: join(temporaryDirectory, "bun", "install", "cache"),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(temporaryDirectory, "bun", "transpiler-cache"),
          BUN_OPTIONS: "--no-env-file",
          TMPDIR: join(temporaryDirectory, "tmp"),
          PATH: `${bin}:/usr/bin:/bin`,
          TERM: "xterm-256color",
        };
        await Promise.all(
          [
            env.HOME,
            env.BUN_INSTALL_GLOBAL_DIR,
            bin,
            env.BUN_INSTALL_CACHE_DIR,
            env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
            env.TMPDIR,
            root,
          ].map((directory) => mkdir(directory, { recursive: true })),
        );
        await writeFile(join(root, "config.toml"), "[web]\nport = 0\n");
        await symlink(process.execPath, join(bin, "bun"));
        const linked = Bun.spawnSync({
          cmd: [process.execPath, "link"],
          cwd: cliDirectory,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
          killSignal: "SIGKILL",
        });
        assert.isTrue(linked.success, `bun link failed\n${linked.stderr.toString()}`);

        let transcript = "";
        const decoder = new TextDecoder();
        const child = Bun.spawn({
          cmd: [join(bin, "pico"), "start", root],
          cwd: temporaryDirectory,
          env,
          // Bun 1.3.14 assigns the controlling PTY only for inline terminal options.
          terminal: {
            data(_terminal, data) {
              transcript += decoder.decode(data, { stream: true });
            },
          },
        });
        await using terminal = child.terminal;
        try {
          if (!terminal) throw new Error("Linked pico has no terminal");
          const deadline = performance.now() + 15_000;
          while (!transcript.includes("pico.daemon.ready")) {
            if (child.exitCode !== null) {
              throw new Error(`Linked pico exited before readiness\n${transcript}`);
            }
            if (performance.now() >= deadline) {
              throw new Error(`Timed out waiting for linked pico readiness\n${transcript}`);
            }
            await Bun.sleep(10);
          }

          assert.isTrue(await Bun.file(lockFile).exists(), transcript);
          terminal.write("\x03");
          const exitCode = await withTimeout(child.exited, 10_000, "linked pico exit");
          assert.strictEqual(exitCode, 130, transcript);
          assert.isFalse(await Bun.file(lockFile).exists(), transcript);
          assert.include(transcript, "pico: stopping on SIGINT");
          assert.notInclude(transcript, "forcing exit");
          assert.strictEqual(consoleErrors({ stdout: transcript, stderr: "" }), 0);
          const logs = await readLogs(root);
          assert.deepStrictEqual(
            logs.filter((entry) => entry.level === "ERROR"),
            [],
          );
          assert.strictEqual(
            logs.find((entry) => entry.annotations.phase === "ready")?.annotations.operation,
            "run",
          );
          for (const entry of logs) {
            assert.notProperty(entry.annotations, "root");
            assert.notInclude(JSON.stringify(entry.annotations), root);
          }
        } finally {
          if (child.exitCode === null) child.kill("SIGKILL");
          await withTimeout(child.exited, 2_000, "linked pico cleanup");
        }
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
    45_000,
  );

  it("reports logger acquisition failure to console and releases the root", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "pico-cli-logger-"));
    const root = join(temporaryDirectory, "root");
    await mkdir(root);
    await writeFile(join(root, "logs"), "");
    const spawned = spawnChild(mainPath, ["start", root]);
    try {
      const result = await finish(spawned, 15_000);
      assert.notStrictEqual(result.exitCode, 0);
      assert.strictEqual(consoleErrors(result), 1);
      assert.isFalse(await Bun.file(join(root, ".pico.lock")).exists());
    } finally {
      await terminate(spawned);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("leaves reusable daemon failure reporting to its caller", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "pico-cli-reusable-"));
    const root = join(temporaryDirectory, "root");
    await mkdir(join(root, "store.db"), { recursive: true });
    const spawned = spawnChild(fixturePath, ["reusable-failure", root]);
    try {
      const result = await finish(spawned, 15_000);
      assert.notStrictEqual(result.exitCode, 0);
      assert.strictEqual(consoleErrors(result), 1);
      assert.deepStrictEqual(
        (await readLogs(root)).filter((entry) => entry.level === "ERROR"),
        [],
      );
      assert.isFalse(await Bun.file(join(root, ".pico.lock")).exists());
    } finally {
      await terminate(spawned);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("flushes the actual CLI startup failure before releasing its logger", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "pico-cli-startup-"));
    const root = join(temporaryDirectory, "root");
    await mkdir(join(root, "store.db"), { recursive: true });
    const spawned = spawnChild(mainPath, ["start", root]);
    try {
      const result = await finish(spawned, 15_000);
      const logs = await readLogs(root);
      const failures = logs.filter((entry) => entry.level === "ERROR");
      assert.notStrictEqual(result.exitCode, 0);
      assert.strictEqual(consoleErrors(result), 1);
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(failures[0]?.annotations.operation, "run");
      assert.strictEqual(failures[0]?.annotations.phase, "startup");
      assert.include(failures[0]?.cause ?? "", "PersistenceError");
      for (const entry of logs) {
        assert.notProperty(entry.annotations, "root");
        assert.notInclude(JSON.stringify(entry.annotations), root);
      }
      assert.isFalse(await Bun.file(join(root, ".pico.lock")).exists());
    } finally {
      await terminate(spawned);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  for (const mode of [
    "daemon-finalizer-failure",
    "daemon-mixed-interruption",
    "daemon-external-interruption",
    "daemon-root-release-failure",
  ]) {
    it(`reports ${mode} once after resource finalization`, async () => {
      const temporaryDirectory = await mkdtemp(join(tmpdir(), "pico-cli-finalizer-"));
      const root = join(temporaryDirectory, "root");
      await mkdir(root);
      await writeFile(join(root, "config.toml"), "[web]\nport = 0\n");
      const spawned = spawnChild(fixturePath, [mode, root]);
      try {
        const result = await finish(spawned, 15_000);
        const failures = (await readLogs(root)).filter((entry) => entry.level === "ERROR");
        assert.notStrictEqual(result.exitCode, 0);
        assert.strictEqual(consoleErrors(result), 1);
        assert.strictEqual(failures.length, 1);
        assert.include(failures[0]?.cause ?? "", "ConfigError");
        assert.notInclude(JSON.stringify(failures), "private-filesystem-detail");
        assert.strictEqual(
          await Bun.file(join(root, ".pico.lock")).exists(),
          mode === "daemon-root-release-failure",
        );
      } finally {
        await terminate(spawned);
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    });
  }

  it("cleans the root without an error record when startup is interrupted", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "pico-cli-interrupt-"));
    const root = join(temporaryDirectory, "root");
    const spawned = spawnChild(fixturePath, ["daemon-startup-interruption", root]);
    try {
      const result = await finish(spawned, 15_000);
      assert.notStrictEqual(result.exitCode, 0);
      assert.strictEqual(consoleErrors(result), 0);
      assert.deepStrictEqual(
        (await readLogs(root)).filter((entry) => entry.level === "ERROR"),
        [],
      );
      assert.isFalse(await Bun.file(join(root, ".pico.lock")).exists());
    } finally {
      await terminate(spawned);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  for (const { args, code } of [
    { args: ["--help"], code: 0 },
    { args: ["start", "relative"], code: 1 },
  ]) {
    it(`preserves CLI rendering and exit code for ${args.join(" ")}`, async () => {
      const spawned = spawnChild(mainPath, args);
      try {
        const result = await finish(spawned, 15_000);
        assert.strictEqual(result.exitCode, code);
        assert.strictEqual(consoleErrors(result), 0);
      } finally {
        await terminate(spawned);
      }
    });
  }
});
