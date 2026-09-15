import { assert, describe, it } from "@effect/vitest";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  bootstrap,
  loadSchedule,
  moveDefinition,
  publishDefinition,
  updateDefinition,
} from "./definition-storage.ts";
import { publishRun, readRunDefinition, runDirectory } from "./run-storage.ts";
import { open } from "./schedule.ts";
import {
  caller,
  captureLogs,
  chatId,
  decodeDefinition,
  permissionDenied,
  platformLayer,
  prepareSource,
  resolveTarget,
  workspaceId,
} from "./schedule-test-fixtures.ts";
import type { Storage } from "./storage.ts";

describe("definition storage", () => {
  it.effect(
    "reads legacy metadata without writes and persists v2 on the next metadata revision",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-legacy-schedule-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir, resolveTarget);
        const sourceBytes = Uint8Array.from([0, 1, 255, 10]);
        const created = yield* schedules.create(caller, {
          name: "Legacy destination",
          enabled: false,
          target: { kind: "chat", chatId },
          trigger: { kind: "once", at: 1_000 },
          scriptTimeoutMs: 9_876,
          sourceDirectory: yield* prepareSource({
            "prompt.md": "Keep the destination.",
            "asset.bin": sourceBytes,
          }),
        });
        if (created.kind !== "ready") return yield* Effect.die("Schedule creation failed");
        const legacy = {
          ...created.definition,
          version: 1,
          replyTarget: { platform: "discord", conversationId: "10", messageId: "11" },
        };
        const legacySource = `${JSON.stringify(legacy, null, 2)}\n`;
        const storage: Storage = {
          fileSystem,
          path,
          schedulesDir,
          temporaryId: () => Effect.succeed("legacy-migration"),
        };
        const run: Schedule.ScheduleRunLifecycle = {
          version: 1,
          id: Schedule.ScheduleRunId.make(`scheduled-1000-${created.definition.revision}`),
          scheduleId: created.id,
          definitionRevision: created.definition.revision,
          source: { kind: "scheduled", scheduledFor: 1_000 },
          plannedTarget: { kind: "existing-chat", ownerWorkspaceId: workspaceId, chatId },
          claimedAt: 1_000,
          state: { kind: "claimed" },
        };
        yield* publishRun(
          storage,
          run,
          created.definition,
          created.sourceDirectory,
          "legacy-run",
          Effect.void,
        );
        const snapshotFile = path.join(
          runDirectory(storage, run.scheduleId, run.id),
          "input",
          "definition.json",
        );
        const metadataFile = path.join(created.sourceDirectory, "meta.json");
        yield* fileSystem.writeFileString(snapshotFile, legacySource);
        yield* fileSystem.writeFileString(metadataFile, legacySource);
        const loaded = yield* schedules.get(caller, created.id);
        assert.strictEqual(loaded.kind, "ready");
        if (loaded.kind !== "ready") return yield* Effect.die("Legacy metadata could not be read");
        assert.deepStrictEqual(loaded.definition, created.definition);
        assert.deepStrictEqual(yield* schedules.list(caller), [loaded]);
        assert.strictEqual(yield* fileSystem.readFileString(metadataFile), legacySource);
        assert.deepStrictEqual(yield* readRunDefinition(storage, run), created.definition);
        assert.strictEqual(yield* fileSystem.readFileString(snapshotFile), legacySource);

        const updated = yield* schedules.update(caller, created.id, {
          name: "Updated destination",
        });
        assert.strictEqual(updated.kind, "ready");
        if (updated.kind !== "ready")
          return yield* Effect.die("Legacy metadata could not be updated");
        assert.notStrictEqual(updated.definition.revision, created.definition.revision);
        assert.deepStrictEqual(updated, {
          ...loaded,
          definition: {
            ...created.definition,
            name: "Updated destination",
            revision: updated.definition.revision,
          },
        });
        const strictDefinition = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schedule.ScheduleDefinition),
          { onExcessProperty: "error" },
        );
        assert.deepStrictEqual(
          strictDefinition(yield* fileSystem.readFileString(metadataFile)),
          updated.definition,
        );
        assert.deepStrictEqual(yield* readRunDefinition(storage, run), created.definition);
        assert.strictEqual(yield* fileSystem.readFileString(snapshotFile), legacySource);
        for (const directory of [created.sourceDirectory, path.dirname(snapshotFile)]) {
          assert.strictEqual(
            yield* fileSystem.readFileString(path.join(directory, "prompt.md")),
            "Keep the destination.",
          );
          assert.deepStrictEqual(
            yield* fileSystem.readFile(path.join(directory, "asset.bin")),
            sourceBytes,
          );
        }
        yield* fileSystem.writeFileString(
          metadataFile,
          JSON.stringify({ ...legacy, unexpected: true }),
        );
        assert.strictEqual((yield* schedules.get(caller, created.id)).kind, "invalid");
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects a symlinked schedule root before writing through it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-root-" });
      const outside = path.join(root, "outside");
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.symlink(outside, schedulesDir);
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000040"),
      };

      const error = yield* bootstrap(storage).pipe(Effect.flip);
      assert.strictEqual(error.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), []);

      const childSchedulesDir = AbsolutePath.make(path.join(root, "child-schedules"));
      const childOutside = path.join(root, "child-outside");
      yield* fileSystem.makeDirectory(childSchedulesDir);
      yield* fileSystem.makeDirectory(childOutside);
      yield* fileSystem.symlink(childOutside, path.join(childSchedulesDir, "enabled"));
      const childError = yield* bootstrap({
        ...storage,
        schedulesDir: childSchedulesDir,
      }).pipe(Effect.flip);
      assert.strictEqual(childError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(childOutside), []);
      assert.deepStrictEqual(yield* fileSystem.readDirectory(childSchedulesDir), ["enabled"]);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects symlinked definition destination parents before publishing or updating", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-definition-root-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const outside = path.join(root, "outside");
      const sentinel = path.join(outside, "sentinel");
      const enabled = path.join(schedulesDir, "enabled");
      const retainedEnabled = path.join(root, "retained-enabled");
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000090"),
      };
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000091");
      const definition: Schedule.ScheduleDefinition = {
        version: 2,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000092"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const source = yield* prepareSource({ "prompt.md": "original" });
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.writeFileString(sentinel, "unchanged");
      yield* bootstrap(storage);

      yield* fileSystem.remove(enabled, { recursive: true });
      yield* fileSystem.symlink(outside, enabled);
      const createError = yield* publishDefinition(
        storage,
        id,
        "enabled",
        definition,
        source,
        "symlinked-create-parent",
      ).pipe(Effect.flip);
      assert.strictEqual(createError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);

      yield* fileSystem.remove(enabled);
      yield* fileSystem.makeDirectory(enabled, { mode: 0o700 });
      yield* publishDefinition(storage, id, "enabled", definition, source, "original");
      const current = yield* loadSchedule(storage, id);
      if (current === undefined) return yield* Effect.die("Published definition disappeared");
      const replacement: Schedule.ScheduleDefinition = {
        ...definition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000093"),
        name: "replacement",
      };
      const transaction = path.join(schedulesDir, ".staging", "update-symlinked-update-parent");
      const nextMetadata = path.join(transaction, "next.json");
      const swappedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (file, contents, options) =>
          fileSystem
            .writeFileString(file, contents, options)
            .pipe(
              Effect.tap(() =>
                file === nextMetadata
                  ? fileSystem
                      .rename(enabled, retainedEnabled)
                      .pipe(Effect.andThen(fileSystem.symlink(outside, enabled)))
                  : Effect.void,
              ),
            ),
      });
      const updateError = yield* updateDefinition(
        { ...storage, fileSystem: swappedFileSystem },
        current,
        replacement,
        "enabled",
        "symlinked-update-parent",
      ).pipe(Effect.flip);
      assert.strictEqual(updateError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      const retained = yield* decodeDefinition(
        yield* fileSystem.readFileString(path.join(retainedEnabled, id, "meta.json")),
      );
      assert.strictEqual(retained.revision, definition.revision);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects a symlinked state destination when moving a definition", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-move-root-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const outside = path.join(root, "outside");
      const sentinel = path.join(outside, "sentinel");
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000094"),
      };
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000095");
      const definition: Schedule.ScheduleDefinition = {
        version: 2,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000096"),
        name: "move destination",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.writeFileString(sentinel, "unchanged");
      yield* bootstrap(storage);
      yield* publishDefinition(
        storage,
        id,
        "enabled",
        definition,
        yield* prepareSource({ "prompt.md": "move me" }),
        "move-source",
      );
      const loaded = yield* loadSchedule(storage, id);
      if (loaded === undefined) return yield* Effect.die("Published definition disappeared");
      const disabled = path.join(schedulesDir, "disabled");
      yield* fileSystem.remove(disabled, { recursive: true });
      yield* fileSystem.symlink(outside, disabled);

      const error = yield* moveDefinition(storage, loaded, "disabled").pipe(Effect.flip);
      assert.strictEqual(error.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      assert.isTrue(yield* fileSystem.exists(path.join(schedulesDir, "enabled", id, "meta.json")));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("keeps metadata and source canonical when an update is interrupted during commit", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-update-interrupt-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000041"),
      };
      yield* bootstrap(storage);
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000042");
      const original: Schedule.ScheduleDefinition = {
        version: 2,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000043"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      yield* publishDefinition(
        storage,
        id,
        "enabled",
        original,
        yield* prepareSource({ "prompt.md": "original" }),
        "018f47a0-0000-7000-8000-000000000044",
      );
      const current = yield* loadSchedule(storage, id);
      if (current === undefined) return yield* Effect.die("Published definition disappeared");
      const replacement: Schedule.ScheduleDefinition = {
        ...original,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000045"),
        name: "replacement",
      };
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      const destination = path.join(schedulesDir, "disabled", id);
      const next = path.join(
        schedulesDir,
        ".staging",
        "update-018f47a0-0000-7000-8000-000000000046",
        "next.json",
      );
      const interruptedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          from === next && to === path.join(destination, "meta.json")
            ? Deferred.succeed(commitStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCommit)),
                Effect.andThen(fileSystem.rename(from, to)),
              )
            : fileSystem.rename(from, to),
      });
      const interruptedStorage: Storage = { ...storage, fileSystem: interruptedFileSystem };
      const fiber = yield* updateDefinition(
        interruptedStorage,
        current,
        replacement,
        "disabled",
        "018f47a0-0000-7000-8000-000000000046",
      ).pipe(Effect.forkChild);
      yield* Deferred.await(commitStarted);
      assert.deepStrictEqual(
        yield* decodeDefinition(
          yield* fileSystem.readFileString(path.join(destination, "meta.json")),
        ),
        original,
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(destination, "prompt.md")),
        "original",
      );
      const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(interruption);

      const loaded = yield* loadSchedule(storage, id);
      assert.strictEqual(loaded?.view.kind, "ready");
      if (loaded?.view.kind !== "ready") return;
      assert.strictEqual(loaded.view.definition.revision, replacement.revision);
      assert.strictEqual(loaded.view.definition.name, "replacement");
      assert.strictEqual(loaded.view.state, "disabled");
      assert.strictEqual(loaded.view.sourceDirectory, destination);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(destination, "prompt.md")),
        "original",
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "retains a committed metadata update when cleanup fails and recovers it on restart",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-update-cleanup-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const staging = path.join(schedulesDir, ".staging");
        const logs = yield* captureLogs();
        let retainedTransaction: string | undefined;
        const failingFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          remove: (file, options) => {
            if (path.dirname(file) !== staging || !path.basename(file).startsWith("update-")) {
              return fileSystem.remove(file, options);
            }
            retainedTransaction = file;
            return Effect.fail(permissionDenied("remove", "private cleanup cause"));
          },
        });
        const schedules = yield* open(schedulesDir, resolveTarget).pipe(
          Effect.provideService(FileSystem.FileSystem, failingFileSystem),
        );
        const created = yield* schedules.create(caller, {
          name: "private original",
          enabled: false,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 10_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "private original prompt" }),
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        const updated = yield* schedules
          .update(caller, created.id, {
            name: "private updated",
            enabled: true,
            trigger: { kind: "once", at: 20_000 },
          })
          .pipe(Effect.provide(logs.layer));
        assert.strictEqual(updated.kind, "ready");
        if (updated.kind !== "ready") return;
        assert.notStrictEqual(updated.definition.revision, created.definition.revision);
        assert.strictEqual(updated.definition.name, "private updated");
        assert.deepStrictEqual(yield* schedules.list(caller), [updated]);
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(updated.sourceDirectory, "prompt.md")),
          "private original prompt",
        );
        if (retainedTransaction === undefined) {
          return yield* Effect.die("Update cleanup was not attempted");
        }
        assert.isTrue(yield* fileSystem.exists(path.join(retainedTransaction, "transaction.json")));
        const errors = logs.entries.filter((entry) => entry.level === "Error");
        assert.strictEqual(errors.length, 1);
        assert.deepInclude(errors[0]?.annotations, {
          component: "schedule",
          operation: "update",
          phase: "cleanup",
          scheduleId: created.id,
          definitionRevision: updated.definition.revision,
          category: "io",
        });
        assert.notInclude(JSON.stringify(logs.entries), "private");
        assert.notInclude(JSON.stringify(logs.entries), root);
        const latest = yield* schedules.update(caller, created.id, { name: "latest" });
        assert.strictEqual(latest.kind, "ready");
        if (latest.kind !== "ready") return;
        assert.strictEqual(latest.state, "enabled");
        const restarted = yield* open(schedulesDir, resolveTarget);
        assert.deepStrictEqual(yield* restarted.get(caller, created.id), latest);
        assert.isFalse(yield* fileSystem.exists(retainedTransaction));
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("keeps a later pause after an earlier metadata state move fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-update-move-failure-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const enabled = path.join(schedulesDir, "enabled");
      const disabled = path.join(schedulesDir, "disabled");
      let rejectMove = true;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          rejectMove && path.dirname(from) === enabled && path.dirname(to) === disabled
            ? Effect.fail(permissionDenied("rename", from))
            : fileSystem.rename(from, to),
      });
      const schedules = yield* open(schedulesDir, resolveTarget).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
      const created = yield* schedules.create(caller, {
        name: "keep paused",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Original source." }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const error = yield* schedules
        .update(caller, created.id, {
          name: "not committed",
          enabled: false,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.kind, "io");
      assert.deepStrictEqual(yield* schedules.get(caller, created.id), created);
      rejectMove = false;
      const paused = yield* schedules.update(caller, created.id, { enabled: false });
      assert.strictEqual(paused.kind, "ready");
      if (paused.kind !== "ready") return yield* Effect.die("Paused schedule is invalid");
      assert.strictEqual(paused.state, "disabled");
      assert.deepStrictEqual(paused.definition, created.definition);
      const restarted = yield* open(schedulesDir, resolveTarget);
      assert.deepStrictEqual(yield* restarted.get(caller, created.id), paused);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(paused.sourceDirectory, "prompt.md")),
        "Original source.",
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("reconciles a retained rollback before accepting another mutation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-update-retained-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const enabled = path.join(schedulesDir, "enabled");
      const disabled = path.join(schedulesDir, "disabled");
      let rejectCommitAndRollback = true;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          rejectCommitAndRollback &&
          (path.basename(from) === "next.json" ||
            (path.dirname(from) === disabled && path.dirname(to) === enabled))
            ? Effect.fail(permissionDenied("rename", from))
            : fileSystem.rename(from, to),
      });
      const schedules = yield* open(schedulesDir, resolveTarget).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
      const created = yield* schedules.create(caller, {
        name: "original",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Original source." }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const failed = yield* schedules
        .update(caller, created.id, {
          name: "uncommitted",
          enabled: false,
        })
        .pipe(Effect.flip);
      assert.strictEqual(failed.kind, "io");
      const blocked = yield* schedules
        .update(caller, created.id, { enabled: false })
        .pipe(Effect.flip);
      assert.strictEqual(blocked.kind, "io");
      rejectCommitAndRollback = false;
      const recovered = yield* schedules.update(caller, created.id, { name: "after recovery" });
      assert.strictEqual(recovered.kind, "ready");
      if (recovered.kind !== "ready") return yield* Effect.die("Recovered schedule is invalid");
      assert.strictEqual(recovered.state, "enabled");
      assert.strictEqual(recovered.sourceDirectory, created.sourceDirectory);
      assert.strictEqual(recovered.definition.name, "after recovery");
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(recovered.sourceDirectory, "prompt.md")),
        "Original source.",
      );
      const paused = yield* schedules.update(caller, created.id, { enabled: false });
      assert.strictEqual(paused.state, "disabled");
      const restarted = yield* open(schedulesDir, resolveTarget);
      assert.deepStrictEqual(yield* restarted.get(caller, created.id), paused);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rolls back a state move when the metadata commit fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-update-rollback-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("unused"),
      };
      yield* bootstrap(storage);
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000101");
      const definition: Schedule.ScheduleDefinition = {
        version: 2,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000102"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      yield* publishDefinition(
        storage,
        id,
        "enabled",
        definition,
        yield* prepareSource(
          { "prompt.md": "original", "lib/helper.js": "export const value = 1;" },
          ["lib"],
        ),
        "original",
      );
      const current = yield* loadSchedule(storage, id);
      if (current === undefined) return yield* Effect.die("Published definition disappeared");
      const updated: Schedule.ScheduleDefinition = {
        ...definition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000103"),
        name: "updated",
      };
      const nextMetadata = path.join(schedulesDir, ".staging", "update-rejected", "next.json");
      const destination = path.join(schedulesDir, "disabled", id);
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          from === nextMetadata && to === path.join(destination, "meta.json")
            ? fileSystem
                .exists(destination)
                .pipe(
                  Effect.flatMap((moved) =>
                    moved
                      ? Effect.fail(permissionDenied("rename", from))
                      : Effect.die("Metadata commit preceded the state move"),
                  ),
                )
            : fileSystem.rename(from, to),
      });
      const error = yield* updateDefinition(
        { ...storage, fileSystem: failingFileSystem },
        current,
        updated,
        "disabled",
        "rejected",
      ).pipe(Effect.flip);
      assert.strictEqual(error.kind, "io");
      const retained = yield* loadSchedule(storage, id);
      assert.strictEqual(retained?.view.kind, "ready");
      if (retained?.view.kind !== "ready") return;
      assert.deepStrictEqual(retained.view.definition, definition);
      assert.strictEqual(retained.view.sourceDirectory, path.join(schedulesDir, "enabled", id));
      assert.isFalse(yield* fileSystem.exists(destination));
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(retained.view.sourceDirectory, "lib/helper.js")),
        "export const value = 1;",
      );
      yield* bootstrap(storage);
      assert.deepStrictEqual((yield* loadSchedule(storage, id))?.view, retained.view);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("recovers an uncommitted moved directory without overwriting edited source", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-update-recovery-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("unused"),
      };
      yield* bootstrap(storage);
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000104");
      const definition: Schedule.ScheduleDefinition = {
        version: 2,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000105"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      yield* publishDefinition(
        storage,
        id,
        "disabled",
        definition,
        yield* prepareSource(
          { "prompt.md": "original", "lib/helper.js": "export const value = 1;" },
          ["lib"],
        ),
        "original",
      );
      const transaction = path.join(schedulesDir, ".staging", "update-crashed");
      const updated: Schedule.ScheduleDefinition = {
        ...definition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000106"),
        name: "uncommitted",
      };
      yield* fileSystem.makeDirectory(transaction);
      yield* fileSystem.writeFileString(
        path.join(transaction, "next.json"),
        JSON.stringify(updated),
      );
      yield* fileSystem.writeFileString(
        path.join(transaction, "transaction.json"),
        JSON.stringify({
          kind: "update",
          id,
          state: "disabled",
          nextState: "enabled",
          revision: updated.revision,
        }),
      );
      const originalDirectory = path.join(schedulesDir, "disabled", id);
      const movedDirectory = path.join(schedulesDir, "enabled", id);
      yield* fileSystem.rename(originalDirectory, movedDirectory);
      yield* fileSystem.writeFileString(
        path.join(movedDirectory, "lib/helper.js"),
        "export const value = 2;",
      );
      const restarted = yield* open(schedulesDir, resolveTarget);
      const recovered = yield* restarted.get(caller, id);
      assert.strictEqual(recovered.kind, "ready");
      if (recovered.kind !== "ready") return;
      assert.deepStrictEqual(recovered.definition, definition);
      assert.strictEqual(recovered.sourceDirectory, originalDirectory);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(recovered.sourceDirectory, "lib/helper.js")),
        "export const value = 2;",
      );
      assert.isFalse(yield* fileSystem.exists(movedDirectory));
      assert.isFalse(yield* fileSystem.exists(transaction));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("restores a definition retained by an interrupted pre-upgrade replacement", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-replace-upgrade-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir, resolveTarget);
      const created = yield* schedules.create(caller, {
        name: "before upgrade",
        enabled: false,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Retained source." }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const transaction = path.join(schedulesDir, ".staging", "replace-interrupted");
      const next = path.join(transaction, "next");
      yield* fileSystem.makeDirectory(next, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(transaction, "transaction.json"),
        JSON.stringify({ kind: "replace", id: created.id, state: "disabled" }),
      );
      yield* fileSystem.writeFileString(
        path.join(next, "meta.json"),
        JSON.stringify({
          ...created.definition,
          revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000107"),
          name: "uncommitted replacement",
        }),
      );
      yield* fileSystem.writeFileString(path.join(next, "prompt.md"), "Uncommitted source.");
      yield* fileSystem.rename(created.sourceDirectory, path.join(transaction, "previous"));
      const restarted = yield* open(schedulesDir, resolveTarget);
      const recovered = yield* restarted.get(caller, created.id);
      assert.deepStrictEqual(recovered, created);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(created.sourceDirectory, "prompt.md")),
        "Retained source.",
      );
      assert.isFalse(yield* fileSystem.exists(transaction));
      const reopened = yield* open(schedulesDir, resolveTarget);
      assert.deepStrictEqual(yield* reopened.get(caller, created.id), recovered);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("keeps a committed pre-upgrade replacement after a later pause", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-replace-committed-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir, resolveTarget);
      const created = yield* schedules.create(caller, {
        name: "committed replacement",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Committed source." }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const transaction = path.join(schedulesDir, ".staging", "replace-committed");
      const previous = path.join(transaction, "previous");
      yield* fileSystem.makeDirectory(previous, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(transaction, "transaction.json"),
        JSON.stringify({ kind: "replace", id: created.id, state: "enabled" }),
      );
      yield* fileSystem.writeFileString(
        path.join(previous, "meta.json"),
        JSON.stringify({
          ...created.definition,
          revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000108"),
          name: "old definition",
        }),
      );
      yield* fileSystem.writeFileString(path.join(previous, "prompt.md"), "Old source.");
      const paused = yield* schedules.update(caller, created.id, { enabled: false });
      const restarted = yield* open(schedulesDir, resolveTarget);
      const recovered = yield* restarted.get(caller, created.id);
      assert.deepStrictEqual(recovered, paused);
      assert.strictEqual(recovered.kind, "ready");
      if (recovered.kind !== "ready") return yield* Effect.die("Recovered schedule is invalid");
      assert.strictEqual(recovered.state, "disabled");
      assert.deepStrictEqual(recovered.definition, created.definition);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(recovered.sourceDirectory, "prompt.md")),
        "Committed source.",
      );
      assert.isFalse(yield* fileSystem.exists(created.sourceDirectory));
      assert.isFalse(yield* fileSystem.exists(transaction));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "retains the whole legacy replacement transaction when both canonical states exist",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-replace-conflict-",
        });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir, resolveTarget);
        const created = yield* schedules.create(caller, {
          name: "conflicted replacement",
          enabled: true,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 10_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "Enabled source." }),
        });
        if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
        const disabled = path.join(schedulesDir, "disabled", created.id);
        const transaction = path.join(schedulesDir, ".staging", "replace-conflicted");
        const previous = path.join(transaction, "previous");
        const next = path.join(transaction, "next");
        for (const directory of [disabled, previous, next]) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
        }
        const journal = JSON.stringify({ kind: "replace", id: created.id, state: "enabled" });
        const retained = {
          [path.join(created.sourceDirectory, "prompt.md")]: "Enabled source.",
          [path.join(disabled, "prompt.md")]: "Disabled source.",
          [path.join(previous, "prompt.md")]: "Only retained source.",
          [path.join(next, "prompt.md")]: "Uncommitted source.",
          [path.join(transaction, "transaction.json")]: journal,
        };
        for (const [file, content] of Object.entries(retained)) {
          yield* fileSystem.writeFileString(file, content);
        }
        const error = yield* open(schedulesDir, resolveTarget).pipe(Effect.flip);
        assert.strictEqual(error.kind, "corrupt");
        for (const [file, content] of Object.entries(retained)) {
          assert.strictEqual(yield* fileSystem.readFileString(file), content);
        }
        assert.deepStrictEqual((yield* fileSystem.readDirectory(transaction)).sort(), [
          "next",
          "previous",
          "transaction.json",
        ]);
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("retains replacement data when its recovery journal is missing or corrupt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-replace-journal-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      yield* open(schedulesDir, resolveTarget);
      const transaction = path.join(schedulesDir, ".staging", "replace-retained");
      const previous = path.join(transaction, "previous");
      yield* fileSystem.makeDirectory(previous, { recursive: true });
      const retained = path.join(previous, "prompt.md");
      yield* fileSystem.writeFileString(retained, "Only retained source.");
      const missing = yield* open(schedulesDir, resolveTarget).pipe(Effect.flip);
      assert.strictEqual(missing.kind, "corrupt");
      assert.strictEqual(yield* fileSystem.readFileString(retained), "Only retained source.");
      yield* fileSystem.writeFileString(
        path.join(transaction, "transaction.json"),
        '{"kind":"replace"}',
      );
      const corrupt = yield* open(schedulesDir, resolveTarget).pipe(Effect.flip);
      assert.strictEqual(corrupt.kind, "corrupt");
      assert.strictEqual(yield* fileSystem.readFileString(retained), "Only retained source.");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "discards journal-free staging but retains corrupt and unreadable update journals",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-recovery-journal-",
        });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const storage: Storage = {
          fileSystem,
          path,
          schedulesDir,
          temporaryId: () => Effect.succeed("unused"),
        };
        const logs = yield* captureLogs();
        yield* bootstrap(storage);
        const abandoned = path.join(schedulesDir, ".staging", "update-abandoned");
        yield* fileSystem.makeDirectory(abandoned);
        yield* fileSystem.writeFileString(
          path.join(abandoned, "next.json"),
          "uncommitted metadata",
        );
        yield* bootstrap(storage).pipe(Effect.provide(logs.layer));
        assert.isFalse(yield* fileSystem.exists(abandoned));
        assert.deepStrictEqual(
          logs.entries.filter((entry) => entry.level === "Error"),
          [],
        );

        const copiedSource = path.join(schedulesDir, ".staging", "definition-abandoned");
        yield* fileSystem.makeDirectory(path.join(copiedSource, "previous"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(copiedSource, "prompt.md"), "authored prompt");
        yield* fileSystem.writeFileString(
          path.join(copiedSource, "transaction.json"),
          '{"helper":true}',
        );
        yield* bootstrap(storage);
        assert.isFalse(yield* fileSystem.exists(copiedSource));

        const transaction = path.join(schedulesDir, ".staging", "update-broken");
        const journal = path.join(transaction, "transaction.json");
        const retained = path.join(transaction, "next.json");
        yield* fileSystem.makeDirectory(transaction);
        yield* fileSystem.writeFileString(retained, "retained definition");
        yield* fileSystem.writeFileString(journal, '{"private":"corrupt journal"}');
        const corrupt = yield* bootstrap(storage).pipe(Effect.flip);
        assert.strictEqual(corrupt.kind, "corrupt");
        assert.strictEqual(yield* fileSystem.readFileString(retained), "retained definition");
        assert.strictEqual(
          yield* fileSystem.readFileString(journal),
          '{"private":"corrupt journal"}',
        );
        const unreadable = yield* bootstrap({
          ...storage,
          fileSystem: FileSystem.FileSystem.of({
            ...fileSystem,
            readFileString: (file, encoding) =>
              file === journal
                ? Effect.fail(permissionDenied("readFileString", file))
                : fileSystem.readFileString(file, encoding),
          }),
        }).pipe(Effect.flip);
        assert.strictEqual(unreadable.kind, "io");
        assert.strictEqual(yield* fileSystem.readFileString(retained), "retained definition");
        assert.isTrue(yield* fileSystem.exists(journal));
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
