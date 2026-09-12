import * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Storage } from "./storage.ts";
import { ensureRunAsset, runDirectory, writeArtifact, writeArtifactString } from "./storage.ts";

const CAPTURE_LIMIT = 256 * 1024;
const decodeDecision = Schema.decodeUnknownSync(Schema.fromJsonString(Schedule.ScriptDecision), {
  onExcessProperty: "error",
});

interface Capture {
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

interface StreamCapture {
  readonly result: Promise<Capture>;
  readonly cancel: () => Promise<void>;
}

export interface ScriptRun {
  readonly decision: Schedule.ScriptDecision;
  readonly stdout: Capture;
  readonly stderr: Capture;
  readonly exitCode: number;
  readonly timeoutMillis: number;
}

export class ScriptRunError extends Schema.TaggedError<ScriptRunError>()("ScriptRunError", {
  stage: Schema.Literals(["script", "protocol"]),
  message: Schema.String,
}) {}

const scriptError = (message: string) => new ScriptRunError({ stage: "script", message });

const protocolError = (message: string) => new ScriptRunError({ stage: "protocol", message });

const nativeScriptError = (message: string, cause: unknown) => {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    switch (cause.code) {
      case "ENOENT":
      case "EACCES":
      case "EPERM":
      case "EPIPE":
      case "EIO":
      case "EBADF":
      case "EAGAIN":
      case "ENOMEM":
      case "EMFILE":
      case "ENFILE":
      case "E2BIG":
      case "ENOEXEC":
      case "ENOTDIR":
      case "EISDIR":
      case "EINVAL":
      case "ETXTBSY":
        return scriptError(`${message} (${cause.code})`);
    }
  }
  return scriptError(message);
};

const recordFailureArtifact = Effect.fn("Schedules.recordScriptFailureArtifact")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
  artifact: string,
  content: string,
) {
  yield* writeArtifactString(storage, run, artifact, content).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError("Failed to record schedule script failure artifact").pipe(
            Effect.annotateLogs({
              component: "schedule",
              operation: "script",
              scheduleId: run.scheduleId,
              runId: run.id,
              phase: "failure-artifact",
              artifact,
              category: cause.reasons.some(Cause.isDieReason) ? "defect" : "io",
            }),
          ),
    ),
  );
});

const failWithDecision = Effect.fn("Schedules.failScriptRun")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
  error: ScriptRunError,
) {
  yield* recordFailureArtifact(
    storage,
    run,
    "decision.json",
    JSON.stringify({ kind: "failed", message: error.message }),
  );
  return yield* error;
});

const captureStream = (stream: ReadableStream<Uint8Array>): StreamCapture => {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let retained = 0;
  let totalBytes = 0;
  let cancelled = false;
  let settled = false;
  let cancellation: Promise<void> | undefined;
  const result = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        totalBytes += next.value.byteLength;
        const available = CAPTURE_LIMIT - retained;
        if (available > 0) {
          const chunk =
            next.value.byteLength <= available ? next.value : next.value.slice(0, available);
          chunks.push(chunk);
          retained += chunk.byteLength;
        }
      }
    } catch (cause) {
      if (!cancelled) throw cause;
    } finally {
      settled = true;
      reader.releaseLock();
    }
    const bytes = new Uint8Array(retained);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, totalBytes, truncated: totalBytes > retained };
  })();
  return {
    result,
    cancel: () => {
      cancelled = true;
      cancellation ??= Promise.resolve().then(() => {
        if (!settled) return reader.cancel();
      });
      return cancellation;
    },
  };
};

const curatedEnvironment = (
  run: Schedule.ScheduleRunLifecycle,
  target: Schedule.ResolvedScheduleRunTarget,
) => {
  const env: Record<string, string> = {
    PICO_SCHEDULE_ID: run.scheduleId,
    PICO_RUN_ID: run.id,
    PICO_CHAT_ID: target.chatId,
    PICO_WORKSPACE_ID: target.workspaceId,
  };
  for (const name of ["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

const stdinDocument = (
  run: Schedule.ScheduleRunLifecycle,
  target: Schedule.ResolvedScheduleRunTarget,
) => ({
  scheduleId: run.scheduleId,
  runId: run.id,
  source: run.source,
  claimedAt: run.claimedAt,
  target: {
    kind: run.plannedTarget.kind,
    chatId: target.chatId,
    workspaceId: target.workspaceId,
  },
});

export const runScript = Effect.fn("Schedules.runScript")(
  function* (
    storage: Storage,
    executable: string,
    run: Schedule.ScheduleRunLifecycle,
    target: Schedule.ResolvedScheduleRunTarget,
    timeoutMillis = Schedule.DEFAULT_SCRIPT_TIMEOUT_MS,
  ): Effect.fn.Return<ScriptRun, Schedule.ScheduleError | ScriptRunError> {
    const scriptPath = storage.path.join(
      runDirectory(storage, run.scheduleId, run.id),
      "input",
      "script.js",
    );
    const stdin = JSON.stringify(stdinDocument(run, target));
    yield* ensureRunAsset(storage, run, "input/script.js");
    yield* writeArtifactString(storage, run, "script/stdin.json", stdin);
    yield* Effect.all(
      [
        writeArtifact(storage, run, "script/stdout.bin", new Uint8Array()),
        writeArtifact(storage, run, "script/stderr.bin", new Uint8Array()),
        writeArtifactString(
          storage,
          run,
          "script/result.json",
          JSON.stringify({ kind: "started", timeoutMillis }),
        ),
      ],
      { concurrency: "unbounded", discard: true },
    );

    const attempted = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const child = Bun.spawn({
            cmd: [executable, scriptPath],
            cwd: target.cwd,
            env: curatedEnvironment(run, target),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          });
          return {
            child,
            stdoutCapture: captureStream(child.stdout),
            stderrCapture: captureStream(child.stderr),
          };
        },
        catch: (cause) => nativeScriptError("Failed to spawn schedule script", cause),
      }),
      ({ child, stdoutCapture, stderrCapture }) =>
        Effect.tryPromise({
          try: async (signal) => {
            let timedOut = false;
            let forceKill: ReturnType<typeof setTimeout> | undefined;
            const cancelCaptures = () =>
              Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()])
                .then(() => undefined)
                .catch(() => undefined);
            const exited = child.exited.finally(cancelCaptures);
            const terminate = () => {
              if (child.exitCode === null) child.kill("SIGTERM");
            };
            const onAbort = () => {
              terminate();
              void cancelCaptures();
            };
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
            const timeout = setTimeout(() => {
              if (child.exitCode === null) {
                timedOut = true;
                child.kill("SIGTERM");
                forceKill = setTimeout(() => {
                  if (child.exitCode === null) child.kill("SIGKILL");
                }, 1_000);
              }
              void cancelCaptures();
            }, timeoutMillis);
            try {
              child.stdin.write(stdin);
              child.stdin.end();
              const [stdout, stderr, exitCode] = await Promise.all([
                stdoutCapture.result,
                stderrCapture.result,
                exited,
              ]);
              return {
                stdout,
                stderr,
                exitCode,
                signalCode: child.signalCode,
                timedOut,
              };
            } finally {
              signal.removeEventListener("abort", onAbort);
              clearTimeout(timeout);
              clearTimeout(forceKill);
              void cancelCaptures();
            }
          },
          catch: (cause) => nativeScriptError("Failed to capture schedule script execution", cause),
        }),
      ({ child, stdoutCapture, stderrCapture }) =>
        Effect.promise(async () => {
          if (child.exitCode !== null) return;
          child.kill("SIGTERM");
          const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
          await child.exited.finally(() => clearTimeout(forceKill));
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to stop interrupted schedule script").pipe(
                  Effect.annotateLogs({ phase: "child-stop", category: "operation" }),
                ),
          ),
          Effect.andThen(
            Effect.forEach(
              [
                { stream: "stdout", capture: stdoutCapture },
                { stream: "stderr", capture: stderrCapture },
              ],
              ({ stream, capture }) =>
                Effect.tryPromise({
                  try: capture.cancel,
                  catch: () => scriptError("Failed to cancel schedule script output reader"),
                }).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.void
                      : Effect.logError("Failed to cancel schedule script output reader").pipe(
                          Effect.annotateLogs({ phase: "reader-cleanup", stream }),
                        ),
                  ),
                ),
              { discard: true },
            ),
          ),
        ),
    ).pipe(Effect.result);
    if (Result.isFailure(attempted)) {
      yield* recordFailureArtifact(
        storage,
        run,
        "script/result.json",
        JSON.stringify({ kind: "failed", message: attempted.failure.message, timeoutMillis }),
      );
      return yield* failWithDecision(storage, run, attempted.failure);
    }
    const processResult = attempted.success;
    const processFailure = processResult.timedOut
      ? scriptError(`Schedule script timed out after ${timeoutMillis} milliseconds`)
      : processResult.signalCode !== null
        ? scriptError(`Schedule script terminated by signal ${processResult.signalCode}`)
        : processResult.exitCode !== 0
          ? scriptError(`Schedule script exited with status ${processResult.exitCode}`)
          : processResult.stdout.truncated
            ? protocolError("Schedule script stdout exceeded 256 KiB")
            : undefined;
    const decoded =
      processFailure === undefined
        ? yield* Effect.try({
            try: () =>
              decodeDecision(
                new TextDecoder("utf-8", { fatal: true }).decode(processResult.stdout.bytes),
              ),
            catch: () => protocolError("Schedule script returned an invalid decision"),
          }).pipe(Effect.result)
        : Result.fail(processFailure);

    yield* Effect.all(
      [
        writeArtifact(storage, run, "script/stdout.bin", processResult.stdout.bytes),
        writeArtifact(storage, run, "script/stderr.bin", processResult.stderr.bytes),
        writeArtifactString(
          storage,
          run,
          "script/result.json",
          JSON.stringify({
            timeoutMillis,
            exitCode: processResult.exitCode,
            signalCode: processResult.signalCode,
            timedOut: processResult.timedOut,
            stdout: {
              totalBytes: processResult.stdout.totalBytes,
              truncated: processResult.stdout.truncated,
            },
            stderr: {
              totalBytes: processResult.stderr.totalBytes,
              truncated: processResult.stderr.truncated,
            },
          }),
        ),
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(
      Effect.catchCause((cause) => {
        if (Result.isSuccess(decoded) || Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logError("Failed to record schedule script result artifacts").pipe(
          Effect.annotateLogs({
            phase: "failure-artifact",
            category: cause.reasons.some(Cause.isDieReason) ? "defect" : "io",
          }),
        );
      }),
    );
    if (Result.isFailure(decoded)) {
      return yield* failWithDecision(storage, run, decoded.failure);
    }
    const decision = decoded.success;
    yield* writeArtifactString(storage, run, "decision.json", JSON.stringify(decision));
    return {
      decision,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      exitCode: processResult.exitCode,
      timeoutMillis,
    };
  },
  (
    effect,
    _storage,
    _executable,
    run,
    target,
    _timeoutMillis = Schedule.DEFAULT_SCRIPT_TIMEOUT_MS,
  ) =>
    effect.pipe(
      Effect.annotateLogs({
        component: "schedule",
        operation: "script",
        scheduleId: run.scheduleId,
        runId: run.id,
        chatId: target.chatId,
        workspaceId: target.workspaceId,
      }),
    ),
);
