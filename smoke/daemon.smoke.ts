import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const smoke = Effect.fn("Daemon.smoke")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-daemon-smoke-" });
  const canonicalRoot = yield* fileSystem.realPath(root);
  const readiness = `pico.daemon.ready root=${canonicalRoot}`;
  const mainFile = path.join(process.cwd(), "apps/daemon/src/main.ts");
  let output = "";
  const diagnostics = () => `\nDaemon output:\n${output || "<empty>"}`;

  yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const handle = Bun.spawn([process.execPath, mainFile, canonicalRoot], {
        stdout: "pipe",
        stderr: "inherit",
      });
      const {
        promise: ready,
        resolve: resolveReady,
        reject: rejectReady,
      } = Promise.withResolvers<void>();
      const reader = handle.stdout.getReader();
      const decoder = new TextDecoder();
      let finished = false;
      const done = (async () => {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return;
            output += decoder.decode(chunk.value, { stream: true });
            if (output.includes(readiness)) resolveReady();
          }
        } catch (error) {
          rejectReady(error);
        } finally {
          finished = true;
          reader.releaseLock();
        }
      })();
      const closeOutput = async () => {
        if (!finished) await reader.cancel();
        await done;
      };
      return { handle, ready, closeOutput };
    }),
    (child) =>
      Effect.gen(function* () {
        const startup = yield* Effect.race(
          Effect.tryPromise(() => child.ready).pipe(Effect.as<"ready">("ready")),
          Effect.promise(() => child.handle.exited).pipe(Effect.map((exitCode) => ({ exitCode }))),
        ).pipe(Effect.timeout("30 seconds"));

        if (startup !== "ready") {
          assert.fail(
            `Daemon exited before readiness with code ${startup.exitCode}${diagnostics()}`,
          );
        }

        assert.isNull(child.handle.exitCode, `Daemon is not running${diagnostics()}`);

        const lockFile = path.join(canonicalRoot, ".pico.lock");
        const storeFile = path.join(canonicalRoot, "store.db");
        const sessionsDir = path.join(canonicalRoot, "sessions");
        const logsDir = path.join(canonicalRoot, "logs");
        for (const expected of [lockFile, storeFile, sessionsDir, logsDir]) {
          assert.isTrue(yield* fileSystem.exists(expected), `Missing ${expected}${diagnostics()}`);
        }

        yield* Effect.promise(() => Bun.sleep(1_000));
        child.handle.kill("SIGTERM");
        const exitCode = yield* Effect.promise(() => child.handle.exited);
        yield* Effect.tryPromise(() => child.closeOutput()).pipe(Effect.timeout("5 seconds"));

        assert.strictEqual(exitCode, 143, `Unexpected daemon exit code${diagnostics()}`);
        const lockReleased = yield* Effect.promise(async () => {
          for (let attempt = 0; attempt < 500; attempt++) {
            if (!(await Bun.file(lockFile).exists())) return true;
            await Bun.sleep(10);
          }
          return false;
        });
        assert.isTrue(lockReleased, `Root lock remains${diagnostics()}`);
      }),
    (child) =>
      Effect.sync(() => {
        if (child.handle.exitCode === null) child.handle.kill("SIGKILL");
      }),
  ).pipe(
    Effect.mapError(
      (error) =>
        new Error(`Daemon smoke failed: ${String(error)}${diagnostics()}`, { cause: error }),
    ),
  );
});

describe("daemon process", () => {
  it.effect("owns one root for its full process lifetime", () =>
    smoke().pipe(Effect.provide(BunServices.layer), Effect.scoped),
  );
});
