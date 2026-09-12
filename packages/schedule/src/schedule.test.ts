import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as Agent from "@pico/contract/agent-message";
import type { CapturedAgentRun } from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { make, open } from "./schedule.ts";
import {
  appendArtifactString,
  bootstrap,
  loadSchedule,
  moveDefinition,
  publishDefinition,
  publishRun,
  readRuns,
  replaceDefinition,
  runDirectory,
  type Storage,
  writeArtifactString,
} from "./storage.ts";

const platformLayer = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);
const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const otherWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000099");
const caller: Schedule.ScheduleCaller = { workspaceId, chatId };
const textPrompt = (text: string) => Agent.AgentPrompt.make({ text, attachments: [] });
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(Schedule.ScheduleRunLifecycle));
const decodeDefinition = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schedule.ScheduleDefinition),
);
const decodeScriptResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ timeoutMillis: Schema.Int })),
);

const awaitFinished = Effect.fn("Schedules.test.awaitFinished")(function* (
  fileSystem: FileSystem.FileSystem,
  runFile: string,
  attempts = 1_000,
): Effect.fn.Return<Schedule.ScheduleRunLifecycle> {
  if (attempts === 0) return yield* Effect.die("Schedule run did not finish");
  if (yield* fileSystem.exists(runFile).pipe(Effect.orDie)) {
    const source = yield* fileSystem.readFileString(runFile).pipe(Effect.orDie);
    const run = yield* decodeRun(source).pipe(Effect.orDie);
    if (run.state.kind === "finished") return run;
  }
  yield* Effect.yieldNow;
  return yield* awaitFinished(fileSystem, runFile, attempts - 1);
});

const awaitExists = Effect.fn("Schedules.test.awaitExists")(function* (
  fileSystem: FileSystem.FileSystem,
  path: string,
  attempts = 1_000,
): Effect.fn.Return<void> {
  if (attempts === 0) return yield* Effect.die(`Path did not appear: ${path}`);
  if (yield* fileSystem.exists(path).pipe(Effect.orDie)) return;
  yield* Effect.yieldNow;
  return yield* awaitExists(fileSystem, path, attempts - 1);
});
const permissionDenied = (method: string, path: string) =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
    }),
  );

interface ScheduleLog {
  readonly level: Logger.Options<unknown>["logLevel"];
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly message: unknown;
}

const captureLogs = Effect.fn("Schedules.test.captureLogs")(function* () {
  const events = yield* Queue.unbounded<ScheduleLog>();
  const entries: Array<ScheduleLog> = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      const entry: ScheduleLog = {
        level: options.logLevel,
        annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
        message: options.message,
      };
      entries.push(entry);
      Queue.offerUnsafe(events, entry);
    }),
  ]);
  return { events, entries, layer };
});

const awaitLog = Effect.fn("Schedules.test.awaitLog")(function* (
  events: Queue.Queue<ScheduleLog>,
  phase: string,
) {
  for (;;) {
    const entry = yield* Queue.take(events);
    if (entry.annotations.phase === phase) return entry;
  }
});

describe("Schedules", () => {
  it.effect("opens usable schedule storage before the runner starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedules-open-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir);

        assert.deepStrictEqual(yield* schedules.list(caller), []);
        const created = yield* schedules.create(caller, {
          name: "ready before start",
          enabled: false,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          prompt: "ship it",
        });
        assert.strictEqual(created.kind, "ready");
        assert.deepStrictEqual(yield* schedules.list(caller), [created]);
      }).pipe(Effect.provide(platformLayer)),
    ),
  );

  it.effect("initializes direct construction when the runner starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedules-start-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* make(schedulesDir);
        const cwd = AbsolutePath.make(root);
        yield* schedules.start({
          prepare: () => Effect.succeed({ chatId, workspaceId, cwd }),
          deliver: () => Effect.void,
          publish: () => Effect.void,
          runPrompt: () => Effect.die("unexpected scheduled prompt"),
        });

        assert.deepStrictEqual(yield* schedules.list(caller), []);
      }).pipe(Effect.provide(platformLayer)),
    ),
  );

  it.effect(
    "runs same-slot revisions independently, records artifacts, disables them, and retains history",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedules-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const cwd = AbsolutePath.make(path.join(root, "workspace"));
        yield* fileSystem.makeDirectory(cwd);
        const published = yield* Queue.unbounded<string>();
        const schedules = yield* make(schedulesDir);
        const host: Schedule.ScheduleRunHost = {
          prepare: (target) =>
            Effect.succeed({
              chatId: target.chatId,
              workspaceId: target.ownerWorkspaceId,
              cwd,
            }),
          deliver: () => Effect.die("script-only schedules must not deliver agent output"),
          publish: (_targetChatId, content) => Queue.offer(published, content).pipe(Effect.asVoid),
          runPrompt: () => Effect.die("script-only schedules must not invoke OMP"),
        };

        yield* TestClock.setTime(1_000);
        yield* schedules.start(host);
        const created = yield* schedules.create(caller, {
          name: "one shot",
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          script:
            'let input="";for await(const chunk of Bun.stdin.stream())input+=new TextDecoder().decode(chunk);JSON.parse(input);process.stdout.write(JSON.stringify({agent:false,content:"done"}));',
          scriptTimeoutMs: 12_345,
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        assert.strictEqual(created.definition.scriptTimeoutMs, 12_345);
        const persistedDefinition = yield* decodeDefinition(
          yield* fileSystem.readFileString(
            path.join(schedulesDir, "enabled", created.id, "meta.json"),
          ),
        );
        assert.strictEqual(persistedDefinition.scriptTimeoutMs, 12_345);

        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(yield* Queue.take(published), "done");
        const runId = Schedule.ScheduleRunId.make(`scheduled-1000-${created.definition.revision}`);
        const runDirectory = path.join(schedulesDir, "runs", created.id, runId);
        const run = yield* awaitFinished(fileSystem, path.join(runDirectory, "run.json"));
        assert.deepStrictEqual(run.state.kind === "finished" && run.state.outcome, {
          kind: "published",
          content: "done",
        });
        assert.isTrue(
          yield* fileSystem.exists(path.join(runDirectory, "input", "definition.json")),
        );
        assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, "input", "script.js")));
        for (const artifact of [
          "script/stdin.json",
          "script/stdout.bin",
          "script/stderr.bin",
          "script/result.json",
          "decision.json",
        ]) {
          assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, artifact)), artifact);
        }
        const scriptResult = yield* decodeScriptResult(
          yield* fileSystem.readFileString(path.join(runDirectory, "script", "result.json")),
        );
        assert.strictEqual(scriptResult.timeoutMillis, 12_345);
        const disabledMetadata = path.join(schedulesDir, "disabled", created.id, "meta.json");
        yield* awaitExists(fileSystem, disabledMetadata);
        const replaced = yield* schedules.replace(caller, created.id, {
          name: "one shot replacement",
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          script: 'process.stdout.write(JSON.stringify({agent:false,content:"done again"}));',
          scriptTimeoutMs: 12_345,
        });
        assert.strictEqual(replaced.kind, "ready");
        if (replaced.kind !== "ready") return;
        assert.notStrictEqual(replaced.definition.revision, created.definition.revision);
        yield* schedules.setEnabled(caller, created.id, true);
        assert.strictEqual(yield* Queue.take(published), "done again");
        const replacementRunId = Schedule.ScheduleRunId.make(
          `scheduled-1000-${replaced.definition.revision}`,
        );
        const replacementRunDirectory = path.join(
          schedulesDir,
          "runs",
          created.id,
          replacementRunId,
        );
        yield* awaitFinished(fileSystem, path.join(replacementRunDirectory, "run.json"));
        assert.deepStrictEqual(
          (yield* fileSystem.readDirectory(path.join(schedulesDir, "runs", created.id))).sort(),
          [runId, replacementRunId].sort(),
        );

        yield* schedules.remove(caller, created.id);
        assert.isFalse(yield* fileSystem.exists(path.join(schedulesDir, "disabled", created.id)));
        assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, "run.json")));
        assert.isTrue(yield* fileSystem.exists(path.join(replacementRunDirectory, "run.json")));
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("replaces complete assets and keeps invalid external edits visible", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-storage-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const schedules = yield* make(schedulesDir);
      const host: Schedule.ScheduleRunHost = {
        prepare: () => Effect.succeed({ chatId, workspaceId, cwd }),
        deliver: () => Effect.void,
        publish: () => Effect.void,
        runPrompt: (_chatId, runId) =>
          Effect.succeed({
            runId,
            outcome: "completed",
            events: [],
            finalAssistantText: "ok",
          }),
      };
      yield* schedules.start(host);
      const created = yield* schedules.create(caller, {
        name: "editable",
        enabled: false,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 10_000 },
        script: "process.stdout.write('{}')",
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      const createdDefinition = yield* decodeDefinition(
        yield* fileSystem.readFileString(
          path.join(schedulesDir, "disabled", created.id, "meta.json"),
        ),
      );
      assert.strictEqual(createdDefinition.scriptTimeoutMs, undefined);

      const updated = yield* schedules.replace(caller, created.id, {
        name: "updated",
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 20_000 },
        prompt: "Run the update.",
        scriptTimeoutMs: 5_000,
      });
      assert.strictEqual(updated.kind, "ready");
      const directory = path.join(schedulesDir, "disabled", created.id);
      assert.isFalse(yield* fileSystem.exists(path.join(directory, "script.js")));
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(directory, "prompt.md")),
        "Run the update.",
      );
      const replacedDefinition = yield* decodeDefinition(
        yield* fileSystem.readFileString(path.join(directory, "meta.json")),
      );
      assert.strictEqual(replacedDefinition.scriptTimeoutMs, 5_000);
      const defaulted = yield* schedules.replace(caller, created.id, {
        name: "defaulted",
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 30_000 },
        script: "process.stdout.write('{}')",
        prompt: "Run with content.",
      });
      assert.strictEqual(defaulted.kind, "ready");
      const defaultedDefinition = yield* decodeDefinition(
        yield* fileSystem.readFileString(path.join(directory, "meta.json")),
      );
      assert.strictEqual(defaultedDefinition.scriptTimeoutMs, undefined);
      assert.isTrue(yield* fileSystem.exists(path.join(directory, "script.js")));
      assert.isTrue(yield* fileSystem.exists(path.join(directory, "prompt.md")));
      const updatedDefinition =
        defaulted.kind === "ready" ? defaulted.definition : created.definition;
      yield* fileSystem.writeFileString(
        path.join(directory, "meta.json"),
        JSON.stringify({
          ...updatedDefinition,
          target: { kind: "workspace", workspaceId: otherWorkspaceId },
        }),
      );
      const crossWorkspace = yield* schedules.list(caller);
      assert.strictEqual(crossWorkspace[0]?.kind, "invalid");

      const definition = updatedDefinition;
      yield* fileSystem.writeFileString(
        path.join(directory, "meta.json"),
        JSON.stringify({ ...definition, name: "" }),
      );
      const listed = yield* schedules.list(caller);
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0]?.kind, "invalid");
      yield* fileSystem.writeFileString(
        path.join(directory, "meta.json"),
        JSON.stringify(updatedDefinition),
      );
      yield* fileSystem.writeFileString(path.join(directory, "extra.txt"), "invalid");
      const extraFile = yield* schedules.list(caller);
      assert.strictEqual(extraFile[0]?.kind, "invalid");

      yield* fileSystem.remove(path.join(directory, "extra.txt"));
      yield* fileSystem.remove(path.join(directory, "script.js"));
      yield* fileSystem.remove(path.join(directory, "prompt.md"));
      const noSource = yield* schedules.list(caller);
      assert.strictEqual(noSource[0]?.kind, "invalid");
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
        { script: null, prompt: "identity" },
        "018f47a0-0000-7000-8000-000000000006",
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

  it.effect("captures prompt artifacts and collapses cron downtime to the latest slot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-cron-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const invoked = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<string>();
      const schedules = yield* make(schedulesDir);
      const host: Schedule.ScheduleRunHost = {
        prepare: () => Effect.succeed({ chatId, workspaceId, cwd }),
        deliver: (_target, content) => Deferred.succeed(delivered, content).pipe(Effect.asVoid),
        publish: () => Effect.die("agent output must not be persisted twice"),
        runPrompt: (_target, runId, prompt, onEvent) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(prompt, textPrompt("Inspect the workspace."));
            yield* onEvent({ type: "run-started" });
            yield* onEvent({
              type: "message-settled",
              message: {
                role: "assistant",
                status: "completed",
                stopReason: "stop",
                content: [{ type: "text", text: "finished" }],
                model: "test",
                timestamp: 1,
              },
            });
            yield* onEvent({ type: "run-finished", outcome: "completed" });
            yield* Deferred.succeed(invoked, undefined);
            return {
              runId,
              outcome: "completed",
              events: [],
              finalAssistantText: "finished",
            };
          }),
      };

      yield* TestClock.setTime(0);
      yield* schedules.start(host);
      const created = yield* schedules.create(caller, {
        name: "hourly",
        enabled: false,
        target: { kind: "current-chat" },
        trigger: { kind: "cron", expression: "0 * * * *", timeZone: "UTC" },
        prompt: "Inspect the workspace.",
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      yield* TestClock.setTime(3 * 60 * 60 * 1_000 + 30_000);
      yield* schedules.setEnabled(caller, created.id, true);
      const scheduleRuns = path.join(schedulesDir, "runs", created.id);
      yield* awaitExists(fileSystem, scheduleRuns);
      yield* Deferred.await(invoked);
      assert.strictEqual(yield* Deferred.await(delivered), "finished");
      const runNames = yield* fileSystem.readDirectory(scheduleRuns);
      const runDirectory = path.join(scheduleRuns, runNames[0] ?? "missing");
      assert.deepStrictEqual(runNames, [
        `scheduled-${3 * 60 * 60 * 1_000}-${created.definition.revision}`,
      ]);
      const run = yield* awaitFinished(fileSystem, path.join(runDirectory, "run.json"));
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(runDirectory, "decision.json")),
        JSON.stringify({ agent: true }),
      );
      assert.strictEqual(run.state.kind, "finished");
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(runDirectory, "omp", "final.md")),
        "finished",
      );
      assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, "omp", "events.jsonl")));
      assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, "omp", "result.json")));
      assert.isTrue(yield* fileSystem.exists(path.join(schedulesDir, "enabled", created.id)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("derives script behavior and agent input from source files and decisions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-schedule-decisions-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const requests = new Map<Schedule.ScheduleRunId, Agent.AgentPrompt>();
      let deliveries = 0;
      const schedules = yield* make(schedulesDir);
      const host: Schedule.ScheduleRunHost = {
        prepare: (target) =>
          Effect.succeed({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
        deliver: () =>
          Effect.sync(() => {
            deliveries += 1;
          }),
        publish: () => Effect.die("agent output must not be persisted twice"),
        runPrompt: (_target, runId, prompt) =>
          Effect.sync(() => requests.set(runId, prompt)).pipe(
            Effect.as({
              runId,
              outcome: "completed",
              events: [],
              finalAssistantText: "finished",
            }),
          ),
      };

      yield* TestClock.setTime(1_000);
      yield* schedules.start(host);
      const skip = yield* schedules.create(caller, {
        name: "skip",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        script: "process.stdout.write(JSON.stringify({agent:false}))",
      });
      const composed = yield* schedules.create(caller, {
        name: "composed",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        script: 'process.stdout.write(JSON.stringify({agent:true,content:"generated input"}))',
        prompt: "stored prompt",
      });
      const scriptOnly = yield* schedules.create(caller, {
        name: "script only",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        script: 'process.stdout.write(JSON.stringify({agent:true,content:"script input"}))',
      });
      const storedPrompt = yield* schedules.create(caller, {
        name: "stored prompt",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        script: "process.stdout.write(JSON.stringify({agent:true}))",
        prompt: "prompt input",
      });
      const missingInput = yield* schedules.create(caller, {
        name: "missing input",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        script: "process.stdout.write(JSON.stringify({agent:true}))",
      });
      for (const created of [skip, composed, scriptOnly, storedPrompt, missingInput]) {
        assert.strictEqual(created.kind, "ready");
      }
      if (
        skip.kind !== "ready" ||
        composed.kind !== "ready" ||
        scriptOnly.kind !== "ready" ||
        storedPrompt.kind !== "ready" ||
        missingInput.kind !== "ready"
      ) {
        return;
      }

      yield* TestClock.adjust("30 seconds");
      const finishedRun = (schedule: Schedule.ReadyScheduleView) =>
        awaitFinished(
          fileSystem,
          path.join(
            schedulesDir,
            "runs",
            schedule.id,
            `scheduled-1000-${schedule.definition.revision}`,
            "run.json",
          ),
        );
      const skipRun = yield* finishedRun(skip);
      const composedRun = yield* finishedRun(composed);
      const scriptOnlyRun = yield* finishedRun(scriptOnly);
      const storedPromptRun = yield* finishedRun(storedPrompt);
      const missingInputRun = yield* finishedRun(missingInput);

      assert.deepStrictEqual(skipRun.state.kind === "finished" && skipRun.state.outcome, {
        kind: "skipped",
      });
      assert.deepStrictEqual(
        requests.get(composedRun.id),
        textPrompt("generated input\n\nstored prompt"),
      );
      assert.deepStrictEqual(requests.get(scriptOnlyRun.id), textPrompt("script input"));
      assert.deepStrictEqual(requests.get(storedPromptRun.id), textPrompt("prompt input"));
      assert.isFalse(requests.has(skipRun.id));
      assert.isFalse(requests.has(missingInputRun.id));
      assert.deepInclude(
        missingInputRun.state.kind === "finished" ? missingInputRun.state.outcome : {},
        { kind: "failed", stage: "protocol" },
      );
      assert.strictEqual(deliveries, 3);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("does not let an old run disable a replacement definition", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-revision-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const prepareStarted = yield* Deferred.make<void>();
      const releasePrepare = yield* Deferred.make<void>();
      const schedules = yield* make(schedulesDir);
      const host: Schedule.ScheduleRunHost = {
        prepare: (target) =>
          Deferred.succeed(prepareStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releasePrepare)),
            Effect.as({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
          ),
        deliver: () => Effect.void,
        publish: () => Effect.void,
        runPrompt: (_target, runId) =>
          Effect.succeed({
            runId,
            outcome: "completed",
            events: [],
            finalAssistantText: "old run",
          }),
      };

      yield* TestClock.setTime(1_000);
      yield* schedules.start(host);
      const created = yield* schedules.create(caller, {
        name: "old once",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        prompt: "old prompt",
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(prepareStarted);

      const replaced = yield* schedules.replace(caller, created.id, {
        name: "new cron",
        target: { kind: "current-chat" },
        trigger: { kind: "cron", expression: "* * * * *", timeZone: "UTC" },
        prompt: "new prompt",
      });
      assert.strictEqual(replaced.kind, "ready");
      if (replaced.kind !== "ready") return;
      assert.notStrictEqual(replaced.definition.revision, created.definition.revision);
      yield* Deferred.succeed(releasePrepare, undefined);

      const runFile = path.join(
        schedulesDir,
        "runs",
        created.id,
        `scheduled-1000-${created.definition.revision}`,
        "run.json",
      );
      yield* awaitFinished(fileSystem, runFile);
      assert.isTrue(yield* fileSystem.exists(path.join(schedulesDir, "enabled", created.id)));
      const current = yield* schedules.get(caller, created.id);
      assert.strictEqual(current.kind, "ready");
      if (current.kind === "ready") {
        assert.strictEqual(current.definition.revision, replaced.definition.revision);
        assert.strictEqual(current.definition.trigger.kind, "cron");
      }
      const restarted = yield* make(schedulesDir);
      yield* restarted.start(host);
      assert.isTrue(yield* fileSystem.exists(path.join(schedulesDir, "enabled", created.id)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("continues scheduling after a scan failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-recovery-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const invoked = yield* Deferred.make<void>();
      const schedules = yield* make(schedulesDir);
      const host: Schedule.ScheduleRunHost = {
        prepare: (target) =>
          Effect.succeed({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
        deliver: () => Effect.void,
        publish: () => Effect.void,
        runPrompt: (_target, runId) =>
          Deferred.succeed(invoked, undefined).pipe(
            Effect.as({
              runId,
              outcome: "completed",
              events: [],
              finalAssistantText: "recovered",
            }),
          ),
      };

      yield* TestClock.setTime(0);
      yield* schedules.start(host);
      const enabledDirectory = path.join(schedulesDir, "enabled");
      yield* fileSystem.remove(enabledDirectory, { recursive: true });
      yield* fileSystem.writeFileString(enabledDirectory, "not a directory");
      yield* TestClock.adjust("30 seconds");
      yield* fileSystem.remove(enabledDirectory);
      yield* fileSystem.makeDirectory(enabledDirectory, { mode: 0o700 });

      const created = yield* schedules.create(caller, {
        name: "after scan failure",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 30_000 },
        prompt: "still alive",
      });
      assert.strictEqual(created.kind, "ready");
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(invoked);
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
        prompt: "capture",
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
  it.effect("rejects symlinked definition destination parents before publishing", () =>
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
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000092"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const source: Schedule.ScheduleSource = { script: null, prompt: "original" };
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
      const transaction = path.join(schedulesDir, ".staging", "replace-symlinked-replace-parent");
      const nextPrompt = path.join(transaction, "next", "prompt.md");
      const previous = path.join(transaction, "previous");
      let attemptedOriginalMove = false;
      const swappedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (file, contents, options) =>
          fileSystem
            .writeFileString(file, contents, options)
            .pipe(
              Effect.tap(() =>
                file === nextPrompt
                  ? fileSystem
                      .rename(enabled, retainedEnabled)
                      .pipe(Effect.andThen(fileSystem.symlink(outside, enabled)))
                  : Effect.void,
              ),
            ),
        rename: (from, to) => {
          if (from === current.directory) attemptedOriginalMove = true;
          return fileSystem.rename(from, to);
        },
      });
      const replaceError = yield* replaceDefinition(
        { ...storage, fileSystem: swappedFileSystem },
        current,
        replacement,
        { script: null, prompt: "replacement" },
        "symlinked-replace-parent",
      ).pipe(Effect.flip);
      assert.strictEqual(replaceError.kind, "corrupt");
      assert.isFalse(attemptedOriginalMove);
      assert.isFalse(yield* fileSystem.exists(previous));
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
        version: 1,
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
        { script: null, prompt: "move me" },
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
  it.effect("keeps a definition canonical when replacement is interrupted during commit", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-replace-interrupt-" });
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
        version: 1,
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
        { script: null, prompt: "original" },
        "018f47a0-0000-7000-8000-000000000044",
      );
      const current = yield* loadSchedule(storage, id);
      if (current === undefined) return yield* Effect.die("Published definition disappeared");
      const replacement: Schedule.ScheduleDefinition = {
        ...original,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000045"),
        name: "replacement",
      };
      const secondRenameStarted = yield* Deferred.make<void>();
      const releaseSecondRename = yield* Deferred.make<void>();
      const destination = path.join(schedulesDir, "enabled", id);
      const next = path.join(
        schedulesDir,
        ".staging",
        "replace-018f47a0-0000-7000-8000-000000000046",
        "next",
      );
      const interruptedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          from === next && to === destination
            ? Deferred.succeed(secondRenameStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSecondRename)),
                Effect.andThen(fileSystem.rename(from, to)),
              )
            : fileSystem.rename(from, to),
      });
      const interruptedStorage: Storage = { ...storage, fileSystem: interruptedFileSystem };
      const fiber = yield* replaceDefinition(
        interruptedStorage,
        current,
        replacement,
        { script: null, prompt: "replacement" },
        "018f47a0-0000-7000-8000-000000000046",
      ).pipe(Effect.forkChild);
      yield* Deferred.await(secondRenameStarted);
      const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseSecondRename, undefined);
      yield* Fiber.join(interruption);

      const loaded = yield* loadSchedule(storage, id);
      assert.strictEqual(loaded?.view.kind, "ready");
      if (loaded?.view.kind !== "ready") return;
      assert.strictEqual(loaded.view.definition.revision, replacement.revision);
      assert.strictEqual(loaded.view.definition.name, "replacement");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("keeps a committed replacement successful when staging cleanup fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-replace-cleanup-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const staging = path.join(schedulesDir, ".staging");
      const logs = yield* captureLogs();
      let retainedTransaction: string | undefined;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        remove: (file, options) => {
          if (path.dirname(file) !== staging || !path.basename(file).startsWith("replace-")) {
            return fileSystem.remove(file, options);
          }
          retainedTransaction = file;
          return Effect.fail(permissionDenied("remove", "private cleanup cause"));
        },
      });
      const schedules = yield* open(schedulesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
      const created = yield* schedules.create(caller, {
        name: "private original",
        enabled: false,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 10_000 },
        prompt: "private original prompt",
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      const updated = yield* schedules
        .replace(caller, created.id, {
          name: "private replacement",
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 20_000 },
          prompt: "private replacement prompt",
        })
        .pipe(Effect.provide(logs.layer));
      assert.strictEqual(updated.kind, "ready");
      if (updated.kind !== "ready") return;
      assert.notStrictEqual(updated.definition.revision, created.definition.revision);
      assert.strictEqual(updated.definition.name, "private replacement");
      assert.deepStrictEqual(yield* schedules.list(caller), [updated]);
      assert.strictEqual(
        yield* fileSystem.readFileString(
          path.join(schedulesDir, "disabled", created.id, "prompt.md"),
        ),
        "private replacement prompt",
      );
      if (retainedTransaction === undefined) {
        return yield* Effect.die("Replacement cleanup was not attempted");
      }
      assert.deepStrictEqual(
        yield* decodeDefinition(
          yield* fileSystem.readFileString(path.join(retainedTransaction, "previous", "meta.json")),
        ),
        created.definition,
      );
      assert.isTrue(yield* fileSystem.exists(path.join(retainedTransaction, "transaction.json")));
      const errors = logs.entries.filter((entry) => entry.level === "Error");
      assert.strictEqual(errors.length, 1);
      assert.deepInclude(errors[0]?.annotations, {
        component: "schedule",
        operation: "replace",
        phase: "cleanup",
        scheduleId: created.id,
        definitionRevision: updated.definition.revision,
        category: "io",
      });
      assert.notInclude(JSON.stringify(logs.entries), "private");
      assert.notInclude(JSON.stringify(logs.entries), root);
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
        { script: null, prompt: "append" },
        "018f47a0-0000-7000-8000-000000000050",
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
  it.effect("preserves a completed once run when disabling its definition fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-once-disable-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const logs = yield* captureLogs();
      let rejectedDisable = false;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) => {
          if (
            !rejectedDisable &&
            path.dirname(from) === path.join(schedulesDir, "enabled") &&
            path.dirname(to) === path.join(schedulesDir, "disabled")
          ) {
            rejectedDisable = true;
            return Effect.fail(permissionDenied("rename", from));
          }
          return fileSystem.rename(from, to);
        },
      });
      yield* Effect.gen(function* () {
        const delivered = yield* Deferred.make<void>();
        const schedules = yield* make(schedulesDir);
        const host: Schedule.ScheduleRunHost = {
          prepare: (target) =>
            Effect.succeed({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
          deliver: () => Deferred.succeed(delivered, undefined).pipe(Effect.asVoid),
          publish: () => Effect.die("Agent schedules must deliver their final response"),
          runPrompt: (_target, runId) =>
            Effect.succeed({
              runId,
              outcome: "completed",
              events: [],
              finalAssistantText: "complete",
            }),
        };
        yield* TestClock.setTime(1_000);
        yield* schedules.start(host);
        const created = yield* schedules.create(caller, {
          name: "disable retry",
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          prompt: "complete once",
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        yield* Deferred.await(delivered);
        const runFile = path.join(
          schedulesDir,
          "runs",
          created.id,
          `scheduled-1000-${created.definition.revision}`,
          "run.json",
        );
        const completed = yield* awaitFinished(fileSystem, runFile);
        assert.deepStrictEqual(completed.state.kind === "finished" && completed.state.outcome, {
          kind: "completed",
          finalAssistantText: "complete",
        });
        const disableFailure = yield* awaitLog(logs.events, "disable-after-completion");
        assert.strictEqual(disableFailure.level, "Error");
        assert.strictEqual(disableFailure.annotations.scheduleId, created.id);
        assert.strictEqual(disableFailure.annotations.runId, completed.id);
        assert.strictEqual(disableFailure.annotations.outcome, "completed");
        assert.isTrue(yield* fileSystem.exists(path.join(schedulesDir, "enabled", created.id)));

        yield* TestClock.adjust("30 seconds");
        yield* awaitExists(
          fileSystem,
          path.join(schedulesDir, "disabled", created.id, "meta.json"),
        );
        const retained = yield* awaitFinished(fileSystem, runFile);
        assert.deepStrictEqual(retained.state.kind === "finished" && retained.state.outcome, {
          kind: "completed",
          finalAssistantText: "complete",
        });
      }).pipe(
        Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
        Effect.provide(logs.layer),
      );
      assert.strictEqual(logs.entries.filter((entry) => entry.level === "Error").length, 1);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("records the active phase for unexpected execution failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-run-phase-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      let rejectedDecision = false;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFile: (file, data, options) => {
          if (!rejectedDecision && path.basename(file).startsWith(".decision.json-")) {
            rejectedDecision = true;
            return Effect.fail(permissionDenied("writeFile", file));
          }
          return fileSystem.writeFile(file, data, options);
        },
      });
      yield* Effect.gen(function* () {
        const schedules = yield* make(schedulesDir);
        const host: Schedule.ScheduleRunHost = {
          prepare: (target) =>
            Effect.succeed({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
          deliver: () => Effect.die("Protocol failures must not deliver output"),
          publish: () => Effect.die("Protocol failures must not publish output"),
          runPrompt: () => Effect.die("Protocol failures must not invoke OMP"),
        };
        yield* TestClock.setTime(1_000);
        yield* schedules.start(host);
        const created = yield* schedules.create(caller, {
          name: "phase retention",
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          prompt: "unused",
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        yield* TestClock.adjust("30 seconds");
        const failed = yield* awaitFinished(
          fileSystem,
          path.join(
            schedulesDir,
            "runs",
            created.id,
            `scheduled-1000-${created.definition.revision}`,
            "run.json",
          ),
        );
        assert.deepInclude(failed.state.kind === "finished" ? failed.state.outcome : {}, {
          kind: "failed",
          stage: "protocol",
        });
      }).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("rejects staging symlinks without writing outside schedule storage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-staging-symlink-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const outside = path.join(root, "outside");
      const sentinel = path.join(outside, "sentinel");
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000060"),
      };
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000061");
      const definition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000062"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const source: Schedule.ScheduleSource = { script: null, prompt: "original" };
      const staging = path.join(schedulesDir, ".staging");
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.writeFileString(sentinel, "unchanged");
      yield* bootstrap(storage);

      const definitionTransaction = path.join(staging, "definition-preexisting");
      yield* fileSystem.symlink(outside, definitionTransaction);
      const definitionError = yield* publishDefinition(
        storage,
        id,
        "enabled",
        definition,
        source,
        "preexisting",
      ).pipe(Effect.flip);
      assert.strictEqual(definitionError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      assert.isFalse(yield* fileSystem.exists(path.join(schedulesDir, "enabled", id)));
      yield* fileSystem.remove(definitionTransaction);

      yield* publishDefinition(storage, id, "enabled", definition, source, "original");
      const current = yield* loadSchedule(storage, id);
      if (current === undefined) return yield* Effect.die("Published definition disappeared");
      const replacement: Schedule.ScheduleDefinition = {
        ...definition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000063"),
        name: "replacement",
      };
      const replacementTransaction = path.join(staging, "replace-preexisting");
      yield* fileSystem.symlink(outside, replacementTransaction);
      const replacementError = yield* replaceDefinition(
        storage,
        current,
        replacement,
        { script: null, prompt: "replacement" },
        "preexisting",
      ).pipe(Effect.flip);
      assert.strictEqual(replacementError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      const retained = yield* loadSchedule(storage, id);
      assert.strictEqual(retained?.view.kind, "ready");
      if (retained?.view.kind !== "ready") return;
      assert.strictEqual(retained.view.definition.revision, definition.revision);
      yield* fileSystem.remove(replacementTransaction);

      yield* fileSystem.remove(staging, { recursive: true });
      yield* fileSystem.symlink(outside, staging);
      const parentError = yield* publishDefinition(
        storage,
        Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000064"),
        "enabled",
        definition,
        source,
        "parent-replaced",
      ).pipe(Effect.flip);
      assert.strictEqual(parentError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      yield* fileSystem.remove(staging);
      yield* fileSystem.makeDirectory(staging, { mode: 0o700 });

      const run: Schedule.ScheduleRunLifecycle = {
        version: 1,
        id: Schedule.ScheduleRunId.make(`scheduled-1000-${definition.revision}`),
        scheduleId: id,
        definitionRevision: definition.revision,
        source: { kind: "scheduled", scheduledFor: 1_000 },
        plannedTarget: { kind: "existing-chat", ownerWorkspaceId: workspaceId, chatId },
        claimedAt: 1_000,
        state: { kind: "claimed" },
      };
      const runTransaction = path.join(staging, "run-preexisting");
      yield* fileSystem.symlink(outside, runTransaction);
      const runError = yield* publishRun(storage, run, definition, source, "preexisting").pipe(
        Effect.flip,
      );
      assert.strictEqual(runError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      assert.isFalse(yield* fileSystem.exists(runDirectory(storage, id, run.id)));
      yield* fileSystem.remove(runTransaction);

      const inputTransactionId = "input-preexisting";
      const inputTransaction = path.join(staging, `run-${inputTransactionId}`);
      const input = path.join(inputTransaction, "input");
      const injectedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        makeDirectory: (directory, options) =>
          fileSystem
            .makeDirectory(directory, options)
            .pipe(
              Effect.tap(() =>
                directory === inputTransaction ? fileSystem.symlink(outside, input) : Effect.void,
              ),
            ),
      });
      const inputError = yield* publishRun(
        { ...storage, fileSystem: injectedFileSystem },
        run,
        definition,
        source,
        inputTransactionId,
      ).pipe(Effect.flip);
      assert.strictEqual(inputError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      assert.isFalse(yield* fileSystem.exists(runDirectory(storage, id, run.id)));
      const canonical = yield* loadSchedule(storage, id);
      assert.strictEqual(canonical?.view.kind, "ready");
      if (canonical?.view.kind === "ready") {
        assert.strictEqual(canonical.view.definition.revision, definition.revision);
      }
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("terminalizes an earlier claim when a later schedule history read fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-cycle-read-failure-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000070"),
      };
      const firstId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000071");
      const secondId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000072");
      const firstDefinition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000073"),
        name: "first",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const secondDefinition: Schedule.ScheduleDefinition = {
        ...firstDefinition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000074"),
        name: "second",
      };
      yield* bootstrap(storage);
      yield* publishDefinition(
        storage,
        firstId,
        "enabled",
        firstDefinition,
        { script: null, prompt: "first" },
        "first-definition",
      );
      yield* publishDefinition(
        storage,
        secondId,
        "enabled",
        secondDefinition,
        { script: null, prompt: "second" },
        "second-definition",
      );
      const firstRunId = Schedule.ScheduleRunId.make(`scheduled-1000-${firstDefinition.revision}`);
      const firstRunDirectory = runDirectory(storage, firstId, firstRunId);
      const secondRuns = path.join(schedulesDir, "runs", secondId);
      yield* fileSystem.makeDirectory(secondRuns);
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readDirectory: (directory) =>
          directory === secondRuns
            ? fileSystem
                .exists(firstRunDirectory)
                .pipe(
                  Effect.flatMap((firstClaimed) =>
                    firstClaimed
                      ? Effect.fail(permissionDenied("readDirectory", directory))
                      : fileSystem.readDirectory(directory),
                  ),
                )
            : fileSystem.readDirectory(directory),
      });

      yield* Effect.gen(function* () {
        const schedules = yield* make(schedulesDir);
        const host: Schedule.ScheduleRunHost = {
          prepare: () => Effect.die("Claimed runs must not dispatch after the scan fails"),
          deliver: () => Effect.die("Claimed runs must not dispatch after the scan fails"),
          publish: () => Effect.die("Claimed runs must not dispatch after the scan fails"),
          runPrompt: () => Effect.die("Claimed runs must not dispatch after the scan fails"),
        };
        yield* TestClock.setTime(1_000);
        yield* schedules.start(host);
        const terminal = yield* awaitFinished(fileSystem, path.join(firstRunDirectory, "run.json"));
        assert.deepStrictEqual(terminal.state.kind === "finished" && terminal.state.outcome, {
          kind: "interrupted",
          phase: "schedule-cycle",
        });
        assert.deepStrictEqual(yield* fileSystem.readDirectory(secondRuns), []);
      }).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("terminalizes every missed claim when one finalization fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-cycle-missed-failure-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000080"),
      };
      const firstId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000081");
      const secondId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000082");
      const firstDefinition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000083"),
        name: "first missed",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const secondDefinition: Schedule.ScheduleDefinition = {
        ...firstDefinition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000084"),
        name: "second missed",
      };
      yield* bootstrap(storage);
      yield* publishDefinition(
        storage,
        firstId,
        "enabled",
        firstDefinition,
        { script: null, prompt: "first" },
        "first-missed-definition",
      );
      yield* publishDefinition(
        storage,
        secondId,
        "enabled",
        secondDefinition,
        { script: null, prompt: "second" },
        "second-missed-definition",
      );
      const firstRunId = Schedule.ScheduleRunId.make(`scheduled-1000-${firstDefinition.revision}`);
      const secondRunId = Schedule.ScheduleRunId.make(
        `scheduled-1000-${secondDefinition.revision}`,
      );
      const firstRunFile = path.join(runDirectory(storage, firstId, firstRunId), "run.json");
      const secondRunFile = path.join(runDirectory(storage, secondId, secondRunId), "run.json");
      let rejectedFinalization = false;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) => {
          if (
            !rejectedFinalization &&
            to === firstRunFile &&
            path.basename(from).startsWith(".run.json-")
          ) {
            rejectedFinalization = true;
            return Effect.fail(permissionDenied("rename", from));
          }
          return fileSystem.rename(from, to);
        },
      });

      yield* Effect.gen(function* () {
        const schedules = yield* make(schedulesDir);
        const host: Schedule.ScheduleRunHost = {
          prepare: () => Effect.die("Missed runs must not dispatch"),
          deliver: () => Effect.die("Missed runs must not dispatch"),
          publish: () => Effect.die("Missed runs must not dispatch"),
          runPrompt: () => Effect.die("Missed runs must not dispatch"),
        };
        yield* TestClock.setTime(3 * 60 * 60 * 1_000);
        yield* schedules.start(host);
        const first = yield* awaitFinished(fileSystem, firstRunFile);
        const second = yield* awaitFinished(fileSystem, secondRunFile);
        for (const terminal of [first, second]) {
          assert.deepStrictEqual(terminal.state.kind === "finished" && terminal.state.outcome, {
            kind: "interrupted",
            phase: "schedule-cycle",
          });
        }
      }).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("reports a primary run failure once when finalization also fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-run-finalizer-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const logs = yield* captureLogs();
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          path.basename(to) === "run.json"
            ? Effect.fail(permissionDenied("rename", from))
            : fileSystem.rename(from, to),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const schedules = yield* make(schedulesDir);
          yield* TestClock.setTime(1_000);
          yield* schedules.start({
            prepare: () =>
              Effect.fail(new Schedule.ScheduleHostError({ message: "private target detail" })),
            deliver: () => Effect.die("Failed targets cannot deliver"),
            publish: () => Effect.die("Failed targets cannot publish"),
            runPrompt: () => Effect.die("Failed targets cannot run"),
          });
          const created = yield* schedules.create(caller, {
            name: "private schedule name",
            enabled: true,
            target: { kind: "current-chat" },
            trigger: { kind: "once", at: 1_000 },
            prompt: "private prompt",
          });
          assert.strictEqual(created.kind, "ready");
          if (created.kind !== "ready") return;
          const finalized = yield* awaitLog(logs.events, "finalize");
          const runId = `scheduled-1000-${created.definition.revision}`;
          assert.strictEqual(finalized.annotations.runId, runId);
          const failures = logs.entries.filter((entry) => entry.level === "Error");
          assert.deepStrictEqual(
            failures.map((entry) => entry.annotations.phase),
            ["target", "finalize"],
          );
          assert.isTrue(failures.every((entry) => entry.annotations.scheduleId === created.id));
          assert.strictEqual(failures[0]?.annotations.outcome, "failed");
          assert.strictEqual(failures[0]?.annotations.persisted, false);
          const durable = yield* fileSystem
            .readFileString(path.join(schedulesDir, "runs", created.id, runId, "run.json"))
            .pipe(Effect.flatMap(decodeRun));
          assert.strictEqual(durable.state.kind, "claimed");
        }),
      ).pipe(
        Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
        Effect.provide(logs.layer),
      );
      assert.strictEqual(logs.entries.filter((entry) => entry.level === "Error").length, 2);
      assert.notInclude(JSON.stringify(logs.entries), "private");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "terminalizes and reports a detached execution defect without exposing its contents",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-run-defect-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const logs = yield* captureLogs();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const schedules = yield* make(schedulesDir);
            yield* TestClock.setTime(1_000);
            yield* schedules.start({
              prepare: () => Effect.die(new Error("private SDK payload")),
              deliver: () => Effect.die("Failed targets cannot deliver"),
              publish: () => Effect.die("Failed targets cannot publish"),
              runPrompt: () => Effect.die("Failed targets cannot run"),
            });
            const created = yield* schedules.create(caller, {
              name: "defect",
              enabled: true,
              target: { kind: "current-chat" },
              trigger: { kind: "once", at: 1_000 },
              prompt: "private prompt",
            });
            assert.strictEqual(created.kind, "ready");
            if (created.kind !== "ready") return;
            const terminal = yield* awaitLog(logs.events, "target");
            assert.strictEqual(terminal.level, "Error");
            assert.strictEqual(terminal.annotations.category, "defect");
            const durable = yield* awaitFinished(
              fileSystem,
              path.join(
                schedulesDir,
                "runs",
                created.id,
                `scheduled-1000-${created.definition.revision}`,
                "run.json",
              ),
            );
            assert.deepInclude(durable.state.kind === "finished" ? durable.state.outcome : {}, {
              kind: "failed",
              stage: "target",
            });
          }),
        ).pipe(Effect.provide(logs.layer));
        assert.strictEqual(logs.entries.filter((entry) => entry.level === "Error").length, 1);
        assert.notInclude(JSON.stringify(logs.entries), "private");
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("keeps user aborts and scheduler interruption out of error logs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-run-cancel-" });
      const logs = yield* captureLogs();
      for (const mode of ["aborted", "interrupted"] as const) {
        const schedulesDir = AbsolutePath.make(path.join(root, mode));
        const started = yield* Deferred.make<void>();
        const created = yield* Effect.scoped(
          Effect.gen(function* () {
            const schedules = yield* make(schedulesDir);
            yield* TestClock.setTime(1_000);
            yield* schedules.start({
              prepare: (target) =>
                Effect.succeed({
                  chatId: target.chatId,
                  workspaceId: target.ownerWorkspaceId,
                  cwd: AbsolutePath.make(root),
                }),
              deliver: () => Effect.die("Cancelled runs cannot deliver"),
              publish: () => Effect.die("Cancelled runs cannot publish"),
              runPrompt: (_chatId, runId) =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(
                    mode === "interrupted"
                      ? Effect.never
                      : Effect.succeed({
                          runId,
                          outcome: "aborted",
                          events: [],
                          finalAssistantText: "",
                        } satisfies CapturedAgentRun),
                  ),
                ),
            });
            const created = yield* schedules.create(caller, {
              name: mode,
              enabled: true,
              target: { kind: "current-chat" },
              trigger: { kind: "once", at: 1_000 },
              prompt: "private cancellation prompt",
            });
            yield* Deferred.await(started);
            if (mode === "aborted") yield* awaitLog(logs.events, "omp");
            return created;
          }),
        ).pipe(Effect.provide(logs.layer));
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        const durable = yield* awaitFinished(
          fileSystem,
          path.join(
            schedulesDir,
            "runs",
            created.id,
            `scheduled-1000-${created.definition.revision}`,
            "run.json",
          ),
        );
        assert.deepInclude(durable.state.kind === "finished" ? durable.state.outcome : {}, {
          kind: mode === "aborted" ? "failed" : "interrupted",
        });
      }
      assert.deepStrictEqual(
        logs.entries.filter((entry) => entry.level === "Error"),
        [],
      );
      assert.notInclude(JSON.stringify(logs.entries), "private");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("discards journal-free staging but retains corrupt and unreadable replacements", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-recovery-journal-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("unused"),
      };
      const logs = yield* captureLogs();
      yield* bootstrap(storage);
      const abandoned = path.join(schedulesDir, ".staging", "definition-abandoned");
      yield* fileSystem.makeDirectory(abandoned);
      yield* bootstrap(storage).pipe(Effect.provide(logs.layer));
      assert.isFalse(yield* fileSystem.exists(abandoned));
      assert.deepStrictEqual(
        logs.entries.filter((entry) => entry.level === "Error"),
        [],
      );

      const transaction = path.join(schedulesDir, ".staging", "replace-broken");
      const previous = path.join(transaction, "previous");
      const journal = path.join(transaction, "transaction.json");
      const retained = path.join(previous, "meta.json");
      yield* fileSystem.makeDirectory(previous, { recursive: true });
      yield* fileSystem.writeFileString(retained, "retained definition");
      const absent = yield* bootstrap(storage).pipe(Effect.flip);
      assert.strictEqual(absent.kind, "corrupt");
      assert.strictEqual(yield* fileSystem.readFileString(retained), "retained definition");
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
  it.effect("warns again only after an invalid definition returns to a valid state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-invalid-scan-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const logs = yield* captureLogs();
      const scans = yield* Queue.unbounded<void>();
      let observeScans = false;
      const observedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readDirectory: (directory) =>
          fileSystem
            .readDirectory(directory)
            .pipe(
              Effect.tap(() =>
                observeScans && directory === path.join(schedulesDir, "disabled")
                  ? Queue.offer(scans, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const schedules = yield* open(schedulesDir);
          const created = yield* schedules.create(caller, {
            name: "invalid definition",
            enabled: false,
            target: { kind: "current-chat" },
            trigger: { kind: "once", at: 1_000 },
            prompt: "private prompt",
          });
          assert.strictEqual(created.kind, "ready");
          if (created.kind !== "ready") return;
          const metadata = path.join(schedulesDir, "disabled", created.id, "meta.json");
          const validSource = yield* fileSystem.readFileString(metadata);
          yield* fileSystem.writeFileString(metadata, '{"private":"invalid metadata"}');
          yield* schedules.start({
            prepare: () => Effect.die("Disabled schedules cannot execute"),
            deliver: () => Effect.die("Disabled schedules cannot execute"),
            publish: () => Effect.die("Disabled schedules cannot execute"),
            runPrompt: () => Effect.die("Disabled schedules cannot execute"),
          });
          const invalid = yield* awaitLog(logs.events, "definition");
          assert.strictEqual(invalid.level, "Warn");
          assert.strictEqual(invalid.annotations.scheduleId, created.id);
          observeScans = true;
          const advanceScan = Effect.gen(function* () {
            yield* TestClock.adjust("30 seconds");
            yield* Queue.take(scans);
            yield* schedules.setEnabled(caller, created.id, false).pipe(Effect.exit);
          });
          yield* advanceScan;
          yield* advanceScan;
          assert.strictEqual(
            logs.entries.filter((entry) => entry.annotations.phase === "definition").length,
            1,
          );
          yield* fileSystem.writeFileString(metadata, validSource);
          yield* advanceScan;
          yield* fileSystem.writeFileString(metadata, '{"private":"invalid again"}');
          yield* advanceScan;
          yield* awaitLog(logs.events, "definition");
        }),
      ).pipe(
        Effect.provide(logs.layer),
        Effect.provideService(FileSystem.FileSystem, observedFileSystem),
      );
      assert.strictEqual(
        logs.entries.filter((entry) => entry.annotations.phase === "definition").length,
        2,
      );
      assert.notInclude(JSON.stringify(logs.entries), "private");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
