import * as AgentMessage from "@pico/contract/agent-message";
import * as Chat from "@pico/contract/chat-model";
import type { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Cron from "effect/Cron";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  bootstrap,
  type LoadedSchedule,
  loadSchedule,
  moveDefinition,
  publishDefinition,
  reconcileUpdates,
  removeDefinition,
  scanSchedules,
  updateDefinition,
} from "./definition-storage.ts";
import {
  appendArtifactString,
  publishRun,
  readRunDefinition,
  readRuns,
  writeArtifactString,
  writeRun,
} from "./run-storage.ts";
import { runScript } from "./script.ts";
import type { ExecutionInput } from "./source-files.ts";
import type { Storage } from "./storage.ts";

const RESCAN_INTERVAL = Duration.seconds(30);
const MISSED_GRACE_MILLIS = 2 * 60 * 60 * 1_000;

const scheduleError = (kind: Schedule.ScheduleError["kind"], message: string) =>
  new Schedule.ScheduleError({ kind, message });

const selectTarget = (
  caller: Schedule.ScheduleCaller,
  input: Schedule.ScheduleTargetInput,
): Pick<Schedule.ScheduleDefinition, "target" | "replyTarget"> => {
  switch (input.kind) {
    case "current-chat":
    case "current-workspace":
      return {
        target:
          input.kind === "current-chat"
            ? { kind: "chat", chatId: caller.chatId }
            : { kind: "workspace", workspaceId: caller.workspaceId },
        ...(caller.replyTarget === undefined ? {} : { replyTarget: caller.replyTarget }),
      };
    case "chat":
    case "workspace":
      return { target: input };
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
};

const validateTrigger = (trigger: Schedule.ScheduleTrigger): string | undefined => {
  if (trigger.kind === "once") return undefined;
  if (trigger.expression.trim().split(/\s+/u).length !== 5) {
    return "Cron triggers require exactly five fields";
  }
  const parsed = Cron.parse(trigger.expression, trigger.timeZone);
  return Result.isFailure(parsed) ? parsed.failure.message : undefined;
};

const invalidExternalView = (loaded: LoadedSchedule): Schedule.ScheduleView => {
  if (loaded.view.kind !== "ready") return loaded.view;
  const error = validateTrigger(loaded.view.definition.trigger);
  return error === undefined
    ? loaded.view
    : {
        kind: "invalid",
        id: loaded.view.id,
        state: loaded.view.state,
        sourceDirectory: loaded.view.sourceDirectory,
        error,
      };
};

const authorize = (
  caller: Schedule.ScheduleCaller,
  loaded: LoadedSchedule | undefined,
): Effect.Effect<LoadedSchedule, Schedule.ScheduleError> => {
  if (loaded === undefined || loaded.ownerWorkspaceId !== caller.workspaceId) {
    return Effect.fail(scheduleError("not-found", "Schedule not found"));
  }
  return Effect.succeed(loaded);
};

const scheduleRunBase = (
  run: Schedule.ScheduleRunLifecycle,
): Omit<Schedule.ScheduleRunLifecycle, "state"> => ({
  version: 1,
  id: run.id,
  scheduleId: run.scheduleId,
  source: run.source,
  definitionRevision: run.definitionRevision,
  plannedTarget: run.plannedTarget,
  claimedAt: run.claimedAt,
});

const toFinished = (
  run: Schedule.ScheduleRunLifecycle,
  finishedAt: number,
  outcome: Schedule.TerminalOutcome,
): Schedule.ScheduleRunLifecycle => ({
  ...scheduleRunBase(run),
  state: { kind: "finished", finishedAt, outcome },
});

const runAnnotations = (run: Schedule.ScheduleRunLifecycle) => ({
  component: "schedule",
  scheduleId: run.scheduleId,
  runId: run.id,
  definitionRevision: run.definitionRevision,
  plannedChatId: run.plannedTarget.chatId,
  ownerWorkspaceId: run.plannedTarget.ownerWorkspaceId,
});

const failureCategory = (cause: Cause.Cause<unknown>) => {
  if (cause.reasons.some(Cause.isDieReason)) return "defect";
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && reason.error instanceof Schedule.ScheduleError) {
      return reason.error.kind;
    }
  }
  return "operation";
};

const latestCronSlot = (
  trigger: Extract<Schedule.ScheduleTrigger, { readonly kind: "cron" }>,
  now: number,
) => {
  const parsed = Cron.parse(trigger.expression, trigger.timeZone);
  if (Result.isFailure(parsed)) return undefined;
  return Cron.prev(parsed.success, now + 1_000).getTime();
};

const capture = Effect.fn("Schedules.capture")(function* (
  schedulesDir: AbsolutePath,
  executable = process.execPath,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const mutation = Semaphore.makeUnsafe(1);
  const wake = yield* Queue.sliding<void>(1);
  const invalidDefinitions = new Set<Schedule.ScheduleId>();

  const transactionId = () =>
    crypto.randomUUIDv7.pipe(
      Effect.mapError(() => scheduleError("io", "Failed to generate schedule identity")),
    );
  const storage: Storage = { fileSystem, path, schedulesDir, temporaryId: transactionId };

  const loadOwned = Effect.fn("Schedules.loadOwned")(function* (
    caller: Schedule.ScheduleCaller,
    id: Schedule.ScheduleId,
  ) {
    return yield* authorize(caller, yield* loadSchedule(storage, id));
  });

  const create = Effect.fn("Schedules.create")(function* (
    caller: Schedule.ScheduleCaller,
    input: Schedule.CreateSchedule,
  ) {
    const triggerError = validateTrigger(input.trigger);
    if (triggerError !== undefined) return yield* scheduleError("invalid", triggerError);
    const created = yield* mutation.withPermit(
      Effect.gen(function* () {
        const id = Schedule.ScheduleId.make(yield* transactionId());
        const createdAt = yield* Clock.currentTimeMillis;
        const definition: Schedule.ScheduleDefinition = {
          version: 1,
          revision: Schedule.ScheduleRevision.make(yield* transactionId()),
          name: input.name,
          ownerWorkspaceId: caller.workspaceId,
          createdByChatId: caller.chatId,
          createdAt,
          ...selectTarget(caller, input.target),
          trigger: input.trigger,
          ...(input.scriptTimeoutMs === undefined
            ? {}
            : { scriptTimeoutMs: input.scriptTimeoutMs }),
        };
        yield* publishDefinition(
          storage,
          id,
          input.enabled ? "enabled" : "disabled",
          definition,
          input.sourceDirectory,
          yield* transactionId(),
        );
        const loaded = yield* loadSchedule(storage, id);
        if (loaded === undefined)
          return yield* scheduleError("io", "Published schedule is missing");
        return invalidExternalView(loaded);
      }),
    );
    if (input.enabled) yield* Queue.offer(wake, undefined);
    return created;
  });

  const list = Effect.fn("Schedules.list")(function* (caller: Schedule.ScheduleCaller) {
    return yield* mutation.withPermit(
      Effect.gen(function* () {
        yield* reconcileUpdates(storage);
        const loaded = yield* scanSchedules(storage);
        return loaded
          .filter((schedule) => schedule.ownerWorkspaceId === caller.workspaceId)
          .map(invalidExternalView);
      }),
    );
  });

  const get = Effect.fn("Schedules.get")(function* (
    caller: Schedule.ScheduleCaller,
    id: Schedule.ScheduleId,
  ) {
    return yield* mutation.withPermit(
      Effect.gen(function* () {
        yield* reconcileUpdates(storage);
        return invalidExternalView(yield* loadOwned(caller, id));
      }),
    );
  });

  const update = Effect.fn("Schedules.update")(function* (
    caller: Schedule.ScheduleCaller,
    id: Schedule.ScheduleId,
    input: Schedule.UpdateSchedule,
  ) {
    const updated = yield* mutation.withPermit(
      Effect.gen(function* () {
        yield* reconcileUpdates(storage);
        const loaded = yield* loadOwned(caller, id);
        const metadataChanged =
          input.name !== undefined ||
          input.target !== undefined ||
          input.trigger !== undefined ||
          input.scriptTimeoutMs !== undefined;
        if (!metadataChanged) {
          if (input.enabled === true && invalidExternalView(loaded).kind !== "ready") {
            return yield* scheduleError("invalid", "Fix invalid schedule files before enabling it");
          }
          if (input.enabled !== undefined) {
            yield* moveDefinition(storage, loaded, input.enabled ? "enabled" : "disabled");
          }
        } else {
          if (loaded.view.kind !== "ready") {
            return yield* scheduleError("invalid", "Invalid schedules cannot be updated");
          }
          const { target, replyTarget, ...metadata } = loaded.view.definition;
          const selection =
            input.target === undefined
              ? { target, ...(replyTarget === undefined ? {} : { replyTarget }) }
              : selectTarget(caller, input.target);
          const definition = {
            ...metadata,
            ...selection,
            revision: Schedule.ScheduleRevision.make(yield* transactionId()),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
            ...(input.scriptTimeoutMs == null ? {} : { scriptTimeoutMs: input.scriptTimeoutMs }),
          } satisfies Schedule.ScheduleDefinition;
          if (input.scriptTimeoutMs === null) delete definition.scriptTimeoutMs;
          const definitionError = validateTrigger(definition.trigger);
          if (definitionError !== undefined) {
            return yield* scheduleError("invalid", definitionError);
          }
          yield* updateDefinition(
            storage,
            loaded,
            definition,
            input.enabled === undefined
              ? loaded.view.state
              : input.enabled
                ? "enabled"
                : "disabled",
            yield* transactionId(),
          );
        }
        const refreshed = yield* loadSchedule(storage, id);
        if (refreshed === undefined)
          return yield* scheduleError("io", "Updated schedule is missing");
        return invalidExternalView(refreshed);
      }),
    );
    if (updated.kind === "ready" && updated.state === "enabled") {
      yield* Queue.offer(wake, undefined);
    }
    return updated;
  });
  const remove = Effect.fn("Schedules.remove")(function* (
    caller: Schedule.ScheduleCaller,
    id: Schedule.ScheduleId,
  ) {
    yield* mutation.withPermit(
      Effect.gen(function* () {
        yield* reconcileUpdates(storage);
        const loaded = yield* loadOwned(caller, id);
        yield* removeDefinition(storage, loaded);
      }),
    );
  });

  const disableDefinition = Effect.fn("Schedules.disableDefinition")(function* (
    id: Schedule.ScheduleId,
    revision: Schedule.ScheduleRevision,
  ) {
    yield* reconcileUpdates(storage);
    const loaded = yield* loadSchedule(storage, id);
    if (
      loaded !== undefined &&
      loaded.view.kind === "ready" &&
      loaded.view.state === "enabled" &&
      loaded.view.definition.revision === revision &&
      loaded.view.definition.trigger.kind === "once"
    ) {
      yield* moveDefinition(storage, loaded, "disabled");
    }
  });

  const finish = Effect.fn("Schedules.finishRun")(function* (
    run: Schedule.ScheduleRunLifecycle,
    outcome: Schedule.TerminalOutcome,
  ) {
    if (run.state.kind === "finished") return run;
    const terminal = toFinished(run, yield* Clock.currentTimeMillis, outcome);
    yield* writeRun(storage, terminal, yield* transactionId());
    return terminal;
  });

  const finishFallback = Effect.fn("Schedules.finishRunFallback")(function* (
    run: Schedule.ScheduleRunLifecycle,
    outcome: Schedule.TerminalOutcome,
  ) {
    if (run.state.kind === "finished") return run;
    const durable = (yield* readRuns(storage, run.scheduleId)).find(
      (candidate) => candidate.id === run.id,
    );
    if (durable?.state.kind === "finished") return durable;
    return yield* finish(run, outcome);
  });

  const disableFinishedOnce = Effect.fn("Schedules.disableFinishedOnce")(function* (
    run: Schedule.ScheduleRunLifecycle,
    definition: Schedule.ScheduleDefinition,
  ) {
    if (definition.trigger.kind === "once" && definition.revision === run.definitionRevision) {
      yield* mutation.withPermit(disableDefinition(run.scheduleId, run.definitionRevision));
    }
  });

  const executeRun = Effect.fn("Schedules.executeRun")(
    function* (
      host: Schedule.ScheduleRunHost,
      run: Schedule.ScheduleRunLifecycle,
      definition: Schedule.ScheduleDefinition,
      input: ExecutionInput,
    ) {
      let current = run;
      let failureStage: Extract<Schedule.TerminalOutcome, { readonly kind: "failed" }>["stage"] =
        "target";
      let completion:
        | { readonly outcome: Schedule.TerminalOutcome; readonly category: string }
        | undefined;
      const complete = (
        outcome: Schedule.TerminalOutcome,
        category = outcome.kind === "failed" ? "operation" : outcome.kind,
      ) =>
        Effect.sync(() => {
          completion = { outcome, category };
        });
      const fail = (
        stage: Extract<Schedule.TerminalOutcome, { readonly kind: "failed" }>["stage"],
        message: string,
      ) => {
        failureStage = stage;
        return complete({ kind: "failed", stage, message });
      };

      yield* Effect.logInfo("Scheduled run started");
      yield* Effect.gen(function* () {
        const destination: Schedule.ScheduleRunDestination =
          definition.target.kind === "chat"
            ? definition.target
            : { ...definition.target, newChatId: run.plannedTarget.chatId };
        const targetResult = yield* host.prepare(destination).pipe(Effect.result);
        if (Result.isFailure(targetResult)) {
          yield* fail("target", targetResult.failure.message);
          return;
        }
        const target = targetResult.success;
        current = {
          ...scheduleRunBase(run),
          state: { kind: "target-resolved", target },
        };
        yield* writeRun(storage, current, yield* transactionId());
        yield* writeArtifactString(
          storage,
          current,
          "target/result.json",
          JSON.stringify({
            chatId: target.chatId,
            workspaceId: target.workspaceId,
            cwd: target.cwd,
          }),
        );
        failureStage = "protocol";

        let decision: Schedule.ScriptDecision;
        if (!input.hasScript) {
          decision = { agent: true };
          yield* writeArtifactString(storage, current, "decision.json", JSON.stringify(decision));
        } else {
          failureStage = "script";
          current = {
            ...scheduleRunBase(current),
            state: { kind: "running-script", target, startedAt: yield* Clock.currentTimeMillis },
          };
          yield* writeRun(storage, current, yield* transactionId());
          const script = yield* runScript(
            storage,
            executable,
            current,
            target,
            definition.scriptTimeoutMs ?? Schedule.DEFAULT_SCRIPT_TIMEOUT_MS,
          ).pipe(Effect.result);
          if (Result.isFailure(script)) {
            const stage =
              script.failure._tag === "ScriptRunError" ? script.failure.stage : "script";
            yield* fail(stage, script.failure.message);
            return;
          }
          decision = script.success.decision;
        }

        if (!decision.agent) {
          if (decision.content === undefined) {
            yield* complete({ kind: "skipped" });
            return;
          }
          failureStage = "publish";
          const published = yield* host
            .publish(target.chatId, decision.content, definition.replyTarget)
            .pipe(Effect.result);
          if (Result.isFailure(published)) {
            yield* fail("publish", published.failure.message);
            return;
          }
          yield* complete({ kind: "published", content: decision.content });
          return;
        }

        const prompt = input.prompt;
        const request =
          decision.content === undefined
            ? prompt
            : prompt === null
              ? decision.content
              : `${decision.content}\n\n${prompt}`;
        if (request === null) {
          yield* fail("protocol", "Script requested an agent run without providing input");
          return;
        }
        failureStage = "omp";
        yield* writeArtifactString(storage, current, "omp/request.md", request);
        current = {
          ...scheduleRunBase(current),
          state: { kind: "running-omp", target, startedAt: yield* Clock.currentTimeMillis },
        };
        yield* writeRun(storage, current, yield* transactionId());
        yield* Effect.all(
          [
            writeArtifactString(storage, current, "omp/events.jsonl", ""),
            writeArtifactString(storage, current, "omp/final.md", ""),
            writeArtifactString(
              storage,
              current,
              "omp/result.json",
              JSON.stringify({ kind: "started" }),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        );
        const captured = yield* host
          .runPrompt(
            target.chatId,
            current.id,
            AgentMessage.AgentPrompt.make({ text: request, attachments: [] }),
            (event) =>
              appendArtifactString(
                storage,
                current,
                "omp/events.jsonl",
                `${JSON.stringify(event)}\n`,
              ).pipe(
                Effect.mapError(
                  (error) => new Schedule.ScheduleHostError({ message: error.message }),
                ),
              ),
            definition.replyTarget,
          )
          .pipe(Effect.result);
        if (Result.isFailure(captured)) {
          yield* fail("omp", captured.failure.message);
          yield* writeArtifactString(
            storage,
            current,
            "omp/result.json",
            JSON.stringify({ kind: "failed", message: captured.failure.message }),
          ).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logError("Failed to record OMP failure artifact").pipe(
                    Effect.annotateLogs({
                      phase: "failure-artifact",
                      artifact: "omp/result.json",
                      category: failureCategory(cause),
                    }),
                  ),
            ),
          );
          return;
        }
        const text = captured.success.finalAssistantText;
        if (captured.success.outcome !== "completed") {
          yield* complete(
            { kind: "failed", stage: "omp", message: `OMP run ${captured.success.outcome}` },
            captured.success.outcome === "aborted" ? "cancelled" : "agent",
          );
        }
        yield* Effect.all(
          [
            writeArtifactString(storage, current, "omp/final.md", text),
            writeArtifactString(
              storage,
              current,
              "omp/result.json",
              JSON.stringify(captured.success),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(
          Effect.catchCause((cause) => {
            if (completion === undefined || Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            return Effect.logError("Failed to record OMP outcome artifacts").pipe(
              Effect.annotateLogs({ phase: "failure-artifact", category: failureCategory(cause) }),
            );
          }),
        );
        if (captured.success.outcome !== "completed") {
          return;
        }
        failureStage = "publish";
        const delivery = yield* host
          .deliver(target.chatId, text, definition.replyTarget)
          .pipe(Effect.result);
        if (Result.isFailure(delivery)) {
          yield* fail("publish", delivery.failure.message);
          return;
        }
        yield* complete({ kind: "completed", finalAssistantText: text });
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (completion === undefined) {
              if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
                completion = {
                  outcome: { kind: "interrupted", phase: "scheduler-scope" },
                  category: "cancelled",
                };
              } else {
                const reason = Exit.isFailure(exit)
                  ? exit.cause.reasons.find(Cause.isFailReason)
                  : undefined;
                completion = {
                  outcome: {
                    kind: "failed",
                    stage: failureStage,
                    message:
                      reason?.error instanceof Schedule.ScheduleError
                        ? reason.error.message
                        : "Unexpected scheduled execution failure",
                  },
                  category: Exit.isFailure(exit) ? failureCategory(exit.cause) : "defect",
                };
              }
            }
            const { outcome, category } = completion;
            const finalized = yield* finishFallback(current, outcome).pipe(Effect.exit);
            const annotations = {
              phase: outcome.kind === "failed" ? outcome.stage : current.state.kind,
              outcome: outcome.kind,
              category,
              persisted: Exit.isSuccess(finalized),
            };
            yield* (
              outcome.kind === "failed" && category !== "cancelled"
                ? Effect.logError("Scheduled run failed")
                : Effect.logInfo("Scheduled run finished")
            ).pipe(Effect.annotateLogs(annotations));
            if (Exit.isFailure(finalized)) {
              if (!Cause.hasInterruptsOnly(finalized.cause)) {
                yield* Effect.logError("Failed to finalize scheduled run").pipe(
                  Effect.annotateLogs({
                    phase: "finalize",
                    outcome: outcome.kind,
                    category: failureCategory(finalized.cause),
                  }),
                );
              }
              return;
            }
            current = finalized.value;
            yield* disableFinishedOnce(current, definition).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("Finished schedule could not be disabled").pipe(
                      Effect.annotateLogs({
                        phase: "disable-after-completion",
                        outcome: outcome.kind,
                        category: failureCategory(cause),
                      }),
                    ),
              ),
            );
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void,
        ),
      );
    },
    (effect, _host, run) =>
      effect.pipe(Effect.annotateLogs({ ...runAnnotations(run), operation: "execute" })),
  );

  const claim = Effect.fn("Schedules.claim")(function* (
    view: Schedule.ReadyScheduleView,
    source: Schedule.ScheduleRunSource,
    owned: Set<Schedule.ScheduleRunLifecycle>,
  ) {
    const id = Schedule.ScheduleRunId.make(
      `scheduled-${source.scheduledFor}-${view.definition.revision}`,
    );
    const chatId =
      view.definition.target.kind === "chat"
        ? view.definition.target.chatId
        : Chat.ChatId.make(yield* transactionId());
    const plannedTarget: Schedule.PlannedScheduleRunTarget =
      view.definition.target.kind === "chat"
        ? {
            kind: "existing-chat",
            ownerWorkspaceId: view.definition.ownerWorkspaceId,
            chatId,
          }
        : {
            kind: "workspace-chat",
            ownerWorkspaceId: view.definition.ownerWorkspaceId,
            chatId,
          };
    const run: Schedule.ScheduleRunLifecycle = {
      version: 1,
      id,
      scheduleId: view.id,
      definitionRevision: view.definition.revision,
      source,
      plannedTarget,
      claimedAt: yield* Clock.currentTimeMillis,
      state: { kind: "claimed" },
    };
    const input = yield* publishRun(
      storage,
      run,
      view.definition,
      view.sourceDirectory,
      yield* transactionId(),
      Effect.sync(() => void owned.add(run)),
    );
    yield* Effect.logInfo("Scheduled run claimed").pipe(
      Effect.annotateLogs({ ...runAnnotations(run), operation: "claim", phase: "claimed" }),
    );
    return { run, input };
  });

  const scheduleCycle = Effect.fn("Schedules.scheduleCycle")(function* (
    host: Schedule.ScheduleRunHost,
  ): Effect.fn.Return<void, Schedule.ScheduleError, Scope.Scope> {
    const owned = new Set<Schedule.ScheduleRunLifecycle>();
    const cleanupOwned = Effect.suspend(() =>
      Effect.forEach(
        [...owned.values()],
        (run) =>
          finishFallback(run, { kind: "interrupted", phase: "schedule-cycle" }).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("Failed to finish an interrupted schedule claim").pipe(
                    Effect.annotateLogs({
                      ...runAnnotations(run),
                      operation: "scan",
                      phase: "claim-cleanup",
                      category: failureCategory(cause),
                    }),
                  ),
            ),
          ),
        { discard: true },
      ),
    );

    return yield* Effect.gen(function* () {
      const claimed = yield* mutation.withPermit(
        Effect.gen(function* () {
          yield* reconcileUpdates(storage);
          const now = yield* Clock.currentTimeMillis;
          const schedules = yield* scanSchedules(storage);
          const invalid = new Set<Schedule.ScheduleId>();
          for (const loaded of schedules) {
            const view = invalidExternalView(loaded);
            if (view.kind !== "invalid") continue;
            invalid.add(view.id);
            if (!invalidDefinitions.has(view.id)) {
              yield* Effect.logWarning("Invalid schedule definition excluded from execution").pipe(
                Effect.annotateLogs({
                  component: "schedule",
                  operation: "scan",
                  phase: "definition",
                  scheduleId: view.id,
                  state: view.state,
                  category: view.state === "conflicted" ? "conflict" : "invalid",
                }),
              );
            }
          }
          const pending: Array<{
            readonly run: Schedule.ScheduleRunLifecycle;
            readonly definition: Schedule.ScheduleDefinition;
            readonly input: ExecutionInput;
            readonly missed: boolean;
          }> = [];
          for (const loaded of schedules) {
            if (loaded.view.kind !== "ready" || loaded.view.state !== "enabled") continue;
            if (validateTrigger(loaded.view.definition.trigger) !== undefined) continue;
            const view = loaded.view;
            const existing = yield* readRuns(storage, view.id);
            if (existing.some((run) => run.state.kind !== "finished")) continue;
            const currentRuns = existing.filter(
              (run) => run.definitionRevision === view.definition.revision,
            );

            let scheduledFor: number;
            if (view.definition.trigger.kind === "once") {
              scheduledFor = view.definition.trigger.at;
              if (currentRuns.some((run) => run.source.scheduledFor === scheduledFor)) {
                yield* disableDefinition(view.id, view.definition.revision);
                continue;
              }
              if (scheduledFor > now) continue;
            } else {
              const latest = latestCronSlot(view.definition.trigger, now);
              if (latest === undefined || latest <= view.definition.createdAt) continue;
              scheduledFor = latest;
              if (currentRuns.some((run) => run.source.scheduledFor === scheduledFor)) continue;
            }

            const claimed = yield* claim(view, { kind: "scheduled", scheduledFor }, owned).pipe(
              Effect.result,
            );
            if (Result.isFailure(claimed)) {
              invalid.add(view.id);
              if (!invalidDefinitions.has(view.id)) {
                yield* Effect.logWarning("Schedule source capture failed").pipe(
                  Effect.annotateLogs({
                    component: "schedule",
                    operation: "scan",
                    phase: "source",
                    scheduleId: view.id,
                    state: view.state,
                    category: claimed.failure.kind,
                  }),
                );
              }
              continue;
            }
            pending.push({
              run: claimed.success.run,
              definition: view.definition,
              input: claimed.success.input,
              missed: now - scheduledFor > MISSED_GRACE_MILLIS,
            });
          }
          invalidDefinitions.clear();
          for (const id of invalid) invalidDefinitions.add(id);
          return pending;
        }),
      );

      for (const item of claimed) {
        if (item.missed) {
          const terminal = yield* finish(item.run, {
            kind: "missed",
            scheduledFor: item.run.source.scheduledFor,
            observedAt: yield* Clock.currentTimeMillis,
          });
          yield* Effect.logInfo("Scheduled run finished").pipe(
            Effect.annotateLogs({
              ...runAnnotations(terminal),
              operation: "scan",
              phase: "missed",
              outcome: "missed",
            }),
          );
          yield* disableFinishedOnce(terminal, item.definition);
          owned.delete(item.run);
        } else {
          yield* Effect.uninterruptible(
            executeRun(host, item.run, item.definition, item.input).pipe(
              Effect.forkScoped({ startImmediately: true }),
              Effect.tap(() => Effect.sync(() => owned.delete(item.run))),
              Effect.asVoid,
            ),
          );
        }
      }
    }).pipe(Effect.ensuring(cleanupOwned));
  });

  const reconcile = Effect.fn("Schedules.reconcile")(function* () {
    const runs = yield* readRuns(storage);
    for (const run of runs) {
      const definition = yield* readRunDefinition(storage, run);
      const terminal =
        run.state.kind === "finished"
          ? run
          : yield* finish(run, { kind: "interrupted", phase: run.state.kind });
      if (run.state.kind !== "finished") {
        yield* Effect.logInfo("Interrupted scheduled run reconciled").pipe(
          Effect.annotateLogs({
            ...runAnnotations(run),
            operation: "reconcile",
            phase: run.state.kind,
            outcome: "interrupted",
          }),
        );
      }
      yield* disableFinishedOnce(terminal, definition);
    }
  });

  const initialize = yield* Effect.cached(bootstrap(storage));

  const start = Effect.fn("Schedules.start")(function* (
    host: Schedule.ScheduleRunHost,
  ): Effect.fn.Return<void, Schedule.ScheduleError, Scope.Scope> {
    yield* initialize;
    yield* reconcile();
    const cycle = scheduleCycle(host).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError("Schedule scan failed").pipe(
              Effect.annotateLogs({
                component: "schedule",
                operation: "scan",
                phase: "cycle",
                category: failureCategory(cause),
              }),
              Effect.andThen(Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void),
            ),
      ),
    );
    yield* cycle;
    yield* Effect.logInfo("Scheduler started").pipe(
      Effect.annotateLogs({ component: "schedule", operation: "start" }),
    );
    const wait = Effect.race(Queue.take(wake), Effect.sleep(RESCAN_INTERVAL));
    yield* Effect.forever(wait.pipe(Effect.andThen(cycle))).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? Effect.logError("Schedule scan loop stopped unexpectedly").pipe(
              Effect.annotateLogs({
                component: "schedule",
                operation: "scan",
                phase: "loop",
                category: failureCategory(exit.cause),
              }),
            )
          : Effect.logDebug("Schedule scan loop stopped").pipe(
              Effect.annotateLogs({ component: "schedule", operation: "scan", phase: "loop" }),
            ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  });

  return {
    service: Schedule.Schedules.of({ create, list, get, update, remove, start }),
    initialize,
  };
});

export const make = Effect.fn("Schedules.make")(function* (
  schedulesDir: AbsolutePath,
  executable = process.execPath,
) {
  return (yield* capture(schedulesDir, executable)).service;
});

export const open = Effect.fn("Schedules.open")(function* (
  schedulesDir: AbsolutePath,
  executable = process.execPath,
) {
  const captured = yield* capture(schedulesDir, executable);
  yield* captured.initialize;
  return captured.service;
});

export const layer = (schedulesDir: AbsolutePath, executable = process.execPath) =>
  Layer.effect(Schedule.Schedules, open(schedulesDir, executable));
