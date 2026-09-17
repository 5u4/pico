import { assert, describe, it } from "@effect/vitest";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { open } from "./schedule.ts";
import {
  awaitFinished,
  caller,
  chatId,
  decodeDefinition,
  decodeScriptResult,
  platformLayer,
  prepareSource,
  resolveTarget,
  workspaceId,
} from "./schedule-test-fixtures.ts";

const otherWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000099");

describe("schedule management", () => {
  it.effect(
    "does not execute a claimed script when its prepared target is no longer admitted",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-script-admission-",
        });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir, resolveTarget);
        const marker = path.join(root, "script-executed");
        yield* TestClock.setTime(1_000);
        const created = yield* schedules.create(caller, {
          name: "Deleted destination",
          enabled: true,
          target: { kind: "chat", chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({
            "script.js": `await Bun.write(${JSON.stringify(marker)}, "executed");process.stdout.write(JSON.stringify({agent:false}));`,
          }),
        });
        if (created.kind !== "ready") return yield* Effect.die("Expected a valid schedule");
        yield* schedules.start({
          resolveTarget,
          withScriptActivity: () =>
            Effect.fail(new Schedule.ScheduleHostError({ message: "Workspace not found" })),
          prepare: () => Effect.succeed({ chatId, workspaceId, cwd: AbsolutePath.make(root) }),
          materialize: () => Effect.die("Rejected script must not materialize"),
          publish: () => Effect.die("Rejected script must not publish"),
          deliver: () => Effect.die("Rejected script must not deliver"),
          runPrompt: () => Effect.die("Rejected script must not start a model"),
        });
        const runId = Schedule.ScheduleRunId.make(`scheduled-1000-${created.definition.revision}`);
        const run = yield* awaitFinished(
          fileSystem,
          path.join(schedulesDir, "runs", created.id, runId, "run.json"),
        );
        assert.deepStrictEqual(run.state.kind === "finished" && run.state.outcome, {
          kind: "failed",
          stage: "target",
          message: "Workspace not found",
        });
        assert.isFalse(yield* fileSystem.exists(marker));
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "reads both conflicted targets independently of invalid sources and fails on unknown metadata",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-schedule-targets-",
        });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir, resolveTarget);
        const created = yield* schedules.create(caller, {
          name: "Broken source",
          enabled: true,
          target: { kind: "chat", chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "retained prompt" }),
        });
        yield* fileSystem.remove(path.join(schedulesDir, "enabled", created.id, "prompt.md"));
        assert.deepStrictEqual(yield* schedules.withCurrentTargets(Effect.succeed), [
          { kind: "chat", chatId },
        ]);
        const disabled = path.join(schedulesDir, "disabled", created.id);
        yield* fileSystem.makeDirectory(disabled);
        const metadata = path.join(disabled, "meta.json");
        yield* fileSystem.writeFileString(
          metadata,
          JSON.stringify({
            target: { kind: "workspace", workspaceId: otherWorkspaceId },
            trigger: "invalid",
          }),
        );
        assert.deepStrictEqual(yield* schedules.withCurrentTargets(Effect.succeed), [
          { kind: "chat", chatId },
          { kind: "workspace", workspaceId: otherWorkspaceId },
        ]);
        yield* fileSystem.writeFileString(metadata, "{}");
        assert.strictEqual(
          (yield* schedules.withCurrentTargets(Effect.succeed).pipe(Effect.flip)).kind,
          "invalid",
        );
        yield* fileSystem.remove(metadata);
        assert.strictEqual(
          (yield* schedules.withCurrentTargets(Effect.succeed).pipe(Effect.flip)).kind,
          "io",
        );
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("serializes retargeting and creation with a workspace deletion decision", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-schedule-delete-race-",
      });
      let deleted = false;
      const schedules = yield* open(AbsolutePath.make(path.join(root, "schedules")), (target) =>
        target.kind === "workspace" && target.workspaceId === otherWorkspaceId && deleted
          ? Effect.fail(new Schedule.ScheduleHostError({ message: "Workspace not found" }))
          : resolveTarget(target),
      );
      const sourceDirectory = yield* prepareSource({ "prompt.md": "check" });
      const created = yield* schedules.create(caller, {
        name: "Original",
        enabled: false,
        target: { kind: "workspace", workspaceId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory,
      });
      const scanning = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const deleting = yield* schedules
        .withCurrentTargets(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(scanning, undefined);
            yield* Deferred.await(commit);
            deleted = true;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(scanning);
      const retargeting = yield* schedules
        .update(caller, created.id, {
          target: { kind: "workspace", workspaceId: otherWorkspaceId },
        })
        .pipe(Effect.result, Effect.forkChild);
      const creating = yield* schedules
        .create(caller, {
          name: "Late",
          enabled: false,
          target: { kind: "workspace", workspaceId: otherWorkspaceId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory,
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.succeed(commit, undefined);
      yield* Fiber.join(deleting);
      for (const result of [yield* Fiber.join(retargeting), yield* Fiber.join(creating)]) {
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.kind, "invalid");
      }
      assert.deepStrictEqual(yield* schedules.list(caller), [created]);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("opens usable schedule storage before the runner starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedules-open-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir, resolveTarget);

        assert.deepStrictEqual(yield* schedules.list(caller), []);
        const created = yield* schedules.create(caller, {
          name: "ready before start",
          enabled: false,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "ship it" }),
        });
        assert.strictEqual(created.kind, "ready");
        assert.deepStrictEqual(yield* schedules.list(caller), [created]);
      }).pipe(Effect.provide(platformLayer)),
    ),
  );

  it.effect("keeps previous-revision run status compact and orders claims deterministically", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-overview-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir, resolveTarget);
      const created = yield* schedules.create(caller, {
        name: "Recorded status",
        enabled: true,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Private instructions" }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Expected valid definition");
      const updated = yield* schedules.update(caller, created.id, { name: "New revision" });
      if (updated.kind !== "ready") return yield* Effect.die("Expected valid revision");
      const saveRun = Effect.fn("Schedules.test.saveRecordedRun")(function* (
        scheduledFor: number,
        claimedAt: number,
        state: Schedule.ScheduleRunLifecycle["state"],
      ) {
        const id = Schedule.ScheduleRunId.make(
          `scheduled-${scheduledFor}-${created.definition.revision}`,
        );
        const directory = path.join(schedulesDir, "runs", created.id, id);
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(directory, "run.json"),
          JSON.stringify({
            version: 1,
            id,
            scheduleId: created.id,
            definitionRevision: created.definition.revision,
            source: { kind: "scheduled", scheduledFor },
            plannedTarget: { kind: "existing-chat", ownerWorkspaceId: workspaceId, chatId },
            claimedAt,
            state,
          }),
        );
        return id;
      });
      yield* saveRun(9_000, 100, {
        kind: "finished",
        finishedAt: 10_000,
        outcome: { kind: "published", content: "Private published output" },
      });
      const completedId = yield* saveRun(1_000, 200, {
        kind: "finished",
        finishedAt: 300,
        outcome: { kind: "completed", finalAssistantText: "Private assistant output" },
      });
      yield* TestClock.setTime(2_000);
      const snapshot = yield* schedules.overview();
      const entry = snapshot.entries[0];
      assert.deepStrictEqual(entry?.lastRun, {
        id: completedId,
        definitionRevision: created.definition.revision,
        scheduledFor: 1_000,
        claimedAt: 200,
        state: { kind: "finished", finishedAt: 300, outcome: { kind: "completed" } },
      });
      assert.notStrictEqual(entry?.lastRun?.definitionRevision, updated.definition.revision);
      assert.deepStrictEqual(entry?.nextTrigger, { kind: "none", reason: "past-once" });
      assert.strictEqual(entry?.view.state, "enabled");
      assert.isFalse(JSON.stringify(snapshot).includes("Private"));

      const recordedId = yield* saveRun(2_000, 200, {
        kind: "running-script",
        startedAt: 250,
        target: { chatId, workspaceId, cwd: AbsolutePath.make("/private/execution-directory") },
      });
      const refreshed = yield* schedules.overview();
      assert.deepStrictEqual(refreshed.entries[0]?.lastRun, {
        id: recordedId,
        definitionRevision: created.definition.revision,
        scheduledFor: 2_000,
        claimedAt: 200,
        state: { kind: "running-script", startedAt: 250 },
      });
      assert.isFalse(JSON.stringify(refreshed).includes("/private/execution-directory"));
      yield* schedules.remove(caller, created.id);
      assert.deepStrictEqual((yield* schedules.overview()).entries, []);
      assert.isTrue(
        yield* fileSystem.exists(
          path.join(schedulesDir, "runs", created.id, recordedId, "run.json"),
        ),
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("isolates current schedules from corrupt retained history after deletion", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-retained-runs-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir, resolveTarget);
      const input: Schedule.CreateSchedule = {
        name: "Retained history",
        enabled: false,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Run the check." }),
      };
      const removed = yield* schedules.create(caller, input);
      if (removed.kind !== "ready") return yield* Effect.die("Expected valid definition");
      const runDirectory = path.join(
        schedulesDir,
        "runs",
        removed.id,
        `scheduled-1000-${removed.definition.revision}`,
      );
      yield* fileSystem.makeDirectory(runDirectory, { recursive: true });
      const runFile = path.join(runDirectory, "run.json");
      yield* fileSystem.writeFileString(runFile, "{}");
      const corrupt = yield* schedules.overview().pipe(Effect.flip);
      assert.strictEqual(corrupt.kind, "corrupt");

      yield* schedules.remove(caller, removed.id);
      const current = yield* schedules.create(caller, { ...input, name: "Current schedule" });
      const snapshot = yield* schedules.overview();
      assert.deepStrictEqual(
        snapshot.entries.map((entry) => entry.view.id),
        [current.id],
      );
      assert.isNull(snapshot.entries[0]?.lastRun);
      assert.strictEqual(yield* fileSystem.readFileString(runFile), "{}");

      yield* schedules.remove(caller, current.id);
      assert.deepStrictEqual((yield* schedules.overview()).entries, []);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "calculates timezone-aware future triggers and distinguishes impossible cron dates",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-next-" });
        const schedules = yield* open(
          AbsolutePath.make(path.join(root, "schedules")),
          resolveTarget,
        );
        const now = Date.parse("2026-09-16T00:00:00Z");
        yield* TestClock.setTime(now);
        const sourceDirectory = yield* prepareSource({
          "prompt.md": "Run at the configured time.",
        });
        const cron = yield* schedules.create(caller, {
          name: "Taipei morning",
          enabled: true,
          target: { kind: "chat", chatId },
          trigger: { kind: "cron", expression: "0 9 * * *", timeZone: "Asia/Taipei" },
          sourceDirectory,
        });
        const impossible = yield* schedules.create(caller, {
          name: "Impossible date",
          enabled: true,
          target: { kind: "chat", chatId },
          trigger: { kind: "cron", expression: "0 0 30 2 *", timeZone: "UTC" },
          sourceDirectory,
        });
        const next = new Map(
          (yield* schedules.overview()).entries.map((entry) => [entry.view.id, entry.nextTrigger]),
        );
        assert.deepStrictEqual(next.get(cron.id), {
          kind: "scheduled",
          at: Date.parse("2026-09-16T01:00:00Z"),
        });
        assert.deepStrictEqual(next.get(impossible.id), { kind: "unavailable" });
        yield* schedules.update(caller, cron.id, { enabled: false });
        const disabled = (yield* schedules.overview()).entries.find(
          (entry) => entry.view.id === cron.id,
        );
        assert.deepStrictEqual(disabled?.nextTrigger, { kind: "none", reason: "disabled" });
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("keeps management in the owning workspace after selecting another destination", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-owner-" });
      const schedules = yield* open(AbsolutePath.make(path.join(root, "schedules")), resolveTarget);
      const destinationCaller = { ...caller, workspaceId: otherWorkspaceId };
      const created = yield* schedules.create(caller, {
        name: "owned here",
        enabled: false,
        target: { kind: "workspace", workspaceId: otherWorkspaceId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Run elsewhere." }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Explicit target was rejected");
      assert.deepStrictEqual(yield* schedules.list(caller), [created]);
      assert.deepStrictEqual(yield* schedules.list(destinationCaller), []);
      assert.strictEqual(
        (yield* schedules.get(destinationCaller, created.id).pipe(Effect.flip)).kind,
        "not-found",
      );
      assert.strictEqual(
        (yield* schedules
          .update(destinationCaller, created.id, { enabled: true })
          .pipe(Effect.flip)).kind,
        "not-found",
      );
      const updated = yield* schedules.update(caller, created.id, {
        target: { kind: "chat", chatId },
      });
      assert.deepStrictEqual(yield* schedules.get(caller, created.id), updated);
      assert.strictEqual(
        (yield* schedules.remove(destinationCaller, created.id).pipe(Effect.flip)).kind,
        "not-found",
      );
      yield* schedules.remove(caller, created.id);
      assert.deepStrictEqual(yield* schedules.list(caller), []);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "copies prepared sources and preserves source bytes and omitted metadata across updates",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-schedule-storage-",
        });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir, resolveTarget);
        const script = 'import { content } from "./lib/helper.js";process.stdout.write(content);';
        const helper = 'export const content = "original";';
        const asset = new Uint8Array([0, 255, 128, 10]);
        const nestedMetadata = {
          "lib/meta.json": '{"helper":1}',
          "lib/definition.json": '{"helper":2}',
          "assets/Meta.json": '{"helper":3}',
          "assets/Definition.json": '{"helper":4}',
        };
        const sourceDirectory = yield* prepareSource(
          {
            "script.js": script,
            "prompt.md": "Run the update.",
            "lib/helper.js": helper,
            "assets/data.bin": asset,
            ...nestedMetadata,
          },
          ["cache/empty"],
        );
        const created = yield* schedules.create(caller, {
          name: "editable",
          enabled: false,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 10_000 },
          sourceDirectory,
          scriptTimeoutMs: 5_000,
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        const directory = AbsolutePath.make(path.join(schedulesDir, "disabled", created.id));
        assert.strictEqual(created.sourceDirectory, directory);
        assert.notStrictEqual(created.sourceDirectory, sourceDirectory);
        yield* fileSystem.writeFileString(path.join(sourceDirectory, "script.js"), "changed input");
        yield* fileSystem.remove(path.join(sourceDirectory, "lib"), { recursive: true });

        const updated = yield* schedules.update(caller, created.id, { name: "updated" });
        assert.strictEqual(updated.kind, "ready");
        if (updated.kind !== "ready") return;
        assert.deepStrictEqual(updated.definition, {
          ...created.definition,
          name: "updated",
          revision: updated.definition.revision,
        });
        assert.notStrictEqual(updated.definition.revision, created.definition.revision);
        assert.strictEqual(updated.sourceDirectory, directory);
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "script.js")),
          script,
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "lib/helper.js")),
          helper,
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "prompt.md")),
          "Run the update.",
        );
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(directory, "assets/data.bin")),
          asset,
        );
        assert.deepStrictEqual(
          yield* fileSystem.readDirectory(path.join(directory, "cache/empty")),
          [],
        );
        for (const [name, contents] of Object.entries(nestedMetadata)) {
          assert.strictEqual(
            yield* fileSystem.readFileString(path.join(directory, name)),
            contents,
          );
        }

        const enabled = yield* schedules.update(caller, created.id, { enabled: true });
        assert.strictEqual(enabled.kind, "ready");
        if (enabled.kind !== "ready") return;
        assert.strictEqual(enabled.sourceDirectory, path.join(schedulesDir, "enabled", created.id));
        assert.strictEqual(enabled.definition.revision, updated.definition.revision);
        assert.isFalse(yield* fileSystem.exists(directory));
        assert.deepStrictEqual(yield* schedules.get(caller, created.id), enabled);
        assert.deepStrictEqual(yield* schedules.list(caller), [enabled]);

        yield* fileSystem.writeFileString(
          path.join(enabled.sourceDirectory, "prompt.md"),
          "Edited in place.",
        );
        const disabled = yield* schedules.update(caller, created.id, { enabled: false });
        assert.strictEqual(disabled.kind, "ready");
        if (disabled.kind !== "ready") return;
        assert.strictEqual(disabled.sourceDirectory, directory);
        assert.strictEqual(disabled.definition.revision, updated.definition.revision);
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(disabled.sourceDirectory, "prompt.md")),
          "Edited in place.",
        );
        assert.deepStrictEqual(yield* schedules.get(caller, created.id), disabled);
        assert.deepStrictEqual(yield* schedules.list(caller), [disabled]);
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("clears a timeout override and runs with the default after a partial update", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-timeout-reset-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir, resolveTarget);
      const created = yield* schedules.create(caller, {
        name: "custom timeout",
        enabled: false,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": 'process.stdout.write(JSON.stringify({agent:false,content:"default"}));',
        }),
        scriptTimeoutMs: 5_000,
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const input = yield* Schema.decodeUnknownEffect(Schedule.UpdateSchedule)({
        scriptTimeoutMs: null,
      });
      const reset = yield* schedules.update(caller, created.id, input);
      if (reset.kind !== "ready") return yield* Effect.die("Reset schedule is invalid");
      assert.isFalse(Object.hasOwn(reset.definition, "scriptTimeoutMs"));
      assert.notStrictEqual(reset.definition.revision, created.definition.revision);
      const persisted = yield* decodeDefinition(
        yield* fileSystem.readFileString(path.join(reset.sourceDirectory, "meta.json")),
      );
      assert.isFalse(Object.hasOwn(persisted, "scriptTimeoutMs"));
      const renamed = yield* schedules.update(caller, created.id, { name: "default timeout" });
      if (renamed.kind !== "ready") return yield* Effect.die("Renamed schedule is invalid");
      assert.isFalse(Object.hasOwn(renamed.definition, "scriptTimeoutMs"));
      assert.deepStrictEqual(renamed.definition.trigger, created.definition.trigger);
      assert.deepStrictEqual(renamed.definition.target, created.definition.target);
      yield* schedules.update(caller, created.id, { enabled: true });
      yield* TestClock.setTime(1_000);
      const published = yield* Queue.unbounded<string>();
      yield* schedules.start({
        withScriptActivity: (_chatId, script) => script,
        resolveTarget,
        materialize: () => Effect.void,
        prepare: () => Effect.succeed({ chatId, workspaceId, cwd: AbsolutePath.make(root) }),
        deliver: () => Effect.die("Script must publish without OMP"),
        publish: (_chatId, content) => Queue.offer(published, content).pipe(Effect.asVoid),
        runPrompt: () => Effect.die("Script must not invoke OMP"),
      });
      assert.strictEqual(yield* Queue.take(published), "default");
      const runId = `scheduled-1000-${renamed.definition.revision}`;
      const directory = path.join(schedulesDir, "runs", created.id, runId);
      yield* awaitFinished(fileSystem, path.join(directory, "run.json"));
      const result = yield* decodeScriptResult(
        yield* fileSystem.readFileString(path.join(directory, "script", "result.json")),
      );
      assert.strictEqual(result.timeoutMillis, Schedule.DEFAULT_SCRIPT_TIMEOUT_MS);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("returns repair paths for invalid metadata and entrypoints across state changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-invalid-" });
      const schedules = yield* open(AbsolutePath.make(path.join(root, "schedules")), resolveTarget);
      const created = yield* schedules.create(caller, {
        name: "editable",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Run the update." }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      const directory = created.sourceDirectory;
      yield* fileSystem.writeFileString(
        path.join(directory, "meta.json"),
        JSON.stringify({
          ...created.definition,
          target: { kind: "workspace", workspaceId: "not-a-workspace-id" },
        }),
      );
      const invalidTarget = yield* schedules.get(caller, created.id);
      assert.strictEqual(invalidTarget.kind, "invalid");
      assert.strictEqual(invalidTarget.sourceDirectory, directory);
      yield* fileSystem.writeFileString(
        path.join(directory, "meta.json"),
        JSON.stringify({ ...created.definition, name: "" }),
      );
      const listed = yield* schedules.list(caller);
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0]?.kind, "invalid");
      assert.strictEqual(listed[0]?.sourceDirectory, directory);
      yield* fileSystem.writeFileString(
        path.join(directory, "meta.json"),
        JSON.stringify(created.definition),
      );
      yield* fileSystem.writeFileString(path.join(directory, "extra.txt"), "helper");
      assert.strictEqual((yield* schedules.list(caller))[0]?.kind, "ready");
      yield* fileSystem.remove(path.join(directory, "prompt.md"));
      const missingEntrypoint = yield* schedules.get(caller, created.id);
      assert.strictEqual(missingEntrypoint.kind, "invalid");
      assert.strictEqual(missingEntrypoint.sourceDirectory, directory);
      const paused = yield* schedules.update(caller, created.id, { enabled: false });
      assert.strictEqual(paused.kind, "invalid");
      assert.strictEqual(paused.state, "disabled");
      assert.strictEqual(
        paused.sourceDirectory,
        path.join(root, "schedules", "disabled", created.id),
      );
      assert.deepStrictEqual(yield* schedules.get(caller, created.id), paused);
      if (paused.sourceDirectory === null) return yield* Effect.die("Missing repair directory");
      assert.isFalse(yield* fileSystem.exists(directory));
      yield* fileSystem.writeFileString(path.join(paused.sourceDirectory, "prompt.md"), " \n\t");
      const blankEntrypoint = yield* schedules.get(caller, created.id);
      assert.strictEqual(blankEntrypoint.kind, "invalid");
      assert.strictEqual(blankEntrypoint.sourceDirectory, paused.sourceDirectory);
      yield* fileSystem.writeFileString(
        path.join(paused.sourceDirectory, "prompt.md"),
        "Repaired.",
      );
      const resumed = yield* schedules.update(caller, created.id, { enabled: true });
      assert.strictEqual(resumed.kind, "ready");
      assert.strictEqual(resumed.sourceDirectory, directory);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(directory, "prompt.md")),
        "Repaired.",
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("returns no single repair directory for conflicting owned definitions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-conflict-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir, resolveTarget);
      const created = yield* schedules.create(caller, {
        name: "conflicted",
        enabled: false,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Retain both definitions." }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const duplicate = path.join(schedulesDir, "enabled", created.id);
      yield* fileSystem.makeDirectory(duplicate);
      yield* fileSystem.writeFileString(
        path.join(duplicate, "meta.json"),
        JSON.stringify(created.definition),
      );
      const conflicted = yield* schedules.get(caller, created.id);
      assert.strictEqual(conflicted.kind, "invalid");
      assert.strictEqual(conflicted.state, "conflicted");
      assert.strictEqual(conflicted.sourceDirectory, null);
      assert.deepStrictEqual(yield* schedules.list(caller), [conflicted]);
      const error = yield* schedules
        .update(caller, created.id, { enabled: false })
        .pipe(Effect.flip);
      assert.strictEqual(error.kind, "conflict");
      assert.isTrue(yield* fileSystem.exists(duplicate));
      assert.isTrue(yield* fileSystem.exists(created.sourceDirectory));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("repairs an invalid cron and enables the proposed definition in one update", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-schedule-repair-cron-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir, resolveTarget);
      const created = yield* schedules.create(caller, {
        name: "repair cron",
        enabled: false,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Check the schedule." }),
        scriptTimeoutMs: 5_000,
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      yield* fileSystem.writeFileString(
        path.join(created.sourceDirectory, "meta.json"),
        JSON.stringify({
          ...created.definition,
          trigger: { kind: "cron", expression: "99 * * * *", timeZone: "UTC" },
        }),
      );
      const invalid = yield* schedules.get(caller, created.id);
      assert.strictEqual(invalid.kind, "invalid");
      assert.strictEqual(invalid.sourceDirectory, created.sourceDirectory);
      const unchangedTrigger = yield* schedules
        .update(caller, created.id, {
          name: "still invalid",
          enabled: true,
        })
        .pipe(Effect.flip);
      assert.strictEqual(unchangedTrigger.kind, "invalid");
      assert.deepStrictEqual(yield* schedules.get(caller, created.id), invalid);
      const trigger = {
        kind: "cron",
        expression: "0 9 * * *",
        timeZone: "UTC",
      } satisfies Schedule.ScheduleTrigger;
      const repaired = yield* schedules.update(caller, created.id, { trigger, enabled: true });
      assert.strictEqual(repaired.kind, "ready");
      if (repaired.kind !== "ready") return yield* Effect.die("Repaired schedule is invalid");
      assert.strictEqual(repaired.state, "enabled");
      assert.strictEqual(repaired.sourceDirectory, path.join(schedulesDir, "enabled", created.id));
      assert.deepStrictEqual(repaired.definition, {
        ...created.definition,
        trigger,
        revision: repaired.definition.revision,
      });
      assert.notStrictEqual(repaired.definition.revision, created.definition.revision);
      const restarted = yield* open(schedulesDir, resolveTarget);
      assert.deepStrictEqual(yield* restarted.get(caller, created.id), repaired);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
