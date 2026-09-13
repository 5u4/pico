import { assert, describe, it } from "@effect/vitest";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { bootstrap } from "./definition-storage.ts";
import {
  appendArtifactString,
  publishRun,
  readRuns,
  runDirectory,
  writeArtifactString,
} from "./run-storage.ts";
import { make } from "./schedule.ts";
import {
  awaitExists,
  awaitFinished,
  caller,
  chatId,
  platformLayer,
  prepareSource,
  workspaceId,
} from "./schedule-test-fixtures.ts";
import type { Storage } from "./storage.ts";

describe("run storage", () => {
  it.effect("rejects misplaced and tampered run identities", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-run-id-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () =>
          crypto.randomUUIDv7.pipe(
            Effect.mapError(
              (error) => new Schedule.ScheduleError({ kind: "io", message: error.message }),
            ),
          ),
      };
      const definition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000004"),
        name: "identity",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const run: Schedule.ScheduleRunLifecycle = {
        version: 1,
        id: Schedule.ScheduleRunId.make(`scheduled-1000-${definition.revision}`),
        scheduleId: Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000005"),
        definitionRevision: definition.revision,
        source: { kind: "scheduled", scheduledFor: 1_000 },
        plannedTarget: { kind: "existing-chat", ownerWorkspaceId: workspaceId, chatId },
        claimedAt: 1_000,
        state: { kind: "claimed" },
      };
      yield* bootstrap(storage);
      yield* publishRun(
        storage,
        run,
        definition,
        yield* prepareSource({ "prompt.md": "identity" }),
        "018f47a0-0000-7000-8000-000000000006",
        Effect.void,
      );
      assert.deepStrictEqual(yield* readRuns(storage), [run]);

      const runsRoot = path.join(schedulesDir, "runs");
      const scheduleDirectory = path.join(runsRoot, run.scheduleId);
      const otherScheduleId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000007");
      const misplacedScheduleDirectory = path.join(runsRoot, otherScheduleId);
      yield* fileSystem.rename(scheduleDirectory, misplacedScheduleDirectory);
      const misplacedSchedule = yield* readRuns(storage).pipe(Effect.flip);
      assert.strictEqual(misplacedSchedule.kind, "corrupt");
      yield* fileSystem.rename(misplacedScheduleDirectory, scheduleDirectory);

      const originalRunDirectory = runDirectory(storage, run.scheduleId, run.id);
      const otherRunId = Schedule.ScheduleRunId.make(`scheduled-2000-${definition.revision}`);
      const misplacedRunDirectory = runDirectory(storage, run.scheduleId, otherRunId);
      yield* fileSystem.rename(originalRunDirectory, misplacedRunDirectory);
      const misplacedRun = yield* readRuns(storage).pipe(Effect.flip);
      assert.strictEqual(misplacedRun.kind, "corrupt");
      yield* fileSystem.rename(misplacedRunDirectory, originalRunDirectory);

      yield* fileSystem.writeFileString(
        path.join(originalRunDirectory, "run.json"),
        JSON.stringify({ ...run, source: { kind: "scheduled", scheduledFor: 2_000 } }),
      );
      const tamperedRun = yield* readRuns(storage).pipe(Effect.flip);
      assert.strictEqual(tamperedRun.kind, "corrupt");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects symlinked metadata and append destinations", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-symlink-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const outside = path.join(root, "outside.txt");
      yield* fileSystem.writeFileString(outside, "unchanged");
      let scheduleId: Schedule.ScheduleId | undefined;
      const schedules = yield* make(schedulesDir);
      const host: Schedule.ScheduleRunHost = {
        prepare: (target) =>
          Effect.succeed({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
        deliver: () => Effect.void,
        publish: () => Effect.void,
        runPrompt: (_target, runId, _prompt, onEvent) =>
          Effect.gen(function* () {
            if (scheduleId === undefined) return yield* Effect.die("Schedule identity missing");
            const eventsFile = path.join(
              schedulesDir,
              "runs",
              scheduleId,
              runId,
              "omp",
              "events.jsonl",
            );
            yield* fileSystem.remove(eventsFile).pipe(Effect.orDie);
            yield* fileSystem.symlink(outside, eventsFile).pipe(Effect.orDie);
            yield* onEvent({ type: "run-started" });
            return {
              runId,
              outcome: "completed",
              events: [],
              finalAssistantText: "must not publish",
            };
          }),
      };

      yield* TestClock.setTime(1_000);
      yield* schedules.start(host);
      const created = yield* schedules.create(caller, {
        name: "symlink defense",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "capture" }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      scheduleId = created.id;
      yield* TestClock.adjust("30 seconds");
      const run = yield* awaitFinished(
        fileSystem,
        path.join(
          schedulesDir,
          "runs",
          created.id,
          `scheduled-1000-${created.definition.revision}`,
          "run.json",
        ),
      );
      assert.deepInclude(run.state.kind === "finished" ? run.state.outcome : {}, {
        kind: "failed",
        stage: "omp",
      });
      assert.strictEqual(yield* fileSystem.readFileString(outside), "unchanged");
      yield* awaitExists(fileSystem, path.join(schedulesDir, "disabled", created.id, "meta.json"));

      const metadata = path.join(schedulesDir, "disabled", created.id, "meta.json");
      const externalMetadata = path.join(root, "external-meta.json");
      yield* fileSystem.writeFileString(externalMetadata, JSON.stringify(created.definition));
      yield* fileSystem.remove(metadata);
      yield* fileSystem.symlink(externalMetadata, metadata);
      const listed = yield* schedules.list(caller);
      assert.deepStrictEqual(listed, []);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("keeps the canonical event log during an interrupted append", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-append-interrupt-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000047"),
      };
      yield* bootstrap(storage);
      const definition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000048"),
        name: "append interruption",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const run: Schedule.ScheduleRunLifecycle = {
        version: 1,
        id: Schedule.ScheduleRunId.make(`scheduled-1000-${definition.revision}`),
        scheduleId: Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000049"),
        definitionRevision: definition.revision,
        source: { kind: "scheduled", scheduledFor: 1_000 },
        plannedTarget: { kind: "existing-chat", ownerWorkspaceId: workspaceId, chatId },
        claimedAt: 1_000,
        state: { kind: "claimed" },
      };
      yield* publishRun(
        storage,
        run,
        definition,
        yield* prepareSource({ "prompt.md": "append" }),
        "018f47a0-0000-7000-8000-000000000050",
        Effect.void,
      );
      const original = `${JSON.stringify({ type: "run-started" })}\n`;
      yield* writeArtifactString(storage, run, "omp/events.jsonl", original);
      const eventsFile = path.join(
        runDirectory(storage, run.scheduleId, run.id),
        "omp",
        "events.jsonl",
      );
      const appendPrepared = yield* Deferred.make<void>();
      const holdAppend = yield* Deferred.make<void>();
      const interruptedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        copyFile: (from, to) =>
          fileSystem.copyFile(from, to).pipe(
            Effect.tap(() => Deferred.succeed(appendPrepared, undefined)),
            Effect.andThen(Deferred.await(holdAppend)),
          ),
        rename: (from, to) =>
          from === eventsFile && path.basename(to).endsWith(".append")
            ? fileSystem.rename(from, to).pipe(
                Effect.tap(() => Deferred.succeed(appendPrepared, undefined)),
                Effect.andThen(Deferred.await(holdAppend)),
              )
            : fileSystem.rename(from, to),
      });
      const fiber = yield* appendArtifactString(
        { ...storage, fileSystem: interruptedFileSystem },
        run,
        "omp/events.jsonl",
        `${JSON.stringify({ type: "run-finished", outcome: "completed" })}\n`,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(appendPrepared);
      yield* Fiber.interrupt(fiber);

      assert.strictEqual(yield* fileSystem.readFileString(eventsFile), original);
      assert.isFalse(
        (yield* fileSystem.readDirectory(path.dirname(eventsFile))).some((name) =>
          name.endsWith(".append"),
        ),
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
