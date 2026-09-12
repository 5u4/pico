import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { AbsolutePath } from "@pico/contract/path";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { layer } from "./layer.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const beforeMidnight = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-03-31T23:59:59.750Z"));
const afterMidnight = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-04-01T00:00:00.250Z"));
const decodeLogEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.String,
      level: Schema.String,
      timestamp: Schema.String,
    }),
  ),
);

describe("Logging.layer", () => {
  it.effect(
    "writes console and daily JSONL logs, prunes on UTC day changes, and flushes on scope close",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const picoRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-logging-" });
        const logsDir = AbsolutePath.make(path.join(picoRoot, "logs"));
        const expired = path.join(logsDir, "pico-2026-03-01.log");
        const cutoff = path.join(logsDir, "pico-2026-03-02.log");
        const malformed = path.join(logsDir, "pico-2026-02-30.log");
        const unrelated = path.join(logsDir, "daemon.log");
        const matchingDirectory = path.join(logsDir, "pico-2026-01-01.log");
        const symlinkTarget = path.join(logsDir, "symlink-target.log");
        const matchingSymlink = path.join(logsDir, "pico-2026-01-02.log");
        const firstLog = path.join(logsDir, "pico-2026-03-31.log");
        const secondLog = path.join(logsDir, "pico-2026-04-01.log");

        yield* TestClock.setTime(beforeMidnight);
        yield* fileSystem.makeDirectory(logsDir, { recursive: true });
        yield* fileSystem.writeFileString(expired, "expired\n");
        yield* fileSystem.writeFileString(cutoff, "cutoff\n");
        yield* fileSystem.writeFileString(malformed, "malformed\n");
        yield* fileSystem.writeFileString(unrelated, "unrelated\n");
        yield* fileSystem.makeDirectory(matchingDirectory);
        yield* fileSystem.writeFileString(symlinkTarget, "target\n");
        yield* fileSystem.symlink(symlinkTarget, matchingSymlink);

        yield* Effect.gen(function* () {
          assert.isFalse(yield* fileSystem.exists(expired));
          assert.strictEqual(yield* fileSystem.readFileString(cutoff), "cutoff\n");
          assert.strictEqual(yield* fileSystem.readFileString(malformed), "malformed\n");
          assert.strictEqual(yield* fileSystem.readFileString(unrelated), "unrelated\n");
          assert.strictEqual((yield* fileSystem.stat(matchingDirectory)).type, "Directory");
          assert.strictEqual(yield* fileSystem.readLink(matchingSymlink), symlinkTarget);

          yield* Effect.logInfo("before-midnight");
          yield* TestClock.setTime(afterMidnight);
          yield* Effect.logInfo("after-midnight");
        }).pipe(Effect.provide(layer(logsDir)), Effect.scoped);

        const firstEntry = decodeLogEntry(yield* fileSystem.readFileString(firstLog));
        const secondEntry = decodeLogEntry(yield* fileSystem.readFileString(secondLog));
        assert.deepInclude(firstEntry, {
          message: "before-midnight",
          level: "INFO",
          timestamp: "2026-03-31T23:59:59.750Z",
        });
        assert.deepInclude(secondEntry, {
          message: "after-midnight",
          level: "INFO",
          timestamp: "2026-04-01T00:00:00.250Z",
        });

        const consoleLines = (yield* TestConsole.logLines).map(String);
        assert.isTrue(consoleLines.some((line) => line.includes("before-midnight")));
        assert.isTrue(consoleLines.some((line) => line.includes("after-midnight")));

        assert.isFalse(yield* fileSystem.exists(cutoff));
        assert.strictEqual(yield* fileSystem.readFileString(malformed), "malformed\n");
        assert.strictEqual(yield* fileSystem.readFileString(unrelated), "unrelated\n");
        assert.strictEqual((yield* fileSystem.stat(matchingDirectory)).type, "Directory");
        assert.strictEqual(yield* fileSystem.readLink(matchingSymlink), symlinkTarget);
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("reports a failed file append once outside the failed sink", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const picoRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-logging-" });
      const logsDir = AbsolutePath.make(path.join(picoRoot, "logs"));
      yield* TestClock.setTime(beforeMidnight);
      const blockedFile = path.join(logsDir, "pico-2026-03-31.log");

      yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(blockedFile);
        yield* Effect.logInfo("append-probe");
      }).pipe(Effect.provide(layer(logsDir)), Effect.scoped);

      const errors = (yield* TestConsole.errorLines).map(String).join("\n");
      assert.strictEqual(errors.match(/pico\.logging\.failed/g)?.length, 1);
      assert.include(errors, "append");
      assert.strictEqual((yield* fileSystem.stat(blockedFile)).type, "Directory");
      assert.notInclude(
        (yield* TestConsole.logLines).map(String).join("\n"),
        "pico.logging.failed",
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("retries failed retention on the next same-day flush without losing log batches", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const picoRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-logging-" });
      const logsDir = AbsolutePath.make(path.join(picoRoot, "logs"));
      const expired = path.join(logsDir, "pico-2026-03-01.log");
      const pruneAttempted = yield* Deferred.make<void>();
      let retentionBlocked = true;
      yield* TestClock.setTime(beforeMidnight);

      yield* Effect.gen(function* () {
        yield* fileSystem.writeFileString(expired, "retained evidence");
        yield* TestClock.setTime(afterMidnight);
        yield* Effect.logInfo("retention-probe");
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(pruneAttempted);
        assert.strictEqual(yield* fileSystem.readFileString(expired), "retained evidence");
        retentionBlocked = false;
        yield* Effect.logInfo("retention-recovered");
      }).pipe(
        Effect.provide(layer(logsDir)),
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          remove: (file, options) =>
            file === expired && retentionBlocked
              ? Deferred.succeed(pruneAttempted, undefined).pipe(
                  Effect.andThen(
                    Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "remove",
                        description: "private-retention-detail",
                      }),
                    ),
                  ),
                )
              : fileSystem.remove(file, options),
        }),
        Effect.scoped,
      );

      const errors = (yield* TestConsole.errorLines).map(String).join("\n");
      assert.strictEqual(errors.match(/pico\.logging\.failed/g)?.length, 1);
      assert.include(errors, "prune");
      assert.notInclude(errors, "private-retention-detail");
      assert.isFalse(yield* fileSystem.exists(expired));
      const entries = (yield* fileSystem.readFileString(path.join(logsDir, "pico-2026-04-01.log")))
        .trimEnd()
        .split("\n")
        .map((line) => decodeLogEntry(line));
      assert.deepStrictEqual(
        entries.map((entry) => entry.message),
        ["retention-probe", "retention-recovered"],
      );
    }).pipe(Effect.provide(platformLayer)),
  );
});
