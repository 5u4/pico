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
  readRunDefinition,
  readRuns,
  runDirectory,
  writeArtifactString,
} from "./run-storage.ts";
import { make } from "./schedule.ts";
import {
  awaitExists,
  awaitFinished,
  caller,
  capturedRun,
  chatId,
  permissionDenied,
  platformLayer,
  prepareSource,
  resolveTarget,
  workspaceId,
} from "./schedule-test-fixtures.ts";
import type { Storage } from "./storage.ts";

const defaultScriptTarget = (target: Schedule.ScheduleTarget) =>
  Effect.succeed(
    target.kind === "chat"
      ? ({ kind: "existing-chat", workspaceId } satisfies Schedule.ScheduleScriptTarget)
      : ({
          kind: "workspace-chat",
          workspaceId: target.workspaceId,
        } satisfies Schedule.ScheduleScriptTarget),
  );

const resolveMaterializedTarget = (
  destination: Schedule.ScheduleRunDestination,
  cwd: AbsolutePath,
): Schedule.ResolvedScheduleRunTarget => ({
  chatId: destination.kind === "chat" ? destination.chatId : destination.newChatId,
  workspaceId: destination.kind === "chat" ? workspaceId : destination.workspaceId,
  cwd,
});

describe("run storage", () => {
  it.effect("migrates legacy snapshots once without rewriting history bytes", () =>
    Effect.gen(function* () {
      const { storage, run, definition, directory, source, lifecycleSource } =
        yield* prepareRunSnapshot("legacy");
      const { fileSystem, path } = storage;
      const snapshot = path.join(directory, "definition.json");
      const legacy = path.join(directory, "input", "definition.json");
      assert.deepStrictEqual(yield* readRunDefinition(storage, run), definition);
      assert.strictEqual(yield* fileSystem.readFileString(snapshot), source);
      assert.isFalse(yield* fileSystem.exists(legacy));
      yield* fileSystem.writeFileString(legacy, "new script output");
      assert.deepStrictEqual(yield* readRunDefinition(storage, run), definition);
      assert.strictEqual(yield* fileSystem.readFileString(legacy), "new script output");
      assert.strictEqual(yield* fileSystem.readFileString(snapshot), source);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(directory, "run.json")),
        lifecycleSource,
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("recovers a snapshot rename before marker commit without requiring input", () =>
    Effect.gen(function* () {
      const { storage, run, definition, directory, source, lifecycleSource } =
        yield* prepareRunSnapshot("legacy");
      const { fileSystem, path } = storage;
      const marker = path.join(directory, "snapshot-layout.json");
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          to === marker ? Effect.fail(permissionDenied("rename", to)) : fileSystem.rename(from, to),
      });
      const error = yield* readRunDefinition(
        { ...storage, fileSystem: failingFileSystem },
        run,
      ).pipe(Effect.flip);
      assert.strictEqual(error.kind, "io");
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(directory, "definition.json")),
        source,
      );
      assert.isFalse(yield* fileSystem.exists(marker));
      assert.isFalse(yield* fileSystem.exists(path.join(directory, "input", "definition.json")));
      yield* fileSystem.remove(path.join(directory, "input"), { recursive: true });
      assert.deepStrictEqual(yield* readRunDefinition(storage, run), definition);
      assert.deepStrictEqual(yield* readRunDefinition(storage, run), definition);
      assert.isTrue(yield* fileSystem.exists(marker));
      assert.isFalse(yield* fileSystem.exists(path.join(directory, "input")));
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(directory, "run.json")),
        lifecycleSource,
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("commits the layout marker before honoring interruption after migration rename", () =>
    Effect.gen(function* () {
      const { storage, run, directory, source } = yield* prepareRunSnapshot("legacy");
      const { fileSystem, path } = storage;
      const snapshot = path.join(directory, "definition.json");
      const renamed = yield* Deferred.make<void>();
      const releaseRename = yield* Deferred.make<void>();
      const heldFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          fileSystem
            .rename(from, to)
            .pipe(
              Effect.andThen(
                to === snapshot
                  ? Deferred.succeed(renamed, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseRename)),
                    )
                  : Effect.void,
              ),
            ),
      });
      const fiber = yield* readRunDefinition({ ...storage, fileSystem: heldFileSystem }, run).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(renamed);
      const interrupted = yield* Fiber.interrupt(fiber).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(releaseRename, undefined);
      yield* Fiber.join(interrupted);
      assert.isTrue(yield* fileSystem.exists(path.join(directory, "snapshot-layout.json")));
      assert.strictEqual(yield* fileSystem.readFileString(snapshot), source);
      assert.isFalse(yield* fileSystem.exists(path.join(directory, "input", "definition.json")));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect.each(["missing", "malformed", "wrong revision"])(
    "never consumes source artifacts when canonical metadata is %s",
    (failure) =>
      Effect.gen(function* () {
        const { storage, definition, directory, source } = yield* prepareRunSnapshot("run-root");
        const { fileSystem, path } = storage;
        const snapshot = path.join(directory, "definition.json");
        const artifact = path.join(directory, "input", "definition.json");
        yield* fileSystem.writeFileString(artifact, source);
        if (failure === "missing") {
          yield* fileSystem.remove(snapshot);
        } else {
          yield* fileSystem.writeFileString(
            snapshot,
            failure === "malformed"
              ? "script output"
              : JSON.stringify({
                  ...definition,
                  revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000055"),
                }),
          );
        }
        const schedules = yield* make(AbsolutePath.make(storage.schedulesDir), resolveTarget);
        const error = yield* schedules
          .start({
            scriptTarget: defaultScriptTarget,
            resolveTarget,
            materialize: () => Effect.die("Unexpected materialization"),
            deliver: () => Effect.die("Unexpected delivery"),
            publish: () => Effect.die("Unexpected publication"),
            runPrompt: () => Effect.die("Unexpected agent request"),
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.kind, failure === "missing" ? "io" : "corrupt");
        assert.strictEqual(yield* fileSystem.readFileString(artifact), source);
        assert.strictEqual(yield* fileSystem.exists(snapshot), failure !== "missing");
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects ambiguous unmarked snapshots even when their bytes match", () =>
    Effect.gen(function* () {
      const { storage, run, directory, source } = yield* prepareRunSnapshot("legacy");
      const { fileSystem, path } = storage;
      const snapshot = path.join(directory, "definition.json");
      const legacy = path.join(directory, "input", "definition.json");
      yield* fileSystem.writeFileString(snapshot, source);
      const error = yield* readRunDefinition(storage, run).pipe(Effect.flip);
      assert.strictEqual(error.kind, "corrupt");
      assert.strictEqual(yield* fileSystem.readFileString(snapshot), source);
      assert.strictEqual(yield* fileSystem.readFileString(legacy), source);
      assert.isFalse(yield* fileSystem.exists(path.join(directory, "snapshot-layout.json")));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect.each(["missing", "malformed", "wrong revision"])(
    "leaves %s legacy metadata unrepaired",
    (failure) =>
      Effect.gen(function* () {
        const { storage, run, definition, directory, lifecycleSource } =
          yield* prepareRunSnapshot("legacy");
        const { fileSystem, path } = storage;
        const legacy = path.join(directory, "input", "definition.json");
        const damaged =
          failure === "malformed"
            ? "script output"
            : JSON.stringify({
                ...definition,
                revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000055"),
              });
        if (failure === "missing") {
          yield* fileSystem.remove(legacy);
        } else {
          yield* fileSystem.writeFileString(legacy, damaged);
        }
        const error = yield* readRunDefinition(storage, run).pipe(Effect.flip);
        assert.strictEqual(error.kind, failure === "missing" ? "io" : "corrupt");
        if (failure !== "missing") {
          assert.strictEqual(yield* fileSystem.readFileString(legacy), damaged);
        }
        assert.isFalse(yield* fileSystem.exists(path.join(directory, "definition.json")));
        assert.isFalse(yield* fileSystem.exists(path.join(directory, "snapshot-layout.json")));
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "run.json")),
          lifecycleSource,
        );
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect.each([false, true])(
    "rejects snapshot and direct-parent symlinks without mutation, dangling=%s",
    (dangling) =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<{
          readonly layout: "legacy" | "run-root";
          readonly relative: string;
        }> = [
          { layout: "legacy", relative: "input/definition.json" },
          { layout: "legacy", relative: "input" },
          { layout: "run-root", relative: "definition.json" },
          { layout: "run-root", relative: "snapshot-layout.json" },
        ];
        for (const { layout, relative } of cases) {
          const { storage, run, directory } = yield* prepareRunSnapshot(layout);
          const { fileSystem, path } = storage;
          const asset = path.join(directory, relative);
          const outside = path.join(path.dirname(storage.schedulesDir), "outside");
          yield* fileSystem.rename(asset, outside);
          const protectedFile =
            relative === "input" ? path.join(outside, "definition.json") : outside;
          const bytes = yield* fileSystem.readFile(protectedFile);
          const target = dangling ? path.join(path.dirname(outside), "missing") : outside;
          yield* fileSystem.symlink(target, asset);
          const before = yield* fileSystem.readDirectory(directory);
          const error = yield* readRunDefinition(storage, run).pipe(Effect.flip);
          assert.strictEqual(error.kind, dangling ? "io" : "corrupt");
          assert.strictEqual(yield* fileSystem.readLink(asset), target);
          assert.deepStrictEqual(yield* fileSystem.readFile(protectedFile), bytes);
          assert.deepStrictEqual(yield* fileSystem.readDirectory(directory), before);
        }
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect.each(["definition.json", "snapshot-layout.json"])(
    "does not treat a dangling %s entry as absent during migration",
    (relative) =>
      Effect.gen(function* () {
        const { storage, run, directory, source } = yield* prepareRunSnapshot("legacy");
        const { fileSystem, path } = storage;
        const asset = path.join(directory, relative);
        const target = path.join(path.dirname(storage.schedulesDir), "missing");
        yield* fileSystem.symlink(target, asset);
        const before = yield* fileSystem.readDirectory(directory);
        const error = yield* readRunDefinition(storage, run).pipe(Effect.flip);
        assert.strictEqual(error.kind, relative === "definition.json" ? "corrupt" : "io");
        assert.strictEqual(yield* fileSystem.readLink(asset), target);
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "input", "definition.json")),
          source,
        );
        assert.deepStrictEqual(yield* fileSystem.readDirectory(directory), before);
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects an invalid layout marker without migrating source artifacts", () =>
    Effect.gen(function* () {
      const markerSource = '{"version":1,"layout":"legacy"}';
      const { storage, run, directory, source } = yield* prepareRunSnapshot("legacy");
      const { fileSystem, path } = storage;
      const marker = path.join(directory, "snapshot-layout.json");
      yield* fileSystem.writeFileString(marker, markerSource);
      const error = yield* readRunDefinition(storage, run).pipe(Effect.flip);
      assert.strictEqual(error.kind, "corrupt");
      assert.strictEqual(yield* fileSystem.readFileString(marker), markerSource);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(directory, "input", "definition.json")),
        source,
      );
      assert.isFalse(yield* fileSystem.exists(path.join(directory, "definition.json")));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

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
        version: 2,
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
        () => Effect.void,
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
      const schedules = yield* make(schedulesDir, resolveTarget);
      const host: Schedule.ScheduleRunHost = {
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: ({ destination }) =>
          Effect.succeed(resolveMaterializedTarget(destination, cwd)),
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
            return capturedRun(runId, "must not publish");
          }),
      };

      yield* TestClock.setTime(1_000);
      yield* schedules.start(host);
      const created = yield* schedules.create(caller, {
        name: "symlink defense",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
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
        version: 2,
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
        () => Effect.void,
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
  it.effect("decodes legacy running-script records with embedded target snapshots", () =>
    Effect.gen(function* () {
      const { storage, run, directory } = yield* prepareRunSnapshot("run-root");
      const legacy: unknown = {
        ...run,
        state: {
          kind: "running-script",
          startedAt: 1_010,
          target: { chatId, workspaceId, cwd: AbsolutePath.make("/private/legacy-cwd") },
        },
      };
      yield* storage.fileSystem.writeFileString(
        storage.path.join(directory, "run.json"),
        JSON.stringify(legacy),
      );
      const decoded = yield* readRuns(storage, run.scheduleId);
      assert.strictEqual(decoded.length, 1);
      const current = decoded[0];
      if (current === undefined) return yield* Effect.die("Expected one decoded run");
      assert.deepStrictEqual(current.state, { kind: "running-script", startedAt: 1_010 });
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});

const prepareRunSnapshot = Effect.fn("Schedules.test.prepareRunSnapshot")(function* (
  layout: "legacy" | "run-root",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-run-snapshot-" });
  const storage: Storage = {
    fileSystem,
    path,
    schedulesDir: path.join(root, "schedules"),
    temporaryId: () =>
      crypto.randomUUIDv7.pipe(
        Effect.mapError(
          (error) => new Schedule.ScheduleError({ kind: "io", message: error.message }),
        ),
      ),
  };
  const definition: Schedule.ScheduleDefinition = {
    version: 2,
    revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000051"),
    name: "historical snapshot",
    ownerWorkspaceId: workspaceId,
    createdByChatId: chatId,
    createdAt: 0,
    target: { kind: "chat", chatId },
    trigger: { kind: "once", at: 1_000 },
  };
  const run: Schedule.ScheduleRunLifecycle = {
    version: 1,
    id: Schedule.ScheduleRunId.make(`scheduled-1000-${definition.revision}`),
    scheduleId: Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000052"),
    definitionRevision: definition.revision,
    source: { kind: "scheduled", scheduledFor: 1_000 },
    plannedTarget: { kind: "existing-chat", ownerWorkspaceId: workspaceId, chatId },
    claimedAt: 1_000,
    state: { kind: "finished", finishedAt: 1_001, outcome: { kind: "skipped" } },
  };
  yield* bootstrap(storage);
  yield* publishRun(
    storage,
    run,
    definition,
    yield* prepareSource({ "prompt.md": "historical prompt" }),
    "snapshot-fixture",
    () => Effect.void,
  );
  const directory = runDirectory(storage, run.scheduleId, run.id);
  const source = `${JSON.stringify(
    {
      ...definition,
      version: 1,
      replyTarget: { platform: "discord", conversationId: "10", messageId: "11" },
    },
    null,
    2,
  )}\n`;
  const lifecycleSource = `${JSON.stringify(run, null, 2)}\n`;
  yield* fileSystem.writeFileString(path.join(directory, "definition.json"), source);
  yield* fileSystem.writeFileString(path.join(directory, "run.json"), lifecycleSource);
  if (layout === "legacy") {
    yield* fileSystem.rename(
      path.join(directory, "definition.json"),
      path.join(directory, "input", "definition.json"),
    );
    yield* fileSystem.remove(path.join(directory, "snapshot-layout.json"));
  }
  return { storage, run, definition, directory, source, lifecycleSource };
});
