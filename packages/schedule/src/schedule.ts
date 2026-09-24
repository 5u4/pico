import * as AgentMessage from "@pico/contract/agent-message";
import * as Chat from "@pico/contract/chat-model";
import type { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import { WorkspaceId } from "@pico/contract/workspace-model";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Cron from "effect/Cron";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  bootstrap,
  type LoadedSchedule,
  loadSchedule,
  moveDefinition,
  publishDefinition,
  readCurrentTargets,
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
  runDirectory,
  writeArtifactString,
  writeRun,
} from "./run-storage.ts";
import { runScript } from "./script.ts";
import type { ExecutionInput } from "./source-files.ts";
import type { Storage } from "./storage.ts";

const RESCAN_INTERVAL = Duration.seconds(30);
const MISSED_GRACE_MILLIS = 2 * 60 * 60 * 1_000;

const decodeOwnerWorkspaceId = Schema.decodeUnknownOption(WorkspaceId);
const scheduleError = (kind: Schedule.ScheduleError["kind"], message: string) =>
  new Schedule.ScheduleError({ kind, message });

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

const nextTrigger = (
  view: Schedule.ScheduleView,
  observedAt: number,
): Schedule.ScheduleNextTrigger => {
  if (view.kind === "invalid") return { kind: "none", reason: "invalid" };
  if (view.state === "disabled") return { kind: "none", reason: "disabled" };
  const { trigger, createdAt } = view.definition;
  if (trigger.kind === "once") {
    return trigger.at > observedAt
      ? { kind: "scheduled", at: trigger.at }
      : { kind: "none", reason: "past-once" };
  }
  const parsed = Cron.parse(trigger.expression, trigger.timeZone);
  if (Result.isFailure(parsed)) return { kind: "unavailable" };
  try {
    const at = Cron.next(parsed.success, Math.max(observedAt, createdAt)).getTime();
    return Number.isFinite(at) ? { kind: "scheduled", at } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
};

const summarizeRun = (run: Schedule.ScheduleRunLifecycle): Schedule.ScheduleRunSummary => {
  const base = {
    id: run.id,
    definitionRevision: run.definitionRevision,
    source: run.source,
    claimedAt: run.claimedAt,
  };
  const state = run.state;
  switch (state.kind) {
    case "claimed":
    case "target-resolved":
      return { ...base, state: { kind: state.kind } };
    case "running-script":
    case "running-omp":
    case "reporting-failure":
      return { ...base, state: { kind: state.kind, startedAt: state.startedAt } };
    case "finished":
      return {
        ...base,
        state: {
          kind: "finished",
          finishedAt: state.finishedAt,
          outcome:
            state.outcome.kind === "failed" || state.outcome.kind === "interrupted"
              ? state.outcome
              : { kind: state.outcome.kind },
        },
      };
  }
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

interface FailureCapture {
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

interface FailureDiagnostics {
  readonly stdout?: FailureCapture;
  readonly stderr?: FailureCapture;
}

const captureMetadata = Schema.Struct({
  totalBytes: Schema.Natural,
  truncated: Schema.Boolean,
});
const decodeCaptureMetadata = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      stdout: Schema.optional(captureMetadata),
      stderr: Schema.optional(captureMetadata),
    }),
  ),
);

const decodeCaptureText = (capture: FailureCapture) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(capture.bytes);
  } catch {
    return `[invalid utf-8 bytes, replacement shown]\n${new TextDecoder().decode(capture.bytes)}`;
  }
};

const renderCapture = (label: "stdout" | "stderr", capture?: FailureCapture) => {
  if (capture === undefined) return "";
  const decoded = decodeCaptureText(capture);
  const truncation = capture.truncated
    ? ` [truncated ${capture.bytes.byteLength}/${capture.totalBytes} bytes]`
    : ` [${capture.totalBytes} bytes]`;
  const text = decoded.length === 0 ? "[empty]" : decoded;
  return `\n\n${label}${truncation}\n${text}`;
};

const renderFailureMessage = (
  run: Schedule.ScheduleRunLifecycle,
  name: string,
  outcome: Extract<Schedule.TerminalOutcome, { readonly kind: "failed" }>,
  diagnostics: FailureDiagnostics,
) =>
  [
    `Schedule run failed`,
    `name: ${name}`,
    `scheduleId: ${run.scheduleId}`,
    `runId: ${run.id}`,
    `stage: ${outcome.stage}`,
    `message: ${outcome.message}`,
    renderCapture("stderr", diagnostics.stderr),
    renderCapture("stdout", diagnostics.stdout),
  ].join("\n");

const readFailureDiagnostics = Effect.fn("Schedules.readFailureDiagnostics")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
) {
  const directory = runDirectory(storage, run.scheduleId, run.id);
  const stdoutBytes = yield* storage.fileSystem
    .readFile(storage.path.join(directory, "script", "stdout.bin"))
    .pipe(
      Effect.map(Option.some),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(cause),
      ),
    );
  const stderrBytes = yield* storage.fileSystem
    .readFile(storage.path.join(directory, "script", "stderr.bin"))
    .pipe(
      Effect.map(Option.some),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(cause),
      ),
    );
  const rawResult = yield* storage.fileSystem
    .readFileString(storage.path.join(directory, "script", "result.json"))
    .pipe(
      Effect.map(Option.some),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(cause),
      ),
    );
  const parsed = Option.getOrUndefined(Option.flatMap(rawResult, decodeCaptureMetadata));
  const makeCapture = (
    bytes: Option.Option<Uint8Array>,
    stream: "stdout" | "stderr",
  ): FailureCapture | undefined => {
    if (Option.isNone(bytes)) return undefined;
    const stats = stream === "stdout" ? parsed?.stdout : parsed?.stderr;
    return {
      bytes: bytes.value,
      totalBytes: stats?.totalBytes ?? bytes.value.byteLength,
      truncated: stats?.truncated ?? false,
    };
  };
  const stdout = makeCapture(stdoutBytes, "stdout");
  const stderr = makeCapture(stderrBytes, "stderr");
  return {
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  } satisfies FailureDiagnostics;
});

const capture = Effect.fn("Schedules.capture")(function* (
  schedulesDir: AbsolutePath,
  resolveTarget: Schedule.ScheduleRunHost["resolveTarget"],
  executable = process.execPath,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const mutation = Semaphore.makeUnsafe(1);
  const wake = yield* Queue.sliding<void>(1);
  const invalidDefinitions = new Set<Schedule.ScheduleId>();
  interface RunnerState {
    readonly host: Schedule.ScheduleRunHost;
    readonly scope: Scope.Scope;
  }
  let runner: RunnerState | undefined;

  const transactionId = () =>
    crypto.randomUUIDv7.pipe(
      Effect.mapError(() => scheduleError("io", "Failed to generate schedule identity")),
    );
  const storage: Storage = { fileSystem, path, schedulesDir, temporaryId: transactionId };
  const initialize = yield* Effect.cached(mutation.withPermit(bootstrap(storage)));

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
          version: 2,
          revision: Schedule.ScheduleRevision.make(yield* transactionId()),
          name: input.name,
          ownerWorkspaceId: caller.workspaceId,
          createdByChatId: caller.chatId,
          createdAt,
          target: yield* resolveTarget(input.target).pipe(
            Effect.mapError((error) => scheduleError("invalid", error.message)),
          ),
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

  const overview = Effect.fn("Schedules.overview")(function* () {
    return yield* mutation.withPermit(
      Effect.gen(function* () {
        const observedAt = yield* Clock.currentTimeMillis;
        const loaded = yield* scanSchedules(storage);
        const entries: Array<Schedule.ScheduleOverviewEntry> = [];
        for (const schedule of loaded) {
          const view = invalidExternalView(schedule);
          let lastRun: Schedule.ScheduleRunLifecycle | undefined;
          for (const run of yield* readRuns(storage, view.id)) {
            if (
              lastRun === undefined ||
              run.claimedAt > lastRun.claimedAt ||
              (run.claimedAt === lastRun.claimedAt && run.id > lastRun.id)
            ) {
              lastRun = run;
            }
          }
          entries.push({
            view,
            ownerWorkspaceId: Option.getOrNull(decodeOwnerWorkspaceId(schedule.ownerWorkspaceId)),
            nextTrigger: nextTrigger(view, observedAt),
            lastRun: lastRun === undefined ? null : summarizeRun(lastRun),
          });
        }
        return { observedAt, entries };
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
          if (input.enabled === true && loaded.view.kind === "ready") {
            yield* resolveTarget(loaded.view.definition.target).pipe(
              Effect.mapError((error) => scheduleError("invalid", error.message)),
            );
          }
          if (input.enabled !== undefined) {
            yield* moveDefinition(storage, loaded, input.enabled ? "enabled" : "disabled");
          }
        } else {
          if (loaded.view.kind !== "ready") {
            return yield* scheduleError("invalid", "Invalid schedules cannot be updated");
          }
          const definition = {
            ...loaded.view.definition,
            target: yield* resolveTarget(input.target ?? loaded.view.definition.target).pipe(
              Effect.mapError((error) => scheduleError("invalid", error.message)),
            ),
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

  const withCurrentTargets: Schedule.Schedules["Service"]["withCurrentTargets"] = (use) =>
    mutation.withPermit(
      Effect.gen(function* () {
        yield* reconcileUpdates(storage);
        return yield* use(yield* readCurrentTargets(storage));
      }),
    );

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
      const destination: Schedule.ScheduleRunDestination =
        definition.target.kind === "chat"
          ? definition.target
          : { ...definition.target, newChatId: run.plannedTarget.chatId };
      const materialize = yield* Effect.cached(
        host.materialize({ destination, title: definition.name }),
      );

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

      const resolveMaterializedTarget = Effect.fn("Schedules.resolveMaterializedTarget")(
        function* () {
          const resolved = yield* materialize.pipe(Effect.result);
          if (Result.isFailure(resolved)) return resolved;
          current = {
            ...scheduleRunBase(current),
            state: { kind: "target-resolved", target: resolved.success },
          };
          yield* writeRun(storage, current, yield* transactionId());
          yield* writeArtifactString(
            storage,
            current,
            "target/result.json",
            JSON.stringify({
              chatId: resolved.success.chatId,
              workspaceId: resolved.success.workspaceId,
              cwd: resolved.success.cwd,
            }),
          );
          return resolved;
        },
      );

      const notifyFailure = Effect.fn("Schedules.notifyFailure")(function* (
        outcome: Extract<Schedule.TerminalOutcome, { readonly kind: "failed" }>,
      ): Effect.fn.Return<Schedule.FailedScheduleNotification, Schedule.ScheduleError> {
        const reporting: Schedule.ScheduleRunLifecycle = {
          ...scheduleRunBase(current),
          state: {
            kind: "reporting-failure",
            startedAt: yield* Clock.currentTimeMillis,
            outcome,
          },
        };
        yield* writeRun(storage, reporting, yield* transactionId()).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              current = reporting;
            }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("Failed to persist reporting-failure state").pipe(
                  Effect.annotateLogs({
                    phase: "failure-reporting-state",
                    category: failureCategory(cause),
                  }),
                ),
          ),
        );
        const diagnostics = yield* readFailureDiagnostics(storage, current).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logError("Failed to read run diagnostics for failure report").pipe(
                  Effect.annotateLogs({
                    phase: "failure-diagnostics",
                    category: failureCategory(cause),
                  }),
                  Effect.as({} satisfies FailureDiagnostics),
                ),
          ),
        );
        const target = yield* materialize.pipe(Effect.result);
        if (Result.isFailure(target)) {
          return {
            kind: "failed",
            message: target.failure.message,
          } satisfies Schedule.FailedScheduleNotification;
        }
        const rendered = renderFailureMessage(current, definition.name, outcome, diagnostics);
        const notified = yield* host.publish(target.success.chatId, rendered).pipe(Effect.exit);
        if (Exit.isSuccess(notified)) {
          return { kind: "delivered" } satisfies Schedule.FailedScheduleNotification;
        }
        if (Cause.hasInterruptsOnly(notified.cause)) {
          return { kind: "interrupted" } satisfies Schedule.FailedScheduleNotification;
        }
        const reason = notified.cause.reasons.find(Cause.isFailReason)?.error;
        return {
          kind: "failed",
          message:
            reason instanceof Schedule.ScheduleHostError
              ? reason.message
              : "Failed to report scheduled run failure",
        } satisfies Schedule.FailedScheduleNotification;
      });

      yield* Effect.logInfo("Scheduled run started");
      yield* Effect.gen(function* () {
        let decision: Schedule.ScriptDecision;
        if (!input.hasScript) {
          decision = { agent: true };
          yield* writeArtifactString(storage, current, "decision.json", JSON.stringify(decision));
        } else {
          const scriptTarget = yield* host.scriptTarget(definition.target).pipe(Effect.result);
          if (Result.isFailure(scriptTarget)) {
            yield* fail("target", scriptTarget.failure.message);
            return;
          }
          failureStage = "script";
          current = {
            ...scheduleRunBase(current),
            state: { kind: "running-script", startedAt: yield* Clock.currentTimeMillis },
          };
          yield* writeRun(storage, current, yield* transactionId());
          const script = yield* runScript(
            storage,
            executable,
            current,
            scriptTarget.success,
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

        if (!decision.agent && decision.content === undefined) {
          yield* complete({ kind: "skipped" });
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

        if (!decision.agent && decision.content !== undefined) {
          failureStage = "target";
          const target = yield* resolveMaterializedTarget();
          if (Result.isFailure(target)) {
            yield* fail("target", target.failure.message);
            return;
          }
          failureStage = "publish";
          const published = yield* host
            .publish(target.success.chatId, decision.content)
            .pipe(Effect.result);
          if (Result.isFailure(published)) {
            yield* fail("publish", published.failure.message);
            return;
          }
          yield* complete({ kind: "published", content: decision.content });
          return;
        }

        failureStage = "target";
        const target = yield* resolveMaterializedTarget();
        if (Result.isFailure(target)) {
          yield* fail("target", target.failure.message);
          return;
        }
        failureStage = "omp";
        yield* writeArtifactString(storage, current, "omp/request.md", request);
        current = {
          ...scheduleRunBase(current),
          state: {
            kind: "running-omp",
            target: target.success,
            startedAt: yield* Clock.currentTimeMillis,
          },
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
            target.success.chatId,
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
          if (captured.success.outcome === "aborted") {
            yield* complete(
              { kind: "interrupted", phase: `omp-${captured.success.outcome}` },
              "cancelled",
            );
          } else {
            yield* complete({
              kind: "failed",
              stage: "omp",
              message: `OMP run ${captured.success.outcome}`,
            });
          }
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
        const settlement = captured.success.events.findLast(
          (event) => event.type === "message-settled" && event.message.role === "assistant",
        );
        if (
          settlement?.type !== "message-settled" ||
          settlement.message.role !== "assistant" ||
          settlement.message.status !== "completed"
        ) {
          yield* fail("omp", "OMP run completed without a completed assistant message");
          return;
        }
        failureStage = "publish";
        const delivery = yield* host
          .deliver(target.success.chatId, settlement.message)
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
            let outcome = completion.outcome;
            if (outcome.kind === "failed") {
              const notification: Schedule.FailedScheduleNotification =
                Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
                  ? { kind: "interrupted" }
                  : yield* notifyFailure(outcome).pipe(
                      Effect.interruptible,
                      Effect.catchCause((cause) =>
                        Effect.succeed<Schedule.FailedScheduleNotification>(
                          Cause.hasInterruptsOnly(cause)
                            ? { kind: "interrupted" }
                            : { kind: "failed", message: "Failed to report scheduled run failure" },
                        ),
                      ),
                    );
              outcome = { ...outcome, notification };
            }
            const finalized = yield* finishFallback(current, outcome).pipe(Effect.exit);
            const annotations = {
              phase: outcome.kind === "failed" ? outcome.stage : current.state.kind,
              outcome: outcome.kind,
              category: completion.category,
              persisted: Exit.isSuccess(finalized),
            };
            yield* (
              outcome.kind === "failed" && completion.category !== "cancelled"
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

  const dispatchClaimedRun = Effect.fn("Schedules.dispatchClaimedRun")(function* (
    runnerState: RunnerState,
    run: Schedule.ScheduleRunLifecycle,
    definition: Schedule.ScheduleDefinition,
    input: ExecutionInput,
  ) {
    if (runnerState.scope.state._tag === "Closed") {
      yield* finishFallback(run, { kind: "interrupted", phase: "schedule-cycle" }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to finish a claim after scheduler shutdown").pipe(
            Effect.annotateLogs({
              ...runAnnotations(run),
              phase: "claim-cleanup",
              category: failureCategory(cause),
            }),
          ),
        ),
      );
      return;
    }
    let fallback: Schedule.TerminalOutcome = { kind: "interrupted", phase: "schedule-cycle" };
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (run.source.kind === "scheduled" && now - run.source.scheduledFor > MISSED_GRACE_MILLIS) {
        fallback = { kind: "missed", scheduledFor: run.source.scheduledFor, observedAt: now };
        const terminal = yield* finish(run, fallback);
        yield* Effect.logInfo("Scheduled run finished").pipe(
          Effect.annotateLogs({
            ...runAnnotations(terminal),
            operation: "scan",
            phase: "missed",
            outcome: "missed",
          }),
        );
        yield* disableFinishedOnce(terminal, definition);
        return;
      }
      yield* executeRun(runnerState.host, run, definition, input);
    }).pipe(
      Effect.interruptible,
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.gen(function* () {
              const interrupted = Cause.hasInterruptsOnly(exit.cause);
              if (!interrupted && fallback.kind === "missed") {
                yield* Effect.logError("Scheduled run finalization failed").pipe(
                  Effect.annotateLogs({
                    ...runAnnotations(run),
                    phase: "finalize",
                    category: failureCategory(exit.cause),
                  }),
                );
              }
              yield* finishFallback(
                run,
                interrupted ? { kind: "interrupted", phase: "schedule-cycle" } : fallback,
              ).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logError("Failed to finish an interrupted schedule claim").pipe(
                        Effect.annotateLogs({
                          ...runAnnotations(run),
                          phase: "claim-cleanup",
                          category: failureCategory(cause),
                        }),
                      ),
                ),
              );
            }),
      ),
      Effect.forkIn(runnerState.scope, { startImmediately: true }),
      Effect.asVoid,
    );
  });

  const claim = Effect.fn("Schedules.claim")(function* (
    view: Schedule.ReadyScheduleView,
    source: Schedule.ScheduleRunSource,
    runnerState: RunnerState,
  ) {
    const id =
      source.kind === "scheduled"
        ? Schedule.ScheduleRunId.make(
            `scheduled-${source.scheduledFor}-${view.definition.revision}`,
          )
        : Schedule.ScheduleRunId.make(`manual-${yield* transactionId()}`);
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
    yield* publishRun(
      storage,
      run,
      view.definition,
      view.sourceDirectory,
      yield* transactionId(),
      (execution) => dispatchClaimedRun(runnerState, run, view.definition, execution),
    );
    yield* Effect.logInfo("Scheduled run claimed").pipe(
      Effect.annotateLogs({ ...runAnnotations(run), operation: "claim", phase: "claimed" }),
    );
    return run;
  });

  const trigger = Effect.fn("Schedules.trigger")(function* (
    caller: Schedule.ScheduleCaller,
    id: Schedule.ScheduleId,
  ) {
    return yield* mutation.withPermit(
      Effect.gen(function* () {
        const runnerState = runner;
        if (runnerState === undefined || runnerState.scope.state._tag === "Closed") {
          return yield* scheduleError("busy", "Scheduler is not running");
        }
        yield* reconcileUpdates(storage);
        const loaded = yield* loadOwned(caller, id);
        const view = invalidExternalView(loaded);
        if (view.kind !== "ready") {
          return yield* scheduleError("invalid", "Schedule is invalid");
        }
        if (view.state !== "enabled") {
          return yield* scheduleError("busy", "Schedule is disabled");
        }
        const triggerError = validateTrigger(view.definition.trigger);
        if (triggerError !== undefined) {
          return yield* scheduleError("invalid", triggerError);
        }
        const runs = yield* readRuns(storage, view.id);
        if (runs.some((run) => run.state.kind !== "finished")) {
          return yield* scheduleError("busy", "Schedule run already in progress");
        }
        const currentRuns = runs.filter(
          (run) => run.definitionRevision === view.definition.revision,
        );
        if (view.definition.trigger.kind === "once" && currentRuns.length > 0) {
          return yield* scheduleError("busy", "Once schedule already consumed");
        }
        const run = yield* claim(view, { kind: "manual" }, runnerState);
        return { scheduleId: run.scheduleId, runId: run.id };
      }),
    );
  });

  const scheduleCycle = Effect.fn("Schedules.scheduleCycle")(function* (
    runnerState: RunnerState,
  ): Effect.fn.Return<void, Schedule.ScheduleError> {
    yield* mutation.withPermit(
      Effect.gen(function* () {
        if (runner !== runnerState || runnerState.scope.state._tag === "Closed") return;
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
        for (const loaded of schedules) {
          if (loaded.view.kind !== "ready" || loaded.view.state !== "enabled") continue;
          if (validateTrigger(loaded.view.definition.trigger) !== undefined) continue;
          const view = loaded.view;
          const existing = yield* readRuns(storage, view.id);
          if (existing.some((run) => run.state.kind !== "finished")) continue;
          const currentRuns = existing.filter(
            (run) => run.definitionRevision === view.definition.revision,
          );

          let source: Schedule.ScheduleRunSource | undefined;
          if (view.definition.trigger.kind === "once") {
            if (currentRuns.length > 0) {
              yield* disableDefinition(view.id, view.definition.revision);
              continue;
            }
            if (view.definition.trigger.at > now) continue;
            source = { kind: "scheduled", scheduledFor: view.definition.trigger.at };
          } else {
            const latest = latestCronSlot(view.definition.trigger, now);
            if (latest === undefined || latest <= view.definition.createdAt) continue;
            if (
              currentRuns.some(
                (run) => run.source.kind === "scheduled" && run.source.scheduledFor === latest,
              )
            ) {
              continue;
            }
            source = { kind: "scheduled", scheduledFor: latest };
          }

          const claimed = yield* claim(view, source, runnerState).pipe(Effect.result);
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
          }
        }
        invalidDefinitions.clear();
        for (const id of invalid) invalidDefinitions.add(id);
      }),
    );
  });

  const reconcile = Effect.fn("Schedules.reconcile")(function* () {
    const runs = yield* readRuns(storage);
    for (const run of runs) {
      const definition = yield* readRunDefinition(storage, run);
      const terminal =
        run.state.kind === "finished"
          ? run
          : run.state.kind === "reporting-failure"
            ? yield* finish(run, {
                ...run.state.outcome,
                notification: { kind: "interrupted" },
              })
            : yield* finish(run, { kind: "interrupted", phase: run.state.kind });
      if (run.state.kind !== "finished") {
        yield* Effect.logInfo("Interrupted scheduled run reconciled").pipe(
          Effect.annotateLogs({
            ...runAnnotations(run),
            operation: "reconcile",
            phase: run.state.kind,
            outcome:
              terminal.state.kind === "finished" ? terminal.state.outcome.kind : "interrupted",
          }),
        );
      }
      if (definition.trigger.kind === "once" && definition.revision === run.definitionRevision) {
        yield* disableDefinition(run.scheduleId, run.definitionRevision);
      }
    }
  });

  const start = Effect.fn("Schedules.start")(function* (
    host: Schedule.ScheduleRunHost,
  ): Effect.fn.Return<void, Schedule.ScheduleError, Scope.Scope> {
    yield* initialize;
    const scope = yield* Effect.scope;
    const runnerState: RunnerState = { host, scope };
    const clearRunner = mutation.withPermit(
      Effect.sync(() => {
        if (runner === runnerState) runner = undefined;
      }),
    );
    const loop = Effect.gen(function* () {
      const cycle = scheduleCycle(runnerState).pipe(
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
      );
    });
    yield* mutation.withPermit(
      Effect.gen(function* () {
        if (runner !== undefined) {
          return yield* scheduleError("busy", "Scheduler is already running");
        }
        yield* reconcile();
        yield* Effect.gen(function* () {
          if (scope.state._tag === "Closed") {
            return yield* scheduleError("busy", "Scheduler scope is closed");
          }
          runner = runnerState;
          yield* loop.pipe(
            Effect.interruptible,
            Effect.ensuring(clearRunner),
            Effect.forkIn(scope, { startImmediately: true }),
          );
        }).pipe(Effect.uninterruptible);
      }),
    );
  });

  return {
    service: Schedule.Schedules.of({
      create,
      list,
      overview,
      get,
      update,
      remove,
      trigger,
      withCurrentTargets,
      start,
    }),
    initialize,
  };
});

export const make = Effect.fn("Schedules.make")(function* (
  schedulesDir: AbsolutePath,
  resolveTarget: Schedule.ScheduleRunHost["resolveTarget"],
  executable = process.execPath,
) {
  return (yield* capture(schedulesDir, resolveTarget, executable)).service;
});

export const open = Effect.fn("Schedules.open")(function* (
  schedulesDir: AbsolutePath,
  resolveTarget: Schedule.ScheduleRunHost["resolveTarget"],
  executable = process.execPath,
) {
  const captured = yield* capture(schedulesDir, resolveTarget, executable);
  yield* captured.initialize;
  return captured.service;
});

export const layer = (
  schedulesDir: AbsolutePath,
  resolveTarget: Schedule.ScheduleRunHost["resolveTarget"],
  executable = process.execPath,
) => Layer.effect(Schedule.Schedules, open(schedulesDir, resolveTarget, executable));
