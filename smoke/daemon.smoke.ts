import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { PicoRoot } from "@pico/contract/config";
import * as Daemon from "@pico/daemon";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const smoke = Effect.fn("Daemon.smoke")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-daemon-smoke-" });
  const canonicalRoot = yield* fileSystem.realPath(root);
  const lockFile = path.join(canonicalRoot, ".pico.lock");
  const storeFile = path.join(canonicalRoot, "store.db");
  const sessionsDir = path.join(canonicalRoot, "sessions");
  const logsDir = path.join(canonicalRoot, "logs");
  const schedulesDir = path.join(canonicalRoot, "schedules");

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Daemon.open(PicoRoot.make(canonicalRoot));

      for (const expected of [lockFile, storeFile, sessionsDir, logsDir, schedulesDir]) {
        assert.isTrue(yield* fileSystem.exists(expected), `Missing ${expected}`);
      }
      for (const child of ["enabled", "disabled", "runs", ".staging"]) {
        assert.isTrue(
          yield* fileSystem.exists(path.join(schedulesDir, child)),
          `Missing schedule directory ${child}`,
        );
      }
    }),
  );

  assert.isFalse(yield* fileSystem.exists(lockFile), "Root lock remains after scope closure");
});

describe("daemon library", () => {
  it.effect("owns one root for its scope lifetime", () =>
    smoke().pipe(Effect.provide(BunServices.layer), Effect.scoped),
  );
});
