import { assert, describe, it } from "@effect/vitest";
import type * as AgentEvent from "@pico/contract/agent-event";
import * as Agent from "@pico/contract/agent-message";
import type { MessageDelivery, ShakeMode, ShakeResult } from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import { makeSessionPool } from "./session-pool.ts";

const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001");

const prompt = (text: string) => Agent.AgentPrompt.make({ text, attachments: [] });

const admitted: MessageDelivery = { kind: "started", completed: Effect.void };

const shakeResult = (mode: ShakeMode): ShakeResult => {
  switch (mode) {
    case "elide":
      return { mode, toolResultsDropped: 1, blocksDropped: 2, tokensFreed: 300 };
    case "images":
      return { mode, imagesDropped: 3, tokensFreed: 0 };
    case "thinking":
      return { mode, thinkingBlocksDropped: 4, tokensFreed: 500 };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
};

describe("session pool capture", () => {
  it.effect(
    "waits for capture ownership outside admission and permits steers during a captured run",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ordinaryFinished = yield* Deferred.make<void>();
          const captureStarted = yield* Deferred.make<void>();
          const captureFinished = yield* Deferred.make<void>();
          const persistenceStarted = yield* Deferred.make<void>();
          const persistenceFinished = yield* Deferred.make<void>();
          const submitted: string[] = [];
          const captured: string[] = [];
          const pool = yield* makeSessionPool({
            factory: {
              open: (_id, emit) =>
                Effect.succeed({
                  session: {
                    isStreaming: false,
                    waitForIdle: async () => {},
                    settleInFlightMessagePersistence: () =>
                      captured.includes("run-finished")
                        ? Effect.runPromise(
                            Deferred.succeed(persistenceStarted, undefined).pipe(
                              Effect.andThen(Deferred.await(persistenceFinished)),
                            ),
                          )
                        : Promise.resolve(),
                    abort: async () => {},
                    beginDispose: () => {},
                    dispose: async () => {},
                  },
                  askBtw: () => Promise.reject(new Error("unexpected side question")),
                  switchModel: () => Promise.reject(new Error("unexpected model switch")),
                  flush: () => Promise.resolve(),
                  sendPrompt: async (value, onStarted): Promise<MessageDelivery> => {
                    if (value.text === "reject")
                      throw new AgentError({ message: "Rejected before admission" });
                    submitted.push(value.text);
                    if (value.text === "steer") {
                      return {
                        kind: "steered",
                        consumed: Effect.succeed("consumed"),
                        completed: Effect.void,
                      };
                    }
                    onStarted?.();
                    emit({ type: "run-started" });
                    if (value.text === "scheduled")
                      Deferred.doneUnsafe(captureStarted, Effect.void);
                    return {
                      kind: "started",
                      completed: Deferred.await(
                        value.text === "scheduled" ? captureFinished : ordinaryFinished,
                      ).pipe(
                        Effect.tap(() =>
                          Effect.sync(() => emit({ type: "run-finished", outcome: "completed" })),
                        ),
                      ),
                    };
                  },
                  shake: async (mode) => shakeResult(mode),
                  contextUsage: () => ({ kind: "unavailable" }),
                  appendAssistantMessage: async () => {},
                  unsubscribe: () => {},
                }),
            },
            loadTranscript: () =>
              Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
          });
          yield* pool.send(chatId, prompt("ordinary"));
          assert.instanceOf(
            yield* pool.send(chatId, prompt("reject")).pipe(Effect.flip),
            AgentError,
          );
          const scheduled = yield* pool
            .sendCaptured(
              chatId,
              Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003"),
              prompt("scheduled"),
              (event) =>
                Effect.sync(() => {
                  captured.push(event.type);
                }),
            )
            .pipe(Effect.forkChild);
          assert.strictEqual((yield* pool.send(chatId, prompt("steer"))).kind, "steered");
          assert.isFalse(yield* Deferred.isDone(captureStarted));
          yield* Deferred.succeed(ordinaryFinished, undefined);
          yield* Deferred.await(captureStarted);
          assert.strictEqual((yield* pool.send(chatId, prompt("steer"))).kind, "steered");
          yield* Deferred.succeed(captureFinished, undefined);
          yield* Deferred.await(persistenceStarted);
          const following = yield* pool.send(chatId, prompt("following")).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.deepStrictEqual(submitted, ["ordinary", "steer", "scheduled", "steer"]);
          yield* Deferred.succeed(persistenceFinished, undefined);
          assert.strictEqual((yield* Fiber.join(scheduled)).outcome, "completed");
          assert.strictEqual((yield* Fiber.join(following)).kind, "started");
          assert.deepStrictEqual(captured, ["run-started", "run-finished"]);
        }),
      ),
  );

  it.live("releases a scheduled waiter after a new admission overtakes a queued terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const followingFinished = yield* Deferred.make<void>();
        const pool = yield* makeSessionPool({
          factory: {
            open: (_id, emit) =>
              Effect.succeed({
                session: {
                  isStreaming: false,
                  waitForIdle: async () => {},
                  settleInFlightMessagePersistence: async () => {},
                  abort: async () => {},
                  beginDispose: () => {},
                  dispose: async () => {},
                },
                askBtw: () => Promise.reject(new Error("unexpected side question")),
                switchModel: () => Promise.reject(new Error("unexpected model switch")),
                flush: () => Promise.resolve(),
                sendPrompt: async (value, onStarted): Promise<MessageDelivery> => {
                  if (value.text === "following") {
                    emit({ type: "run-finished", outcome: "completed" });
                  }
                  onStarted?.();
                  emit({ type: "run-started" });
                  if (value.text === "ordinary") {
                    return { kind: "started", completed: Effect.void };
                  }
                  return {
                    kind: "started",
                    completed: (value.text === "following"
                      ? Deferred.await(followingFinished)
                      : Effect.void
                    ).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => emit({ type: "run-finished", outcome: "completed" })),
                      ),
                    ),
                  };
                },
                shake: async (mode) => shakeResult(mode),
                contextUsage: () => ({ kind: "unavailable" }),
                appendAssistantMessage: async () => {},
                unsubscribe: () => {},
              }),
          },
          loadTranscript: () =>
            Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
        });
        yield* Effect.gen(function* () {
          const first = yield* pool.send(chatId, prompt("ordinary"));
          if (first.kind !== "started") return yield* Effect.die("Expected ordinary admission");
          yield* first.completed;
          const captured = yield* pool
            .sendCaptured(
              chatId,
              Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003"),
              prompt("scheduled"),
              () => Effect.void,
            )
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const next = yield* pool.send(chatId, prompt("following"));
          if (next.kind !== "started") return yield* Effect.die("Expected following admission");
          yield* Deferred.succeed(followingFinished, undefined);
          yield* next.completed;
          const result = yield* Effect.raceFirst(
            Fiber.join(captured),
            Effect.sleep("1 second").pipe(Effect.as(null)),
          );
          assert.strictEqual(result?.outcome, "completed");
          assert.deepStrictEqual(
            result?.events.map((event) => event.type),
            ["run-started", "run-finished"],
          );
        }).pipe(Effect.ensuring(Deferred.succeed(followingFinished, undefined)));
      }),
    ),
  );

  it.effect("captures one scheduled run without forwarding its events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pool = yield* makeSessionPool({
          factory: {
            open: (_id, emit) =>
              Effect.succeed({
                session: {
                  isStreaming: false,
                  waitForIdle: async () => {},
                  settleInFlightMessagePersistence: () => Promise.resolve(),
                  abort: () => Promise.resolve(),
                  beginDispose: () => {},
                  dispose: () => Promise.resolve(),
                },
                askBtw: () => Promise.reject(new Error("unexpected side question")),
                switchModel: () => Promise.reject(new Error("unexpected model switch")),
                flush: () => Promise.resolve(),
                sendPrompt: (_value, onStarted) => {
                  onStarted?.();
                  emit({ type: "run-started" });
                  emit({
                    type: "message-settled",
                    message: {
                      role: "assistant",
                      id: Agent.AgentMessageId.make("captured-answer"),
                      status: "completed",
                      stopReason: "stop",
                      content: [{ type: "text", text: "scheduled answer" }],
                      model: "test",
                      timestamp: 1,
                    },
                  });
                  emit({ type: "run-finished", outcome: "completed" });
                  return Promise.resolve(admitted);
                },
                shake: async (mode) => shakeResult(mode),
                appendAssistantMessage: () => Promise.resolve(),
                contextUsage: () => ({ kind: "unavailable" }),
                unsubscribe: () => {},
              }),
          },
          loadTranscript: () =>
            Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
        });
        const observed: Array<string> = [];
        const runId = Schedule.ScheduleRunId.make(
          "scheduled-1000-018f47a0-0000-7000-8000-000000000003",
        );
        const captured = yield* pool.sendCaptured(chatId, runId, prompt("scheduled"), (event) =>
          Effect.sync(() => observed.push(event.type)).pipe(Effect.asVoid),
        );
        assert.deepStrictEqual(captured, {
          runId,
          outcome: "completed",
          events: [
            { type: "run-started" },
            {
              type: "message-settled",
              message: {
                role: "assistant",
                id: Agent.AgentMessageId.make("captured-answer"),
                status: "completed",
                stopReason: "stop",
                content: [{ type: "text", text: "scheduled answer" }],
                model: "test",
                timestamp: 1,
              },
            },
            { type: "run-finished", outcome: "completed" },
          ],
          finalAssistantText: "scheduled answer",
        });
        assert.deepStrictEqual(observed, ["run-started", "message-settled", "run-finished"]);
      }),
    ),
  );

  it.effect("forwards delayed session titles while a scheduled run is captured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const captureStarted = yield* Deferred.make<void>();
        let emitEvent: ((event: AgentEvent.AgentEvent) => void) | undefined;
        let completeCapture: (() => void) | undefined;
        const pool = yield* makeSessionPool({
          factory: {
            open: (_id, emit) => {
              emitEvent = emit;
              return Effect.succeed({
                session: {
                  isStreaming: false,
                  waitForIdle: async () => {},
                  settleInFlightMessagePersistence: () => Promise.resolve(),
                  abort: () => Promise.resolve(),
                  beginDispose: () => {},
                  dispose: () => Promise.resolve(),
                },
                askBtw: () => Promise.reject(new Error("unexpected side question")),
                switchModel: () => Promise.reject(new Error("unexpected model switch")),
                flush: () => Promise.resolve(),
                sendPrompt: (_value, onStarted) => {
                  onStarted?.();
                  emit({ type: "run-started" });
                  const pending = new Promise<void>((resolve) => {
                    completeCapture = () => {
                      emit({ type: "run-finished", outcome: "completed" });
                      resolve();
                    };
                  });
                  Effect.runSync(Deferred.succeed(captureStarted, undefined));
                  return Promise.resolve({
                    kind: "started" as const,
                    completed: Effect.promise(() => pending),
                  });
                },
                shake: async (mode) => shakeResult(mode),
                appendAssistantMessage: () => Promise.resolve(),
                contextUsage: () => ({ kind: "unavailable" }),
                unsubscribe: () => {},
              });
            },
          },
          loadTranscript: () =>
            Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
        });
        const forwarded = yield* pool.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        const capturedTypes: Array<string> = [];
        const capture = yield* pool
          .sendCaptured(
            chatId,
            Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003"),
            prompt("scheduled"),
            (event) =>
              Effect.sync(() => {
                capturedTypes.push(event.type);
              }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(captureStarted);
        if (emitEvent === undefined || completeCapture === undefined) {
          return yield* Effect.die("Session controls were not initialized");
        }
        emitEvent({ type: "title-changed", title: "Delayed title" });
        completeCapture();
        const result = yield* Fiber.join(capture);
        assert.deepStrictEqual(capturedTypes, ["run-started", "run-finished"]);
        assert.deepStrictEqual(
          result.events.map((event) => event.type),
          ["run-started", "run-finished"],
        );
        assert.deepStrictEqual(
          (yield* Fiber.join(forwarded)).map((envelope) => envelope.event),
          [{ type: "title-changed", title: "Delayed title" }],
        );
      }),
    ),
  );

  it.effect("preserves capture sink failure when abort cleanup also fails", () => {
    const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
    return Effect.scoped(
      Effect.gen(function* () {
        const abortCalled = yield* Deferred.make<void>();
        let sends = 0;
        const primaryFailure = new AgentError({ message: "Artifact sink failed" });
        let resolvePendingPrompt: (() => void) | undefined;
        const pool = yield* makeSessionPool({
          factory: {
            open: (_id, emit) =>
              Effect.succeed({
                session: {
                  isStreaming: false,
                  waitForIdle: async () => {},
                  settleInFlightMessagePersistence: () => Promise.resolve(),
                  abort: () => {
                    resolvePendingPrompt?.();
                    emit({ type: "run-finished", outcome: "aborted" });
                    Effect.runSync(Deferred.succeed(abortCalled, undefined));
                    return Promise.reject(new Error("private abort failure"));
                  },
                  beginDispose: () => {},
                  dispose: () => Promise.resolve(),
                },
                askBtw: () => Promise.reject(new Error("unexpected side question")),
                switchModel: () => Promise.reject(new Error("unexpected model switch")),
                flush: () => Promise.resolve(),
                sendPrompt: (_value, onStarted) => {
                  sends += 1;
                  if (sends === 1) {
                    onStarted?.();
                    emit({ type: "run-started" });
                    const pending = new Promise<void>((resolve) => {
                      resolvePendingPrompt = resolve;
                    });
                    return Promise.resolve({
                      kind: "started" as const,
                      completed: Effect.promise(() => pending),
                    });
                  }
                  if (sends === 2) {
                    onStarted?.();
                    emit({ type: "run-started" });
                    emit({ type: "run-finished", outcome: "completed" });
                  } else {
                    emit({ type: "title-changed", title: "ordinary" });
                  }
                  return Promise.resolve(admitted);
                },
                shake: async (mode) => shakeResult(mode),
                appendAssistantMessage: () => Promise.resolve(),
                contextUsage: () => ({ kind: "unavailable" }),
                unsubscribe: () => {},
              }),
          },
          loadTranscript: () =>
            Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
        });
        const forwarded: Array<string> = [];
        yield* pool.events.pipe(
          Stream.runForEach((envelope) =>
            Effect.sync(() => {
              forwarded.push(envelope.event.type);
            }),
          ),
          Effect.forkChild,
        );
        const runId = Schedule.ScheduleRunId.make(
          "scheduled-1000-018f47a0-0000-7000-8000-000000000003",
        );
        const capturedTypes: Array<string> = [];
        const failedCapture = yield* pool
          .sendCaptured(chatId, runId, prompt("fails to capture"), (event) =>
            Effect.gen(function* () {
              capturedTypes.push(event.type);
              if (capturedTypes.length === 1) {
                return yield* primaryFailure;
              }
            }),
          )
          .pipe(Effect.flip, Effect.forkChild);

        yield* Deferred.await(abortCalled);
        const sinkFailure = yield* Fiber.join(failedCapture);
        assert.strictEqual(sinkFailure, primaryFailure);
        const errors = records.filter((record) => record.level === "ERROR");
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0]?.annotations.chatId, chatId);
        assert.strictEqual(errors[0]?.annotations.runId, runId);
        assert.strictEqual(errors[0]?.annotations.phase, "capture-abort");
        assert.notInclude(JSON.stringify(errors), "private abort failure");
        assert.deepStrictEqual(capturedTypes, ["run-started", "run-finished"]);

        const recovered = yield* pool.sendCaptured(
          chatId,
          runId,
          prompt("capture after failure"),
          () => Effect.void,
        );
        assert.strictEqual(recovered.outcome, "completed");
        yield* pool.send(chatId, prompt("ordinary"));
        yield* pool.drain();
        assert.deepStrictEqual(forwarded, ["title-changed"]);
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => records.push(Logger.formatStructured.log(options))),
        ]),
      ),
    );
  });

  it.effect("drains interrupted capture without reporting cancellation as a failure", () => {
    const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
    let abortGoalReason: string | undefined;
    return Effect.scoped(
      Effect.gen(function* () {
        const runStarted = yield* Deferred.make<void>();
        let sends = 0;
        const pool = yield* makeSessionPool({
          factory: {
            open: (_id, emit) =>
              Effect.succeed({
                session: {
                  isStreaming: false,
                  waitForIdle: async () => {},
                  settleInFlightMessagePersistence: () => Promise.resolve(),
                  abort: (options) => {
                    abortGoalReason = options?.goalReason;
                    emit({ type: "title-changed", title: "captured-after-abort" });
                    emit({ type: "run-finished", outcome: "aborted" });
                    return Promise.resolve();
                  },
                  beginDispose: () => {},
                  dispose: () => Promise.resolve(),
                },
                askBtw: () => Promise.reject(new Error("unexpected side question")),
                switchModel: () => Promise.reject(new Error("unexpected model switch")),
                flush: () => Promise.resolve(),
                sendPrompt: (_value, onStarted) => {
                  sends += 1;
                  if (sends === 1) {
                    onStarted?.();
                    emit({ type: "run-started" });
                    Effect.runSync(Deferred.succeed(runStarted, undefined));
                  } else {
                    emit({ type: "title-changed", title: "ordinary" });
                  }
                  return Promise.resolve(admitted);
                },
                shake: async (mode) => shakeResult(mode),
                appendAssistantMessage: () => Promise.resolve(),
                contextUsage: () => ({ kind: "unavailable" }),
                unsubscribe: () => {},
              }),
          },
          loadTranscript: () =>
            Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
        });
        const forwarded: Array<string> = [];
        yield* pool.events.pipe(
          Stream.runForEach((envelope) =>
            Effect.sync(() => {
              forwarded.push(envelope.event.type);
            }),
          ),
          Effect.forkChild,
        );
        const capture = yield* pool
          .sendCaptured(
            chatId,
            Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003"),
            prompt("interrupt me"),
            () => Effect.void,
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(runStarted);
        yield* Fiber.interrupt(capture);
        const interrupted = yield* Fiber.await(capture);
        assert.isTrue(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause));
        assert.strictEqual(abortGoalReason, "interrupted");
        yield* pool.send(chatId, prompt("ordinary"));
        yield* pool.drain();
        assert.deepStrictEqual(forwarded, ["title-changed", "title-changed"]);
        assert.deepStrictEqual(
          records.filter((record) => record.level === "ERROR"),
          [],
        );
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => records.push(Logger.formatStructured.log(options))),
        ]),
      ),
    );
  });

  it.effect(
    "assigns ordinary terminal failures to one owner and leaves captures to the scheduler",
    () => {
      const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      return Effect.scoped(
        Effect.gen(function* () {
          const rejected = new AgentError({ message: "Prompt dispatch rejected" });
          let emitLater: ((event: AgentEvent.AgentEvent) => void) | undefined;
          const pool = yield* makeSessionPool({
            factory: {
              open: (_id, emit) =>
                Effect.succeed({
                  session: {
                    isStreaming: false,
                    waitForIdle: async () => {},
                    settleInFlightMessagePersistence: () => Promise.resolve(),
                    abort: () => Promise.resolve(),
                    beginDispose: () => {},
                    dispose: () => Promise.resolve(),
                  },
                  askBtw: () => Promise.reject(new Error("unexpected side question")),
                  switchModel: () => Promise.reject(new Error("unexpected model switch")),
                  flush: () => Promise.resolve(),
                  sendPrompt: (value, onStarted) => {
                    if (value.text === "reject") return Promise.reject(rejected);
                    if (value.text === "abort-reject")
                      return Promise.reject(new DOMException("private abort", "AbortError"));
                    onStarted?.();
                    emit({ type: "run-started" });
                    emit({
                      type: "message-settled",
                      message: {
                        role: "assistant",
                        id: Agent.AgentMessageId.make("captured-failure"),
                        status: "failed",
                        stopReason: "error",
                        message: "private provider payload",
                        content: [],
                        model: "private model",
                        timestamp: 1,
                      },
                    });
                    if (value.text === "queued-terminal") {
                      return new Promise<MessageDelivery>((resolve) => {
                        queueMicrotask(() => {
                          resolve(admitted);
                          queueMicrotask(() => emit({ type: "run-finished", outcome: "failed" }));
                        });
                      });
                    }
                    if (value.text === "late") {
                      emitLater = emit;
                      return Promise.resolve(admitted);
                    }
                    emit({
                      type: "run-finished",
                      outcome: value.text === "abort" ? "aborted" : "failed",
                    });
                    return Promise.resolve(admitted);
                  },
                  shake: async (mode) => shakeResult(mode),
                  appendAssistantMessage: () => Promise.resolve(),
                  contextUsage: () => ({ kind: "unavailable" }),
                  unsubscribe: () => {},
                }),
            },
            loadTranscript: () =>
              Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
          });
          const resolved = yield* pool.send(chatId, prompt("resolved"));
          if (resolved.kind !== "handled") yield* resolved.completed;
          assert.strictEqual(records.filter((record) => record.level === "ERROR").length, 1);
          assert.strictEqual(
            yield* pool.send(chatId, prompt("reject")).pipe(Effect.flip),
            rejected,
          );
          yield* pool.send(chatId, prompt("abort"));
          const interrupted = yield* pool.send(chatId, prompt("abort-reject")).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause));
          const captured = yield* pool.sendCaptured(
            chatId,
            Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003"),
            prompt("captured"),
            () => Effect.void,
          );
          assert.strictEqual(captured.outcome, "failed");
          assert.strictEqual(records.filter((record) => record.level === "ERROR").length, 1);
          const queued = yield* pool.send(chatId, prompt("queued-terminal"));
          if (queued.kind !== "handled") yield* queued.completed;
          yield* pool.send(chatId, prompt("late"));
          emitLater?.({ type: "run-finished", outcome: "failed" });
          yield* pool.close(chatId);
          const errors = records.filter((record) => record.level === "ERROR");
          assert.strictEqual(errors.length, 3);
          assert.isTrue(
            errors.every(
              (record) =>
                record.annotations.chatId === chatId && record.annotations.operation === "run",
            ),
          );
          assert.notInclude(JSON.stringify(records), "private");
        }),
      ).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((options) => records.push(Logger.formatStructured.log(options))),
          ]),
        ),
      );
    },
  );
});
