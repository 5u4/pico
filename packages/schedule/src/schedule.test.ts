import { assert, describe, it } from "@effect/vitest";
import * as Agent from "@pico/contract/agent-message";
import type { CapturedAgentRun } from "@pico/contract/agent-runtime";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import {
  bootstrap,
  loadSchedule,
  publishDefinition,
  updateDefinition,
} from "./definition-storage.ts";
import { publishRun, runDirectory } from "./run-storage.ts";
import { make, open } from "./schedule.ts";
import {
  awaitExists,
  awaitFinished,
  caller,
  capturedRun,
  captureLogs,
  chatId,
  decodeDefinition,
  decodeRun,
  decodeScriptResult,
  permissionDenied,
  platformLayer,
  prepareSource,
  resolveTarget,
  type ScheduleLog,
  textPrompt,
  workspaceId,
} from "./schedule-test-fixtures.ts";
import type { Storage } from "./storage.ts";

const awaitLog = Effect.fn("Schedules.test.awaitLog")(function* (
  events: Queue.Queue<ScheduleLog>,
  phase: string,
) {
  for (;;) {
    const entry = yield* Queue.take(events);
    if (entry.annotations.phase === phase) return entry;
  }
});

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

describe("Schedules", () => {
  it.effect("initializes direct construction when the runner starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedules-start-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* make(schedulesDir, resolveTarget);
        const cwd = AbsolutePath.make(root);
        yield* schedules.start({
          scriptTarget: defaultScriptTarget,
          resolveTarget,
          materialize: ({ destination }) =>
            Effect.succeed(resolveMaterializedTarget(destination, cwd)),
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
        const schedules = yield* make(schedulesDir, resolveTarget);
        const host: Schedule.ScheduleRunHost = {
          scriptTarget: defaultScriptTarget,
          resolveTarget,
          materialize: ({ destination }) =>
            Effect.succeed(resolveMaterializedTarget(destination, cwd)),
          deliver: () => Effect.die("script-only schedules must not deliver agent output"),
          publish: (_targetChatId, content) => Queue.offer(published, content).pipe(Effect.asVoid),
          runPrompt: () => Effect.die("script-only schedules must not invoke OMP"),
        };

        yield* TestClock.setTime(1_000);
        yield* schedules.start(host);
        const created = yield* schedules.create(caller, {
          name: "one shot",
          enabled: true,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({
            "script.js":
              'let input="";for await(const chunk of Bun.stdin.stream())input+=new TextDecoder().decode(chunk);JSON.parse(input);process.stdout.write(JSON.stringify({agent:false,content:"done"}));',
          }),
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
        assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, "definition.json")));
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
        const disabled = yield* schedules.get(caller, created.id);
        if (disabled.kind !== "ready") return yield* Effect.die("Completed schedule disappeared");
        yield* fileSystem.writeFileString(
          path.join(disabled.sourceDirectory, "script.js"),
          'process.stdout.write(JSON.stringify({agent:false,content:"done again"}));',
        );
        const replaced = yield* schedules.update(caller, created.id, {
          name: "one shot updated",
        });
        assert.strictEqual(replaced.kind, "ready");
        if (replaced.kind !== "ready") return;
        assert.notStrictEqual(replaced.definition.revision, created.definition.revision);
        yield* schedules.update(caller, created.id, { enabled: true });
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

  it.effect("isolates unreadable source captures and retries them after repair", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-capture-isolation-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      let unreadableHelper: string | undefined;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        copyFile: (from, to) =>
          from === unreadableHelper
            ? Effect.fail(permissionDenied("copyFile", from))
            : fileSystem.copyFile(from, to),
      });
      const schedules = yield* open(schedulesDir, resolveTarget).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
      const created: Array<Schedule.ReadyScheduleView> = [];
      for (const name of ["one", "two", "three"]) {
        const view = yield* schedules.create(caller, {
          name,
          enabled: true,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({
            "script.js":
              'import { content } from "./lib/helper.js";process.stdout.write(JSON.stringify({agent:false,content}));',
            "lib/helper.js": `export const content = ${JSON.stringify(name)};`,
          }),
        });
        if (view.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
        created.push(view);
      }
      const [first, blocked, last] = created.sort((a, b) => a.id.localeCompare(b.id));
      if (first === undefined || blocked === undefined || last === undefined) {
        return yield* Effect.die("Expected three schedules");
      }
      unreadableHelper = path.join(blocked.sourceDirectory, "lib/helper.js");
      const published: Array<string> = [];
      const publishedEvents = yield* Queue.unbounded<void>();
      yield* TestClock.setTime(1_000);
      yield* schedules.start({
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: ({ destination }) =>
          Effect.succeed(resolveMaterializedTarget(destination, AbsolutePath.make(root))),
        deliver: () => Effect.die("Script must publish without OMP"),
        publish: (_chatId, content) =>
          Effect.sync(() => void published.push(content)).pipe(
            Effect.andThen(Queue.offer(publishedEvents, undefined)),
            Effect.asVoid,
          ),
        runPrompt: () => Effect.die("Script must not invoke OMP"),
      });
      yield* Queue.take(publishedEvents);
      yield* Queue.take(publishedEvents);
      for (const view of [first, last]) {
        const runId = `scheduled-1000-${view.definition.revision}`;
        const run = yield* awaitFinished(
          fileSystem,
          path.join(schedulesDir, "runs", view.id, runId, "run.json"),
        );
        assert.deepStrictEqual(run.state.kind === "finished" && run.state.outcome, {
          kind: "published",
          content: view.definition.name,
        });
      }
      assert.sameMembers(published, [first.definition.name, last.definition.name]);
      // Wait for the queued creation wake's retry to release the capture lock.
      assert.strictEqual((yield* schedules.get(caller, blocked.id)).state, "enabled");
      assert.isFalse(yield* fileSystem.exists(path.join(schedulesDir, "runs", blocked.id)));
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, ".staging")),
        [],
      );
      unreadableHelper = undefined;
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(publishedEvents);
      const recoveredId = `scheduled-1000-${blocked.definition.revision}`;
      const recovered = yield* awaitFinished(
        fileSystem,
        path.join(schedulesDir, "runs", blocked.id, recoveredId, "run.json"),
      );
      assert.deepStrictEqual(recovered.state.kind === "finished" && recovered.state.outcome, {
        kind: "published",
        content: blocked.definition.name,
      });
      assert.sameMembers(published, ["one", "two", "three"]);
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
      const delivered = yield* Deferred.make<Agent.AgentAssistantMessage>();
      const schedules = yield* make(schedulesDir, resolveTarget);
      const finalMessage: Agent.AgentAssistantMessage = {
        role: "assistant",
        id: Agent.AgentMessageId.make("final-captured-assistant"),
        status: "completed",
        stopReason: "stop",
        content: [
          { type: "thinking", text: "private reasoning" },
          { type: "text", text: "fin" },
          { type: "text", text: "ished" },
        ],
        model: "test",
        timestamp: 1,
      };
      const host: Schedule.ScheduleRunHost = {
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: ({ destination }) =>
          Effect.succeed(resolveMaterializedTarget(destination, cwd)),
        deliver: (_target, content) => Deferred.succeed(delivered, content).pipe(Effect.asVoid),
        publish: () => Effect.die("agent output must not be persisted twice"),
        runPrompt: (_target, runId, prompt, onEvent) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(prompt, textPrompt("Inspect the workspace."));
            const events: CapturedAgentRun["events"] = [
              { type: "run-started" },
              {
                type: "message-settled",
                message: {
                  ...finalMessage,
                  id: Agent.AgentMessageId.make("earlier-captured-assistant"),
                },
              },
              { type: "message-settled", message: finalMessage },
              {
                type: "message-settled",
                message: {
                  role: "user",
                  content: [{ type: "text", text: "interleaved" }],
                  timestamp: 2,
                },
              },
              { type: "run-finished", outcome: "completed" },
            ];
            for (const event of events) yield* onEvent(event);
            yield* Deferred.succeed(invoked, undefined);
            return {
              runId,
              outcome: "completed",
              events,
              finalAssistantText: "finished",
            };
          }),
      };

      yield* TestClock.setTime(0);
      yield* schedules.start(host);
      const created = yield* schedules.create(caller, {
        name: "hourly",
        enabled: false,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "cron", expression: "0 * * * *", timeZone: "UTC" },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Inspect the workspace." }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      yield* TestClock.setTime(3 * 60 * 60 * 1_000 + 30_000);
      yield* schedules.update(caller, created.id, { enabled: true });
      const scheduleRuns = path.join(schedulesDir, "runs", created.id);
      yield* awaitExists(fileSystem, scheduleRuns);
      yield* Deferred.await(invoked);
      assert.deepStrictEqual(yield* Deferred.await(delivered), finalMessage);
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

  it.effect("records target sender failures as publish failures for both reminder paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const agent of [true, false]) {
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-send-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const cwd = AbsolutePath.make(root);
        const attempted = yield* Deferred.make<void>();
        const reject = yield* Deferred.make<void>();
        const send = () =>
          Deferred.succeed(attempted, undefined).pipe(
            Effect.andThen(Deferred.await(reject)),
            Effect.andThen(
              Effect.fail(
                new Schedule.ScheduleHostError({
                  message: "Destination unavailable",
                }),
              ),
            ),
          );
        yield* TestClock.setTime(1_000);
        const schedules = yield* open(schedulesDir, resolveTarget);
        const created = yield* schedules.create(caller, {
          name: "unreachable reminder",
          enabled: true,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource(
            agent
              ? { "prompt.md": "reminder" }
              : {
                  "script.js":
                    'process.stdout.write(JSON.stringify({agent:false,content:"reminder"}));',
                },
          ),
        });
        if (created.kind !== "ready") return yield* Effect.die("Schedule was not created");
        const updated = yield* schedules.update(caller, created.id, {
          name: "updated unreachable reminder",
        });
        if (updated.kind !== "ready") return yield* Effect.die("Schedule update failed");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const restarted = yield* make(schedulesDir, resolveTarget);
            yield* restarted.start({
              scriptTarget: defaultScriptTarget,
              resolveTarget,
              materialize: ({ destination }) =>
                Effect.succeed(resolveMaterializedTarget(destination, cwd)),
              deliver: send,
              publish: send,
              runPrompt: (_chatId, runId) => Effect.succeed(capturedRun(runId, "reminder")),
            });
            yield* Deferred.await(attempted);
            const runFile = path.join(
              schedulesDir,
              "runs",
              updated.id,
              `scheduled-1000-${updated.definition.revision}`,
              "run.json",
            );
            const waiting = yield* decodeRun(yield* fileSystem.readFileString(runFile));
            assert.notStrictEqual(waiting.state.kind, "finished");
            yield* Deferred.succeed(reject, undefined);
            const finished = yield* awaitFinished(fileSystem, runFile);
            assert.deepStrictEqual(finished.state.kind === "finished" && finished.state.outcome, {
              kind: "failed",
              stage: "publish",
              message: "Destination unavailable",
              notification: { kind: "failed", message: "Destination unavailable" },
            });
          }),
        );
      }
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
      const notifications: Array<string> = [];
      const schedules = yield* make(schedulesDir, resolveTarget);
      const host: Schedule.ScheduleRunHost = {
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: ({ destination }) =>
          Effect.succeed(resolveMaterializedTarget(destination, cwd)),
        deliver: () =>
          Effect.sync(() => {
            deliveries += 1;
          }),
        publish: (_chatId, content) => Effect.sync(() => void notifications.push(content)),
        runPrompt: (_target, runId, prompt) =>
          Effect.sync(() => requests.set(runId, prompt)).pipe(
            Effect.as(capturedRun(runId, "finished")),
          ),
      };

      yield* TestClock.setTime(1_000);
      yield* schedules.start(host);
      const skip = yield* schedules.create(caller, {
        name: "skip",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": "process.stdout.write(JSON.stringify({agent:false}))",
        }),
      });
      const composed = yield* schedules.create(caller, {
        name: "composed",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js":
            'process.stdout.write(JSON.stringify({agent:true,content:"generated input"}))',
          "prompt.md": "stored prompt",
        }),
      });
      const scriptOnly = yield* schedules.create(caller, {
        name: "script only",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": 'process.stdout.write(JSON.stringify({agent:true,content:"script input"}))',
        }),
      });
      const storedPrompt = yield* schedules.create(caller, {
        name: "stored prompt",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": "process.stdout.write(JSON.stringify({agent:true}))",
          "prompt.md": "prompt input",
        }),
      });
      const missingInput = yield* schedules.create(caller, {
        name: "missing input",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": "process.stdout.write(JSON.stringify({agent:true}))",
        }),
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
        { kind: "failed", stage: "protocol", notification: { kind: "delivered" } },
      );
      assert.strictEqual(notifications.length, 1);
      const missingInputOutcome =
        missingInputRun.state.kind === "finished" ? missingInputRun.state.outcome : undefined;
      if (missingInputOutcome?.kind !== "failed") {
        return yield* Effect.die("Expected missing input failure");
      }
      assert.include(notifications[0] ?? "", missingInputRun.id);
      assert.include(notifications[0] ?? "", missingInputOutcome.message);
      assert.strictEqual(deliveries, 3);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("admits manual once runs before due and consumes the schedule", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-manual-once-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const published: Array<string> = [];
      const schedules = yield* make(schedulesDir, resolveTarget);
      yield* TestClock.setTime(1_000);
      yield* schedules.start({
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: ({ destination }) =>
          Effect.succeed(resolveMaterializedTarget(destination, cwd)),
        deliver: () => Effect.die("Manual script runs must publish without OMP"),
        publish: (_chatId, content) =>
          Effect.sync(() => void published.push(content)).pipe(Effect.asVoid),
        runPrompt: () => Effect.die("Manual script runs must not invoke OMP"),
      });
      const created = yield* schedules.create(caller, {
        name: "manual once",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": 'process.stdout.write(JSON.stringify({agent:false,content:"manual"}));',
        }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      const admitted = yield* schedules.trigger(caller, created.id);
      const run = yield* awaitFinished(
        fileSystem,
        path.join(schedulesDir, "runs", created.id, admitted.runId, "run.json"),
      );
      assert.strictEqual(run.source.kind, "manual");
      assert.deepStrictEqual(run.state.kind === "finished" && run.state.outcome, {
        kind: "published",
        content: "manual",
      });
      assert.deepStrictEqual(published, ["manual"]);
      yield* awaitExists(fileSystem, path.join(schedulesDir, "disabled", created.id, "meta.json"));
      const disabled = yield* schedules.get(caller, created.id);
      assert.strictEqual(disabled.kind, "ready");
      if (disabled.kind !== "ready") return;
      assert.strictEqual(disabled.state, "disabled");
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, "runs", created.id)),
        [admitted.runId],
      );
      assert.deepStrictEqual(published, ["manual"]);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("admits manual and timed once runs atomically", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-admission-race-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const schedules = yield* make(schedulesDir, resolveTarget);
      yield* TestClock.setTime(1_000);
      yield* schedules.start({
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: ({ destination }) =>
          Effect.succeed(resolveMaterializedTarget(destination, cwd)),
        deliver: () => Effect.die("Race script runs must publish without OMP"),
        publish: () => Effect.void,
        runPrompt: () => Effect.die("Race script runs must not invoke OMP"),
      });
      const created = yield* schedules.create(caller, {
        name: "admission race",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 2_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": 'process.stdout.write(JSON.stringify({agent:false,content:"race"}));',
        }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      yield* TestClock.setTime(2_000);
      const [triggerExit] = yield* Effect.all(
        [schedules.trigger(caller, created.id).pipe(Effect.exit), TestClock.adjust("30 seconds")],
        { concurrency: "unbounded" },
      );
      const runIds = yield* fileSystem.readDirectory(path.join(schedulesDir, "runs", created.id));
      assert.strictEqual(runIds.length, 1);
      const runId = runIds[0];
      if (runId === undefined) return yield* Effect.die("Expected one admitted run");
      const terminal = yield* awaitFinished(
        fileSystem,
        path.join(schedulesDir, "runs", created.id, runId, "run.json"),
      );
      assert.deepStrictEqual(terminal.state.kind === "finished" && terminal.state.outcome, {
        kind: "published",
        content: "race",
      });
      if (Exit.isSuccess(triggerExit)) {
        assert.strictEqual(triggerExit.value.runId, terminal.id);
      } else {
        const reason = triggerExit.cause.reasons.find(Cause.isFailReason)?.error;
        assert.instanceOf(reason, Schedule.ScheduleError);
        if (reason instanceof Schedule.ScheduleError) {
          assert.strictEqual(reason.kind, "busy");
        }
      }
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("keeps admitted manual runs alive after trigger caller cancellation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-manual-daemon-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const published = yield* Queue.unbounded<string>();
      const schedules = yield* make(schedulesDir, resolveTarget);
      yield* TestClock.setTime(1_000);
      yield* schedules.start({
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: ({ destination }) =>
          Effect.succeed(resolveMaterializedTarget(destination, cwd)),
        deliver: () => Effect.die("Manual daemon run must publish without OMP"),
        publish: (_chatId, content) => Queue.offer(published, content).pipe(Effect.asVoid),
        runPrompt: () => Effect.die("Manual daemon run must not invoke OMP"),
      });
      const created = yield* schedules.create(caller, {
        name: "manual daemon",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({
          "script.js":
            'await Bun.sleep(50);process.stdout.write(JSON.stringify({agent:false,content:"daemon"}));',
        }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      const admitted = yield* Deferred.make<{ readonly runId: Schedule.ScheduleRunId }>();
      const callerFiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const run = yield* schedules.trigger(caller, created.id);
          yield* Deferred.succeed(admitted, { runId: run.runId });
          yield* Effect.never;
        }),
      ).pipe(Effect.forkChild);
      const run = yield* Deferred.await(admitted);
      yield* Fiber.interrupt(callerFiber);
      assert.strictEqual(yield* Queue.take(published), "daemon");
      const terminal = yield* awaitFinished(
        fileSystem,
        path.join(schedulesDir, "runs", created.id, run.runId, "run.json"),
      );
      assert.deepStrictEqual(terminal.state.kind === "finished" && terminal.state.outcome, {
        kind: "published",
        content: "daemon",
      });
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("reports script failures once with both captured streams", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-failure-report-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const notifications: Array<string> = [];
      const schedules = yield* make(schedulesDir, resolveTarget);
      yield* TestClock.setTime(1_000);
      yield* schedules.start({
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: ({ destination }) =>
          Effect.succeed(resolveMaterializedTarget(destination, cwd)),
        deliver: () => Effect.die("Failure runs must not deliver agent messages"),
        publish: (_chatId, content) =>
          Effect.sync(() => void notifications.push(content)).pipe(
            Effect.andThen(
              Effect.fail(new Schedule.ScheduleHostError({ message: "notification rejected" })),
            ),
          ),
        runPrompt: () => Effect.die("Failure runs must not invoke OMP"),
      });
      const created = yield* schedules.create(caller, {
        name: "failure report",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js":
            'process.stderr.write("stderr signal\\n");process.stdout.write("stdout signal\\n");process.exit(2);',
        }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
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
      assert.strictEqual(notifications.length, 1);
      const notification = notifications[0];
      if (notification === undefined) return yield* Effect.die("Missing failure notification");
      assert.include(notification, run.id);
      assert.include(notification, created.definition.name);
      assert.include(notification, "stderr");
      assert.include(notification, "stderr signal");
      assert.include(notification, "stdout");
      assert.include(notification, "stdout signal");
      assert.deepInclude(run.state.kind === "finished" ? run.state.outcome : {}, {
        kind: "failed",
        stage: "script",
        notification: { kind: "failed", message: "notification rejected" },
      });
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "preserves the original failure when notification interruption needs restart recovery",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-report-recovery-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const notifying = yield* Deferred.make<string>();
        let rejectFinalization = false;
        const failingFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          rename: (from, to) =>
            rejectFinalization && path.basename(to) === "run.json"
              ? Effect.fail(permissionDenied("rename", from))
              : fileSystem.rename(from, to),
        });
        yield* TestClock.setTime(1_000);
        const created = yield* Effect.scoped(
          Effect.gen(function* () {
            const schedules = yield* make(schedulesDir, resolveTarget);
            yield* schedules.start({
              scriptTarget: defaultScriptTarget,
              resolveTarget,
              materialize: ({ destination }) =>
                Effect.succeed(resolveMaterializedTarget(destination, AbsolutePath.make(root))),
              deliver: () => Effect.die("Script failures must not deliver agent messages"),
              publish: (_chatId, content) =>
                Effect.sync(() => {
                  rejectFinalization = true;
                }).pipe(
                  Effect.andThen(Deferred.succeed(notifying, content)),
                  Effect.andThen(Effect.never),
                ),
              runPrompt: () => Effect.die("Script failures must not invoke OMP"),
            });
            const created = yield* schedules.create(caller, {
              name: "interrupted failure report",
              enabled: true,
              target: { kind: "chat", chatId },
              trigger: { kind: "once", at: 1_000 },
              sourceDirectory: yield* prepareSource({
                "script.js": 'process.stderr.write("retained stderr");process.exit(2);',
              }),
            });
            if (created.kind !== "ready") return yield* Effect.die("Expected a ready schedule");
            const notification = yield* Deferred.await(notifying);
            assert.include(notification, "retained stderr");
            return created;
          }),
        ).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem));
        const runId = `scheduled-1000-${created.definition.revision}`;
        const runFile = path.join(schedulesDir, "runs", created.id, runId, "run.json");
        const pending = yield* decodeRun(yield* fileSystem.readFileString(runFile));
        assert.strictEqual(pending.state.kind, "reporting-failure");
        if (pending.state.kind !== "reporting-failure") {
          return yield* Effect.die("Expected durable failure awaiting notification settlement");
        }
        assert.strictEqual(pending.state.outcome.stage, "script");
        const originalFailure = pending.state.outcome;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const restarted = yield* make(schedulesDir, resolveTarget);
            yield* restarted.start({
              scriptTarget: () => Effect.die("Restart must not execute a consumed run"),
              resolveTarget,
              materialize: () => Effect.die("Restart must not recreate a failure destination"),
              deliver: () => Effect.die("Restart must not redeliver"),
              publish: () => Effect.die("Restart must not retry interrupted notification"),
              runPrompt: () => Effect.die("Restart must not invoke OMP"),
            });
            const recovered = yield* awaitFinished(fileSystem, runFile);
            assert.deepStrictEqual(recovered.state.kind === "finished" && recovered.state.outcome, {
              ...originalFailure,
              notification: { kind: "interrupted" },
            });
            assert.strictEqual((yield* restarted.get(caller, created.id)).state, "disabled");
            assert.deepStrictEqual(
              yield* fileSystem.readDirectory(path.join(schedulesDir, "runs", created.id)),
              [runId],
            );
          }),
        );
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "retains materialization failure without allocating a second destination for its report",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-materialize-failure-",
        });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const unexpectedDestination = path.join(root, "unexpected-destination");
        let unavailable = true;
        const schedules = yield* make(schedulesDir, resolveTarget);
        yield* TestClock.setTime(1_000);
        yield* schedules.start({
          scriptTarget: defaultScriptTarget,
          resolveTarget,
          materialize: ({ destination }) =>
            Effect.suspend(() => {
              if (unavailable) {
                unavailable = false;
                return Effect.fail(
                  new Schedule.ScheduleHostError({ message: "Destination unavailable" }),
                );
              }
              return fileSystem.makeDirectory(unexpectedDestination).pipe(
                Effect.mapError(
                  (error) => new Schedule.ScheduleHostError({ message: error.message }),
                ),
                Effect.as(resolveMaterializedTarget(destination, AbsolutePath.make(root))),
              );
            }),
          deliver: () => Effect.die("Materialization failure must not deliver agent messages"),
          publish: () => Effect.die("Materialization failure must not publish"),
          runPrompt: () => Effect.die("Materialization failure must not invoke OMP"),
        });
        const created = yield* schedules.create(caller, {
          name: "unavailable destination",
          enabled: true,
          target: { kind: "workspace", workspaceId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({
            "script.js": 'process.stdout.write(JSON.stringify({agent:false,content:"ready"}));',
          }),
        });
        if (created.kind !== "ready") return yield* Effect.die("Expected a ready schedule");
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
        assert.deepStrictEqual(run.state.kind === "finished" && run.state.outcome, {
          kind: "failed",
          stage: "target",
          message: "Destination unavailable",
          notification: { kind: "failed", message: "Destination unavailable" },
        });
        assert.isFalse(yield* fileSystem.exists(unexpectedDestination));
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "executes claimed helper imports from an unchanged source snapshot after live edits",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-snapshot-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const prepareStarted = yield* Deferred.make<void>();
        const releasePrepare = yield* Deferred.make<void>();
        const published = yield* Queue.unbounded<string>();
        const schedules = yield* open(schedulesDir, resolveTarget);
        yield* TestClock.setTime(1_000);
        yield* schedules.start({
          scriptTarget: defaultScriptTarget,
          resolveTarget,
          materialize: ({ destination }) =>
            Deferred.succeed(prepareStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releasePrepare)),
              Effect.as(resolveMaterializedTarget(destination, AbsolutePath.make(root))),
            ),
          deliver: () => Effect.die("Script decisions must publish without OMP"),
          publish: (_chatId, content) => Queue.offer(published, content).pipe(Effect.asVoid),
          runPrompt: () => Effect.die("Script decisions must not run OMP"),
        });
        const script =
          'import { content } from "./lib/helper.js";process.stdout.write(JSON.stringify({agent:false,content}));';
        const helper = 'export const content = "original helper";';
        const asset = new Uint8Array([0, 255, 10, 128]);
        const created = yield* schedules.create(caller, {
          name: "snapshot",
          enabled: true,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource(
            {
              "script.js": script,
              "prompt.md": "original prompt",
              "lib/helper.js": helper,
              "assets/data.bin": asset,
            },
            ["cache/empty"],
          ),
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(prepareStarted);
        yield* fileSystem.writeFileString(
          path.join(created.sourceDirectory, "lib/helper.js"),
          'export const content = "edited helper";',
        );
        yield* fileSystem.writeFile(
          path.join(created.sourceDirectory, "assets/data.bin"),
          new Uint8Array([42]),
        );
        yield* fileSystem.writeFileString(
          path.join(created.sourceDirectory, "prompt.md"),
          "edited prompt",
        );
        const updated = yield* schedules.update(caller, created.id, {
          name: "edited metadata",
          enabled: false,
        });
        assert.strictEqual(updated.kind, "ready");
        if (updated.kind !== "ready") return;
        assert.notStrictEqual(updated.definition.revision, created.definition.revision);
        yield* Deferred.succeed(releasePrepare, undefined);
        assert.strictEqual(yield* Queue.take(published), "original helper");
        const runId = `scheduled-1000-${created.definition.revision}`;
        const directory = path.join(schedulesDir, "runs", created.id, runId);
        const finished = yield* awaitFinished(fileSystem, path.join(directory, "run.json"));
        assert.deepStrictEqual(finished.state.kind === "finished" && finished.state.outcome, {
          kind: "published",
          content: "original helper",
        });
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "input", "lib/helper.js")),
          helper,
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "input", "script.js")),
          script,
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "input", "prompt.md")),
          "original prompt",
        );
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(directory, "input", "assets/data.bin")),
          asset,
        );
        assert.deepStrictEqual(
          yield* fileSystem.readDirectory(path.join(directory, "input", "cache/empty")),
          [],
        );
        assert.deepStrictEqual(
          yield* decodeDefinition(
            yield* fileSystem.readFileString(path.join(directory, "definition.json")),
          ),
          created.definition,
        );
        yield* schedules.update(caller, created.id, { enabled: true });
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(yield* Queue.take(published), "edited helper");
        const nextRunId = `scheduled-1000-${updated.definition.revision}`;
        const nextDirectory = path.join(schedulesDir, "runs", created.id, nextRunId);
        yield* awaitFinished(fileSystem, path.join(nextDirectory, "run.json"));
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(nextDirectory, "input", "assets/data.bin")),
          new Uint8Array([42]),
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(nextDirectory, "input", "prompt.md")),
          "edited prompt",
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "input", "lib/helper.js")),
          helper,
        );
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(directory, "input", "assets/data.bin")),
          asset,
        );
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("freezes in-flight destinations without disabling a retargeted revision", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-schedule-revision-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(path.join(root, "owner"));
      const destinationCwd = AbsolutePath.make(path.join(root, "destination"));
      const destinationWorkspaceId = Workspace.WorkspaceId.make(
        "018f47a0-0000-7000-8000-000000000099",
      );
      yield* fileSystem.makeDirectory(cwd);
      yield* fileSystem.makeDirectory(destinationCwd);
      const prepareStarted = yield* Deferred.make<void>();
      const releasePrepare = yield* Deferred.make<void>();
      const schedules = yield* make(schedulesDir, resolveTarget);
      const host: Schedule.ScheduleRunHost = {
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: ({ destination }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(prepareStarted, undefined);
            yield* Deferred.await(releasePrepare);
            if (destination.kind !== "workspace") {
              return yield* Effect.die("Expected a workspace destination");
            }
            return {
              chatId: destination.newChatId,
              workspaceId: destination.workspaceId,
              cwd: destination.workspaceId === workspaceId ? cwd : destinationCwd,
            };
          }),
        deliver: (targetChatId, message) =>
          fileSystem
            .writeFileString(
              path.join(root, `${targetChatId}.txt`),
              message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(""),
            )
            .pipe(
              Effect.mapError(
                (error) => new Schedule.ScheduleHostError({ message: error.message }),
              ),
            ),
        publish: () => Effect.void,
        runPrompt: (_target, runId) => Effect.succeed(capturedRun(runId, "old run")),
      };

      yield* TestClock.setTime(1_000);
      yield* schedules.start(host);
      const created = yield* schedules.create(caller, {
        name: "old once",
        enabled: true,
        target: { kind: "workspace", workspaceId: caller.workspaceId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "prompt.md": "old prompt",
          "script.js":
            'await Bun.write("ran.txt",process.env.PICO_WORKSPACE_ID);process.stdout.write(JSON.stringify({agent:true}));',
        }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(prepareStarted);

      yield* fileSystem.writeFileString(
        path.join(created.sourceDirectory, "prompt.md"),
        "new prompt",
      );
      const replaced = yield* schedules.update(caller, created.id, {
        name: "new cron",
        trigger: { kind: "cron", expression: "* * * * *", timeZone: "UTC" },
        target: { kind: "workspace", workspaceId: destinationWorkspaceId },
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
      const originalRun = yield* awaitFinished(fileSystem, runFile);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(path.dirname(runFile), "input", "ran.txt")),
        workspaceId,
      );
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "ran.txt")));
      assert.isFalse(yield* fileSystem.exists(path.join(destinationCwd, "ran.txt")));
      assert.strictEqual(
        yield* fileSystem.readFileString(
          path.join(root, `${originalRun.plannedTarget.chatId}.txt`),
        ),
        "old run",
      );
      assert.strictEqual(originalRun.plannedTarget.ownerWorkspaceId, workspaceId);
      const snapshotFile = path.join(path.dirname(runFile), "definition.json");
      const snapshotBefore = yield* fileSystem.readFileString(snapshotFile);
      const frozen = yield* decodeDefinition(snapshotBefore);
      assert.deepStrictEqual(frozen.target, { kind: "workspace", workspaceId });
      assert.isTrue(yield* fileSystem.exists(path.join(schedulesDir, "enabled", created.id)));
      const current = yield* schedules.get(caller, created.id);
      assert.strictEqual(current.kind, "ready");
      if (current.kind === "ready") {
        assert.strictEqual(current.definition.revision, replaced.definition.revision);
        assert.strictEqual(current.definition.trigger.kind, "cron");
      }
      yield* TestClock.adjust("30 seconds");
      const nextRun = yield* awaitFinished(
        fileSystem,
        path.join(
          schedulesDir,
          "runs",
          created.id,
          `scheduled-60000-${replaced.definition.revision}`,
          "run.json",
        ),
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(
          path.join(schedulesDir, "runs", created.id, nextRun.id, "input", "ran.txt"),
        ),
        destinationWorkspaceId,
      );
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "ran.txt")));
      assert.isFalse(yield* fileSystem.exists(path.join(destinationCwd, "ran.txt")));
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(root, `${nextRun.plannedTarget.chatId}.txt`)),
        "old run",
      );
      assert.strictEqual(nextRun.plannedTarget.ownerWorkspaceId, workspaceId);
      assert.notStrictEqual(nextRun.plannedTarget.chatId, originalRun.plannedTarget.chatId);
      assert.strictEqual(yield* fileSystem.readFileString(snapshotFile), snapshotBefore);
      const restarted = yield* make(schedulesDir, resolveTarget);
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
      const schedules = yield* make(schedulesDir, resolveTarget);
      const host: Schedule.ScheduleRunHost = {
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: ({ destination }) =>
          Effect.succeed(resolveMaterializedTarget(destination, cwd)),
        deliver: () => Effect.void,
        publish: () => Effect.void,
        runPrompt: (_target, runId) =>
          Deferred.succeed(invoked, undefined).pipe(Effect.as(capturedRun(runId, "recovered"))),
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
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 30_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "still alive" }),
      });
      assert.strictEqual(created.kind, "ready");
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(invoked);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("gates reads and running cycles on retained enable rollback recovery", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-enable-recovery-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const enabled = path.join(schedulesDir, "enabled");
      const disabled = path.join(schedulesDir, "disabled");
      let rejectCommitAndRollback = true;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          rejectCommitAndRollback &&
          (path.basename(from) === "next.json" ||
            (path.dirname(from) === enabled && path.dirname(to) === disabled))
            ? Effect.fail(permissionDenied("rename", from))
            : fileSystem.rename(from, to),
      });
      const logs = yield* captureLogs();
      yield* Effect.gen(function* () {
        const schedules = yield* open(schedulesDir, resolveTarget).pipe(
          Effect.provideService(FileSystem.FileSystem, failingFileSystem),
        );
        const published = yield* Queue.unbounded<string>();
        yield* TestClock.setTime(1_000);
        yield* schedules.start({
          scriptTarget: defaultScriptTarget,
          resolveTarget,
          materialize: ({ destination }) =>
            Effect.succeed(resolveMaterializedTarget(destination, AbsolutePath.make(root))),
          deliver: () => Effect.die("Script must publish without OMP"),
          publish: (_chatId, content) => Queue.offer(published, content).pipe(Effect.asVoid),
          runPrompt: () => Effect.die("Script must not invoke OMP"),
        });
        const created = yield* schedules.create(caller, {
          name: "original",
          enabled: false,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({
            "script.js":
              'process.stdout.write(JSON.stringify({agent:false,content:"original script executed"}));',
          }),
        });
        if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
        const error = yield* schedules
          .update(caller, created.id, { enabled: true, name: "uncommitted" })
          .pipe(Effect.flip);
        assert.strictEqual(error.kind, "io");
        assert.isTrue(yield* fileSystem.exists(path.join(enabled, created.id)));
        const getResult = yield* schedules.get(caller, created.id).pipe(Effect.exit);
        const listResult = yield* schedules.list(caller).pipe(Effect.exit);
        yield* TestClock.adjust("30 seconds");
        const cycleResult = yield* Effect.race(
          awaitLog(logs.events, "cycle").pipe(Effect.as("blocked")),
          Queue.take(published),
        );
        assert.deepStrictEqual(
          { get: getResult._tag, list: listResult._tag, cycle: cycleResult },
          { get: "Failure", list: "Failure", cycle: "blocked" },
        );
        assert.deepStrictEqual(
          yield* fileSystem.readDirectory(path.join(schedulesDir, "runs")),
          [],
        );
        rejectCommitAndRollback = false;
        yield* TestClock.adjust("30 seconds");
        yield* awaitLog(logs.events, "update-recovery");
        assert.deepStrictEqual(yield* schedules.get(caller, created.id), created);
        assert.deepStrictEqual(yield* schedules.list(caller), [created]);
        assert.deepStrictEqual(
          yield* fileSystem.readDirectory(path.join(schedulesDir, "runs")),
          [],
        );
        yield* schedules.update(caller, created.id, { enabled: true });
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(yield* Queue.take(published), "original script executed");
        const runId = `scheduled-1000-${created.definition.revision}`;
        const run = yield* awaitFinished(
          fileSystem,
          path.join(schedulesDir, "runs", created.id, runId, "run.json"),
        );
        assert.deepStrictEqual(run.state.kind === "finished" && run.state.outcome, {
          kind: "published",
          content: "original script executed",
        });
      }).pipe(Effect.provide(logs.layer));
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
        const schedules = yield* make(schedulesDir, resolveTarget);
        const host: Schedule.ScheduleRunHost = {
          scriptTarget: defaultScriptTarget,
          resolveTarget,
          materialize: ({ destination }) =>
            Effect.succeed(resolveMaterializedTarget(destination, cwd)),
          deliver: () => Deferred.succeed(delivered, undefined).pipe(Effect.asVoid),
          publish: () => Effect.die("Agent schedules must deliver their final response"),
          runPrompt: (_target, runId) => Effect.succeed(capturedRun(runId, "complete")),
        };
        yield* TestClock.setTime(1_000);
        yield* schedules.start(host);
        const created = yield* schedules.create(caller, {
          name: "disable retry",
          enabled: true,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "complete once" }),
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
        assert.strictEqual(
          (yield* schedules.trigger(caller, created.id).pipe(Effect.flip)).kind,
          "busy",
        );

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
      let rejectedTargetArtifact = false;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFile: (file, data, options) => {
          if (
            !rejectedTargetArtifact &&
            path.basename(path.dirname(file)) === "target" &&
            path.basename(file).startsWith(".result.json-")
          ) {
            rejectedTargetArtifact = true;
            return Effect.fail(permissionDenied("writeFile", file));
          }
          return fileSystem.writeFile(file, data, options);
        },
      });
      yield* Effect.gen(function* () {
        const schedules = yield* make(schedulesDir, resolveTarget);
        const host: Schedule.ScheduleRunHost = {
          scriptTarget: defaultScriptTarget,
          resolveTarget,
          materialize: ({ destination }) =>
            Effect.succeed(resolveMaterializedTarget(destination, cwd)),
          deliver: () => Effect.die("Target failures must not deliver agent output"),
          publish: () => Effect.void,
          runPrompt: () => Effect.die("Target failures must not invoke OMP"),
        };
        yield* TestClock.setTime(1_000);
        yield* schedules.start(host);
        const created = yield* schedules.create(caller, {
          name: "phase retention",
          enabled: true,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "unused" }),
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
          stage: "target",
          notification: { kind: "delivered" },
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
        version: 2,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000062"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const source = yield* prepareSource({ "prompt.md": "original" });
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
      const updateTransaction = path.join(staging, "update-preexisting");
      yield* fileSystem.symlink(outside, updateTransaction);
      const updateError = yield* updateDefinition(
        storage,
        current,
        replacement,
        "disabled",
        "preexisting",
      ).pipe(Effect.flip);
      assert.strictEqual(updateError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      const retained = yield* loadSchedule(storage, id);
      assert.strictEqual(retained?.view.kind, "ready");
      if (retained?.view.kind !== "ready") return;
      assert.strictEqual(retained.view.definition.revision, definition.revision);
      yield* fileSystem.remove(updateTransaction);

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
      const runError = yield* publishRun(
        storage,
        run,
        definition,
        source,
        "preexisting",
        () => Effect.void,
      ).pipe(Effect.flip);
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
        () => Effect.void,
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

  it.effect("owns a run published while interruption is pending at the rename callback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-claim-handoff-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const publishing = yield* Deferred.make<{
        readonly from: string;
        readonly to: string;
        readonly resume: (effect: Effect.Effect<void, PlatformError.PlatformError>) => void;
      }>();
      const gatedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          path.dirname(from) === path.join(schedulesDir, ".staging") &&
          path.basename(from).startsWith("run-")
            ? Effect.callback<void, PlatformError.PlatformError>((resume) => {
                Deferred.doneUnsafe(publishing, Effect.succeed({ from, to, resume }));
              })
            : fileSystem.rename(from, to),
      });
      const schedules = yield* open(schedulesDir, resolveTarget).pipe(
        Effect.provideService(FileSystem.FileSystem, gatedFileSystem),
      );
      yield* schedules.create(caller, {
        name: "publication handoff",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Do not execute." }),
      });
      let prompts = 0;
      yield* TestClock.setTime(1_000);
      const operation = yield* schedules
        .start({
          scriptTarget: defaultScriptTarget,
          resolveTarget,
          materialize: ({ destination }) =>
            Effect.succeed(resolveMaterializedTarget(destination, AbsolutePath.make(root))),
          deliver: () => Effect.void,
          publish: () => Effect.void,
          runPrompt: (_chatId, runId) =>
            Effect.sync(() => {
              prompts++;
              return capturedRun(runId, "unexpected");
            }),
        })
        .pipe(Effect.andThen(Effect.never), Effect.scoped, Effect.forkChild);
      const active = yield* Deferred.await(publishing);
      const shutdown = yield* Fiber.interrupt(operation).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const renamed = yield* fileSystem.rename(active.from, active.to).pipe(Effect.exit);
      active.resume(renamed);
      yield* Fiber.join(shutdown);
      assert.isTrue(Exit.isSuccess(renamed));
      const stopped = yield* Fiber.await(operation);
      assert.isTrue(Exit.isFailure(stopped) && Cause.hasInterruptsOnly(stopped.cause));
      const run = yield* decodeRun(
        yield* fileSystem.readFileString(path.join(active.to, "run.json")),
      );
      assert.deepInclude(run.state.kind === "finished" ? run.state.outcome : {}, {
        kind: "interrupted",
      });
      assert.strictEqual(prompts, 0);
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, ".staging")),
        [],
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "finishes an earlier claim independently of a later schedule history read failure",
    () =>
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
          version: 2,
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
          yield* prepareSource({ "prompt.md": "first" }),
          "first-definition",
        );
        yield* publishDefinition(
          storage,
          secondId,
          "enabled",
          secondDefinition,
          yield* prepareSource({ "prompt.md": "second" }),
          "second-definition",
        );
        const firstRunId = Schedule.ScheduleRunId.make(
          `scheduled-1000-${firstDefinition.revision}`,
        );
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
          const schedules = yield* make(schedulesDir, resolveTarget);
          const host: Schedule.ScheduleRunHost = {
            scriptTarget: defaultScriptTarget,
            resolveTarget,
            materialize: ({ destination }) =>
              Effect.succeed(resolveMaterializedTarget(destination, AbsolutePath.make(root))),
            deliver: () => Effect.void,
            publish: () => Effect.die("Agent runs must deliver their completed response"),
            runPrompt: (_chatId, runId) => Effect.succeed(capturedRun(runId, "first completed")),
          };
          yield* TestClock.setTime(1_000);
          yield* schedules.start(host);
          const terminal = yield* awaitFinished(
            fileSystem,
            path.join(firstRunDirectory, "run.json"),
          );
          assert.deepStrictEqual(terminal.state.kind === "finished" && terminal.state.outcome, {
            kind: "completed",
            finalAssistantText: "first completed",
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
        version: 2,
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
        yield* prepareSource({ "prompt.md": "first" }),
        "first-missed-definition",
      );
      yield* publishDefinition(
        storage,
        secondId,
        "enabled",
        secondDefinition,
        yield* prepareSource({ "prompt.md": "second" }),
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
        const schedules = yield* make(schedulesDir, resolveTarget);
        const host: Schedule.ScheduleRunHost = {
          scriptTarget: defaultScriptTarget,
          resolveTarget,
          materialize: () => Effect.die("Missed runs must not dispatch"),
          deliver: () => Effect.die("Missed runs must not dispatch"),
          publish: () => Effect.die("Missed runs must not dispatch"),
          runPrompt: () => Effect.die("Missed runs must not dispatch"),
        };
        yield* TestClock.setTime(3 * 60 * 60 * 1_000);
        yield* schedules.start(host);
        const first = yield* awaitFinished(fileSystem, firstRunFile);
        const second = yield* awaitFinished(fileSystem, secondRunFile);
        assert.deepStrictEqual(first.state.kind === "finished" && first.state.outcome, {
          kind: "missed",
          scheduledFor: 1_000,
          observedAt: 3 * 60 * 60 * 1_000,
        });
        assert.deepStrictEqual(second.state.kind === "finished" && second.state.outcome, {
          kind: "missed",
          scheduledFor: 1_000,
          observedAt: 3 * 60 * 60 * 1_000,
        });
      }).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  for (const artifact of ["stdout.bin", "stderr.bin", "result.json", "missing"] as const) {
    it.effect(
      artifact === "missing"
        ? "allows missing failure diagnostics without losing the primary failure or notification"
        : `reports unreadable ${artifact} failure diagnostics without losing the primary failure or notification`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "pico-private-diagnostics-",
          });
          const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
          const logs = yield* captureLogs();
          const notifications = yield* Queue.unbounded<string>();
          let unreadableArtifact: string | undefined;
          const failingFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            readFile: (file) =>
              file === unreadableArtifact
                ? Effect.fail(permissionDenied("readFile", file))
                : fileSystem.readFile(file),
            readFileString: (file, encoding) =>
              file === unreadableArtifact
                ? Effect.fail(permissionDenied("readFileString", file))
                : fileSystem.readFileString(file, encoding),
          });
          yield* Effect.gen(function* () {
            const schedules = yield* open(schedulesDir, resolveTarget);
            const created = yield* schedules.create(caller, {
              name: "private diagnostic schedule",
              enabled: true,
              target: { kind: "chat", chatId: caller.chatId },
              trigger: { kind: "once", at: 1_000 },
              sourceDirectory: yield* prepareSource(
                artifact === "missing"
                  ? { "prompt.md": "private prompt" }
                  : {
                      "script.js":
                        'process.stdout.write("private stdout capture");process.stderr.write("private stderr capture");process.exit(7);',
                    },
              ),
            });
            assert.strictEqual(created.kind, "ready");
            if (created.kind !== "ready") return;
            const runId = `scheduled-1000-${created.definition.revision}`;
            const directory = path.join(schedulesDir, "runs", created.id, runId);
            if (artifact !== "missing") {
              unreadableArtifact = path.join(directory, "script", artifact);
            }
            yield* TestClock.setTime(1_000);
            yield* schedules.start({
              scriptTarget: defaultScriptTarget,
              resolveTarget,
              materialize: ({ destination }) =>
                Effect.succeed(resolveMaterializedTarget(destination, AbsolutePath.make(root))),
              deliver: () => Effect.die("Failed runs must not deliver agent messages"),
              publish: (_chatId, content) =>
                Queue.offer(notifications, content).pipe(Effect.asVoid),
              runPrompt: (_chatId, runId) =>
                Effect.succeed({ ...capturedRun(runId, "private agent output"), events: [] }),
            });
            const notification = yield* Queue.take(notifications);
            const run = yield* awaitFinished(fileSystem, path.join(directory, "run.json"));
            const stage = artifact === "missing" ? "omp" : "script";
            const primaryFailure = artifact === "missing" ? /assistant message/ : /status 7/;
            assert.deepInclude(run.state.kind === "finished" ? run.state.outcome : {}, {
              kind: "failed",
              stage,
              notification: { kind: "delivered" },
            });
            if (run.state.kind !== "finished" || run.state.outcome.kind !== "failed") {
              return yield* Effect.die("Expected persisted primary failure");
            }
            assert.match(run.state.outcome.message, primaryFailure);
            assert.include(notification, runId);
            assert.include(notification, created.id);
            assert.match(notification, primaryFailure);
            const primary = yield* awaitLog(logs.events, stage);
            assert.strictEqual(primary.level, "Error");
            assert.deepInclude(primary.annotations, {
              outcome: "failed",
              persisted: true,
              category: "operation",
            });
            for (const captured of ["stdout.bin", "stderr.bin", "result.json"]) {
              assert.strictEqual(
                yield* fileSystem.exists(path.join(directory, "script", captured)),
                artifact !== "missing",
              );
            }
            const diagnostics = logs.entries.filter(
              (entry) => entry.annotations.phase === "failure-diagnostics",
            );
            if (artifact === "missing") {
              assert.deepStrictEqual(diagnostics, []);
            } else {
              assert.strictEqual(diagnostics[0]?.level, "Error");
              assert.deepInclude(diagnostics[0]?.annotations ?? {}, {
                component: "schedule",
                scheduleId: created.id,
                runId,
                phase: "failure-diagnostics",
                category: "operation",
              });
            }
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, failingFileSystem),
            Effect.provide(logs.layer),
          );
          const serializedLogs = JSON.stringify(logs.entries);
          assert.notInclude(serializedLogs, "private");
          assert.notInclude(serializedLogs, root);
        }).pipe(Effect.provide(platformLayer), Effect.scoped),
    );
  }

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
          const schedules = yield* make(schedulesDir, resolveTarget);
          yield* TestClock.setTime(1_000);
          yield* schedules.start({
            scriptTarget: () =>
              Effect.fail(new Schedule.ScheduleHostError({ message: "private target detail" })),
            resolveTarget,
            materialize: () =>
              Effect.fail(new Schedule.ScheduleHostError({ message: "private target detail" })),
            deliver: () => Effect.die("Failed targets cannot deliver"),
            publish: () => Effect.die("Failed targets cannot publish"),
            runPrompt: () => Effect.die("Failed targets cannot run"),
          });
          const created = yield* schedules.create(caller, {
            name: "private schedule name",
            enabled: true,
            target: { kind: "chat", chatId: caller.chatId },
            trigger: { kind: "once", at: 1_000 },
            sourceDirectory: yield* prepareSource({ "script.js": "process.exit(0)" }),
          });
          assert.strictEqual(created.kind, "ready");
          if (created.kind !== "ready") return;
          const finalized = yield* awaitLog(logs.events, "finalize");
          const runId = `scheduled-1000-${created.definition.revision}`;
          assert.strictEqual(finalized.annotations.runId, runId);
          const failures = logs.entries.filter((entry) => entry.level === "Error");
          const primary = failures.filter(
            (entry) =>
              entry.annotations.outcome === "failed" && entry.annotations.persisted === false,
          );
          assert.strictEqual(primary.length, 1);
          assert.strictEqual(primary[0]?.annotations.category, "operation");
          assert.isTrue(
            failures.some(
              (entry) =>
                entry.annotations.phase === "failure-reporting-state" &&
                entry.annotations.category === "io",
            ),
          );
          assert.strictEqual(finalized.annotations.category, "io");
          assert.isTrue(failures.every((entry) => entry.annotations.scheduleId === created.id));
          const durable = yield* fileSystem
            .readFileString(path.join(schedulesDir, "runs", created.id, runId, "run.json"))
            .pipe(Effect.flatMap(decodeRun));
          assert.strictEqual(durable.state.kind, "claimed");
        }),
      ).pipe(
        Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
        Effect.provide(logs.layer),
      );
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
            const schedules = yield* make(schedulesDir, resolveTarget);
            yield* TestClock.setTime(1_000);
            yield* schedules.start({
              scriptTarget: () => Effect.die(new Error("private SDK payload")),
              resolveTarget,
              materialize: () =>
                Effect.fail(new Schedule.ScheduleHostError({ message: "Destination unavailable" })),
              deliver: () => Effect.die("Failed targets cannot deliver"),
              publish: () => Effect.die("Failed targets cannot publish"),
              runPrompt: () => Effect.die("Failed targets cannot run"),
            });
            const created = yield* schedules.create(caller, {
              name: "defect",
              enabled: true,
              target: { kind: "chat", chatId: caller.chatId },
              trigger: { kind: "once", at: 1_000 },
              sourceDirectory: yield* prepareSource({ "script.js": "process.exit(0)" }),
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
            const schedules = yield* make(schedulesDir, resolveTarget);
            yield* TestClock.setTime(1_000);
            yield* schedules.start({
              scriptTarget: defaultScriptTarget,
              resolveTarget,
              materialize: ({ destination }) =>
                Effect.succeed(resolveMaterializedTarget(destination, AbsolutePath.make(root))),
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
              target: { kind: "chat", chatId: caller.chatId },
              trigger: { kind: "once", at: 1_000 },
              sourceDirectory: yield* prepareSource({ "prompt.md": "private cancellation prompt" }),
            });
            yield* Deferred.await(started);
            if (mode === "aborted" && created.kind === "ready") {
              yield* awaitFinished(
                fileSystem,
                path.join(
                  schedulesDir,
                  "runs",
                  created.id,
                  `scheduled-1000-${created.definition.revision}`,
                  "run.json",
                ),
              );
            }
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
          kind: "interrupted",
        });
      }
      assert.deepStrictEqual(
        logs.entries.filter((entry) => entry.level === "Error"),
        [],
      );
      assert.notInclude(JSON.stringify(logs.entries), "private");
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
          const schedules = yield* open(schedulesDir, resolveTarget);
          const created = yield* schedules.create(caller, {
            name: "invalid definition",
            enabled: false,
            target: { kind: "chat", chatId: caller.chatId },
            trigger: { kind: "once", at: 1_000 },
            sourceDirectory: yield* prepareSource({ "prompt.md": "private prompt" }),
          });
          assert.strictEqual(created.kind, "ready");
          if (created.kind !== "ready") return;
          const metadata = path.join(schedulesDir, "disabled", created.id, "meta.json");
          const validSource = yield* fileSystem.readFileString(metadata);
          yield* fileSystem.writeFileString(metadata, '{"private":"invalid metadata"}');
          yield* schedules.start({
            scriptTarget: defaultScriptTarget,
            resolveTarget,
            materialize: () => Effect.die("Disabled schedules cannot execute"),
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
            yield* schedules.update(caller, created.id, { enabled: false }).pipe(Effect.exit);
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
