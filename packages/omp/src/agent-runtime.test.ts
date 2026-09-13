import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as OmpSessionManager from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type * as AgentEvent from "@pico/contract/agent-event";
import * as Agent from "@pico/contract/agent-message";
import type {
  ContextUsage,
  MessageDelivery,
  ShakeMode,
  ShakeResult,
} from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { normalizeAgentEvent, normalizeTranscript } from "./agent-event.ts";
import { makeSessionPool, type OpenedSession, type SessionFactory } from "./session-pool.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
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

describe("AgentRuntime", () => {
  it.effect("settles admitted receipts when the owning scope closes", () =>
    Effect.gen(function* () {
      const owner = yield* Scope.make();
      const nativeConsumption = yield* Deferred.make<"consumed" | "discarded">();
      const pool = yield* makeSessionPool({
        factory: {
          open: () =>
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
              sendPrompt: async (): Promise<MessageDelivery> => ({
                kind: "steered",
                consumed: Deferred.await(nativeConsumption),
                completed: Effect.never,
              }),
              shake: async (mode) => shakeResult(mode),
              contextUsage: () => ({ kind: "unavailable" }),
              appendAssistantMessage: async () => {},
              unsubscribe: () => {},
            }),
        },
        loadTranscript: () => Effect.succeed([]),
      }).pipe(Scope.provide(owner));
      const delivery = yield* pool.send(chatId, prompt("queued"));
      if (delivery.kind !== "steered") return yield* Effect.die("Expected steering admission");
      yield* Scope.close(owner, Exit.void);
      assert.strictEqual(yield* delivery.consumed, "discarded");
      const completed = yield* delivery.completed.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(completed) && Cause.hasInterruptsOnly(completed.cause));
      yield* Deferred.succeed(nativeConsumption, "consumed");
      assert.strictEqual(yield* delivery.consumed, "discarded");
    }),
  );

  it.effect(
    "keeps admission and exact consumption independent of operation completion and close",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const releaseRun = yield* Deferred.make<void>();
          const releaseSteer = yield* Deferred.make<void>();
          const consumeFirst = yield* Deferred.make<"consumed" | "discarded">();
          const consumeSecond = yield* Deferred.make<"consumed" | "discarded">();
          const disposed = yield* Deferred.make<void>();
          const submitted: string[] = [];
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
                    dispose: async () => {
                      Deferred.doneUnsafe(disposed, Effect.void);
                    },
                  },
                  askBtw: () => Promise.reject(new Error("unexpected side question")),
                  sendPrompt: async (value, onStarted): Promise<MessageDelivery> => {
                    submitted.push(value.text);
                    if (submitted.length === 1) {
                      onStarted?.();
                      emit({ type: "run-started" });
                      return {
                        kind: "started",
                        completed: Deferred.await(releaseRun).pipe(
                          Effect.tap(() =>
                            Effect.sync(() => emit({ type: "run-finished", outcome: "completed" })),
                          ),
                        ),
                      };
                    }
                    return {
                      kind: "steered",
                      consumed: Deferred.await(
                        submitted.length === 2 ? consumeFirst : consumeSecond,
                      ),
                      completed: Deferred.await(releaseSteer),
                    };
                  },
                  shake: async (mode) => shakeResult(mode),
                  contextUsage: () => ({ kind: "unavailable" }),
                  appendAssistantMessage: async () => {},
                  unsubscribe: () => {},
                }),
            },
            loadTranscript: () => Effect.succeed([]),
          });
          const first = yield* pool.send(chatId, prompt("same"));
          const second = yield* pool.send(chatId, prompt("same"));
          const third = yield* pool.send(chatId, prompt("same"));
          if (first.kind !== "started" || second.kind !== "steered" || third.kind !== "steered") {
            return yield* Effect.die("Unexpected delivery kinds");
          }
          assert.deepStrictEqual(submitted, ["same", "same", "same"]);
          yield* Deferred.succeed(consumeFirst, "consumed");
          assert.strictEqual(yield* second.consumed, "consumed");
          assert.isFalse(yield* Deferred.isDone(releaseRun));
          assert.isFalse(yield* Deferred.isDone(releaseSteer));
          const closing = yield* pool.close(chatId).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.isFalse(yield* Deferred.isDone(disposed));
          yield* Deferred.succeed(releaseRun, undefined);
          yield* Deferred.succeed(releaseSteer, undefined);
          yield* Fiber.join(closing);
          assert.strictEqual(yield* third.consumed, "discarded");
          yield* Deferred.succeed(consumeSecond, "consumed");
          assert.strictEqual(yield* third.consumed, "discarded");
          assert.isTrue(yield* Deferred.isDone(disposed));
        }),
      ),
  );

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
            loadTranscript: () => Effect.succeed([]),
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
          loadTranscript: () => Effect.succeed([]),
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

  it("hides ignored OMP events", () => {
    assert.isUndefined(normalizeAgentEvent({ type: "config_warnings_changed" }));
    assert.isUndefined(normalizeAgentEvent({ type: "advisor_yielded" }));
    assert.isUndefined(
      normalizeAgentEvent({
        type: "tool_stream_update",
        toolCallId: "call-1",
        toolName: "read",
        update: { output: "partial" },
      }),
    );
  });

  it.effect("owns normalized events and one ordered session lifecycle", () =>
    Effect.gen(function* () {
      const toolArguments = { path: "before.ts" };
      const normalized = normalizeAgentEvent({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: toolArguments,
      });
      toolArguments.path = "after.ts";
      assert.deepStrictEqual(normalized, {
        type: "tool-started",
        toolCallId: "call-1",
        toolName: "read",
        argumentsJson: '{"path":"before.ts"}',
      });

      const started = yield* Deferred.make<void>();
      const allowOpen = yield* Deferred.make<void>();
      const lifecycle: Array<string> = [];
      let acquisitions = 0;

      const factory: SessionFactory = {
        open: (_requestedChatId, emit) =>
          Effect.gen(function* () {
            acquisitions += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(allowOpen);
            return {
              session: {
                isStreaming: false,
                waitForIdle: async () => {},
                settleInFlightMessagePersistence: () => Promise.resolve(),
                abort: () => Promise.resolve(),
                beginDispose: () => {
                  lifecycle.push("begin-dispose");
                },
                dispose: () => {
                  lifecycle.push("dispose");
                  return Promise.resolve();
                },
              },
              askBtw: () => Promise.reject(new Error("unexpected side question")),
              sendPrompt: (value) => {
                if (value.text !== "acquire") {
                  emit({ type: "notice", level: "info", message: value.text });
                }
                return Promise.resolve(admitted);
              },
              shake: async (mode) => shakeResult(mode),
              appendAssistantMessage: () => Promise.resolve(),
              contextUsage: () => ({ kind: "unavailable" }),
              unsubscribe: () => {
                lifecycle.push("unsubscribe");
              },
            };
          }),
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const pool = yield* makeSessionPool({
            factory,
            loadTranscript: () => Effect.succeed([]),
          });
          const firstAcquisitions = yield* Effect.all(
            [pool.send(chatId, prompt("acquire")), pool.send(chatId, prompt("acquire"))],
            { concurrency: "unbounded", discard: true },
          ).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          assert.strictEqual(acquisitions, 1);
          yield* Deferred.succeed(allowOpen, undefined);
          yield* Fiber.join(firstAcquisitions);

          yield* pool.send(chatId, prompt("first"));
          yield* pool.send(chatId, prompt("second"));
          const envelopes = yield* pool.events.pipe(Stream.take(2), Stream.runCollect);
          assert.deepStrictEqual(
            envelopes.map((envelope) => envelope.event),
            [
              { type: "notice", level: "info", message: "first" },
              { type: "notice", level: "info", message: "second" },
            ],
          );
        }),
      );

      assert.deepStrictEqual(lifecycle, ["begin-dispose", "unsubscribe", "dispose"]);

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-omp-",
      });
      const sessionFile = path.join(sessionsDir, `${chatId}.jsonl`);
      yield* Effect.acquireUseRelease(
        Effect.promise(() =>
          OmpSessionManager.SessionManager.open(sessionFile, sessionsDir, undefined, {
            initialCwd: sessionsDir,
            suppressBreadcrumb: true,
          }),
        ),
        (manager) =>
          Effect.gen(function* () {
            manager.appendMessage({
              role: "user",
              content: "persisted prompt",
              timestamp: 1,
            });
            yield* Effect.promise(() => manager.ensureOnDisk());
            yield* Effect.promise(() => manager.flush());
            const messages = yield* Effect.promise(() =>
              OmpSessionLoader.loadSessionMessagesReadOnly(sessionFile),
            );
            assert.deepStrictEqual(normalizeTranscript(messages), [
              {
                role: "user",
                content: [{ type: "text", text: "persisted prompt" }],
                timestamp: 1,
              },
            ]);
          }),
        (manager) => Effect.promise(() => manager.close()),
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("persists scheduled publications before emitting them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sessionsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-omp-publish-",
        });
        const sessionFile = path.join(sessionsDir, `${chatId}.jsonl`);
        const liveMessages: Array<Parameters<OpenedSession["appendAssistantMessage"]>[0]> = [];
        const publicationOrder: Array<string> = [];
        const factory: SessionFactory = {
          open: () =>
            Effect.promise(async () => {
              const manager = await OmpSessionManager.SessionManager.open(
                sessionFile,
                sessionsDir,
                undefined,
                { initialCwd: sessionsDir, suppressBreadcrumb: true },
              );
              return {
                session: {
                  isStreaming: false,
                  waitForIdle: async () => {},
                  settleInFlightMessagePersistence: () => Promise.resolve(),
                  abort: () => Promise.resolve(),
                  beginDispose: () => manager.seal(),
                  dispose: async () => {
                    await manager.close();
                    manager.releaseRetainedEntries();
                  },
                },
                askBtw: () => Promise.reject(new Error("unexpected side question")),
                sendPrompt: () => Promise.resolve(admitted),
                shake: async (mode) => shakeResult(mode),
                appendAssistantMessage: async (message) => {
                  manager.appendMessage(message);
                  liveMessages.push(message);
                  await manager.flush();
                  publicationOrder.push("persisted");
                },
                contextUsage: () => ({ kind: "unavailable" }),
                unsubscribe: () => {},
              } satisfies OpenedSession;
            }),
        };
        const pool = yield* makeSessionPool({
          factory,
          loadTranscript: () =>
            Effect.promise(() => OmpSessionLoader.loadSessionMessagesReadOnly(sessionFile)).pipe(
              Effect.map(normalizeTranscript),
            ),
        });
        const delivered = yield* pool.events.pipe(
          Stream.take(3),
          Stream.tap(({ event }) =>
            Effect.sync(() => {
              publicationOrder.push(event.type);
            }),
          ),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* pool.publish(chatId, "durable publication");
        const envelopes = yield* Fiber.join(delivered);
        assert.deepStrictEqual(
          envelopes.map(({ event }) => event.type),
          ["run-started", "message-settled", "run-finished"],
        );
        assert.deepStrictEqual(publicationOrder, [
          "persisted",
          "run-started",
          "message-settled",
          "run-finished",
        ]);
        const liveMessage = liveMessages[0];
        if (liveMessage === undefined) return yield* Effect.die("Publication missed live context");
        assert.strictEqual(liveMessage.provider, "pico");
        assert.strictEqual(liveMessage.model, "schedule");
        assert.deepStrictEqual(liveMessage.usage, {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        });

        yield* pool.close(chatId);
        const transcript = yield* pool.transcript(chatId);
        const published = transcript[0];
        if (published === undefined) return yield* Effect.die("Publication missed transcript");
        assert.deepInclude(published, {
          role: "assistant",
          status: "completed",
          stopReason: "stop",
          content: [{ type: "text", text: "durable publication" }],
          model: "schedule",
        });
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("delivers one persisted agent response without appending it again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sessionsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-omp-deliver-",
        });
        const sessionFile = path.join(sessionsDir, `${chatId}.jsonl`);
        const pool = yield* makeSessionPool({
          factory: {
            open: (_requestedChatId, emit) =>
              Effect.promise(async () => {
                const manager = await OmpSessionManager.SessionManager.open(
                  sessionFile,
                  sessionsDir,
                  undefined,
                  { initialCwd: sessionsDir, suppressBreadcrumb: true },
                );
                const assistantMessage: Parameters<OpenedSession["appendAssistantMessage"]>[0] = {
                  role: "assistant",
                  content: [{ type: "text", text: "scheduled answer" }],
                  api: "test",
                  provider: "test",
                  model: "test",
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                  stopReason: "stop",
                  timestamp: 1,
                };
                return {
                  session: {
                    isStreaming: false,
                    waitForIdle: async () => {},
                    settleInFlightMessagePersistence: async () => {
                      await manager.ensureOnDisk();
                      await manager.flush();
                    },
                    abort: () => Promise.resolve(),
                    beginDispose: () => manager.seal(),
                    dispose: async () => {
                      await manager.close();
                      manager.releaseRetainedEntries();
                    },
                  },
                  askBtw: () => Promise.reject(new Error("unexpected side question")),
                  sendPrompt: (_value, onStarted) => {
                    onStarted?.();
                    manager.appendMessage(assistantMessage);
                    emit({ type: "run-started" });
                    emit({
                      type: "message-settled",
                      message: {
                        role: "assistant",
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
                } satisfies OpenedSession;
              }),
          },
          loadTranscript: () =>
            Effect.promise(() => OmpSessionLoader.loadSessionMessagesReadOnly(sessionFile)).pipe(
              Effect.map(normalizeTranscript),
            ),
        });
        const observed: Array<string> = [];
        const delivery = yield* pool.events.pipe(
          Stream.runForEach(({ event }) =>
            Effect.sync(() => {
              observed.push(event.type);
            }),
          ),
          Effect.forkChild,
        );
        const runId = Schedule.ScheduleRunId.make(
          "scheduled-1000-018f47a0-0000-7000-8000-000000000003",
        );

        const captured = yield* pool.sendCaptured(
          chatId,
          runId,
          prompt("scheduled"),
          () => Effect.void,
        );
        assert.strictEqual(captured.finalAssistantText, "scheduled answer");
        yield* pool.deliver(chatId, captured.finalAssistantText);

        yield* pool.drain();
        assert.deepStrictEqual(observed, ["run-started", "message-settled", "run-finished"]);
        yield* Fiber.interrupt(delivery);
        yield* pool.close(chatId);
        const transcript = yield* pool.transcript(chatId);
        assert.strictEqual(transcript.length, 1);
        assert.deepInclude(transcript[0], {
          role: "assistant",
          content: [{ type: "text", text: "scheduled answer" }],
        });
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("acquires idle sessions, reads context, forwards shake, and maps failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shakenModes: Array<ShakeMode> = [];
        let acquisitions = 0;
        let sends = 0;
        let contextReads = 0;
        let throwContext = false;
        let contextValue: ContextUsage = {
          kind: "available",
          contextWindow: 200_000,
          usedTokens: 12_345,
          systemPromptTokens: 1_000,
          systemToolsTokens: 2_000,
          systemContextTokens: 3_000,
          skillsTokens: 4_000,
          messagesTokens: 2_345,
        };
        const factory: SessionFactory = {
          open: () => {
            acquisitions += 1;
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
              sendPrompt: () => {
                sends += 1;
                return Promise.reject(
                  Object.assign(new Error("private provider response"), { code: "EACCES" }),
                );
              },
              shake: (mode) => {
                shakenModes.push(mode);
                return mode === "thinking"
                  ? Promise.reject(new Error("shake rejected"))
                  : Promise.resolve(shakeResult(mode));
              },
              appendAssistantMessage: () => Promise.resolve(),
              contextUsage: () => {
                contextReads += 1;
                if (throwContext) throw new Error("context failed");
                return contextValue;
              },
              unsubscribe: () => {},
            });
          },
        };
        const pool = yield* makeSessionPool({
          factory,
          loadTranscript: () => Effect.succeed([]),
        });

        assert.deepStrictEqual(yield* pool.contextUsage(chatId), {
          kind: "available",
          contextWindow: 200_000,
          usedTokens: 12_345,
          systemPromptTokens: 1_000,
          systemToolsTokens: 2_000,
          systemContextTokens: 3_000,
          skillsTokens: 4_000,
          messagesTokens: 2_345,
        });
        assert.strictEqual(acquisitions, 1);
        assert.strictEqual(sends, 0);
        assert.strictEqual(contextReads, 1);

        assert.deepStrictEqual(yield* pool.shake(chatId, "images"), {
          mode: "images",
          imagesDropped: 3,
          tokensFreed: 0,
        });
        assert.strictEqual(acquisitions, 1);
        assert.strictEqual(sends, 0);
        assert.deepStrictEqual(shakenModes, ["images"]);

        contextValue = { kind: "unavailable" };
        assert.deepStrictEqual(yield* pool.contextUsage(chatId), { kind: "unavailable" });
        assert.strictEqual(acquisitions, 1);
        assert.strictEqual(sends, 0);
        assert.strictEqual(contextReads, 2);

        throwContext = true;
        const contextFailure = yield* pool.contextUsage(chatId).pipe(Effect.flip);
        assert.instanceOf(contextFailure, AgentError);
        assert.strictEqual(acquisitions, 1);
        assert.strictEqual(sends, 0);
        assert.strictEqual(contextReads, 3);

        const sendFailure = yield* pool.send(chatId, prompt("reject")).pipe(Effect.flip);
        assert.instanceOf(sendFailure, AgentError);
        assert.include(sendFailure.message, "EACCES");
        assert.notInclude(sendFailure.message, "private provider response");

        const shakeFailure = yield* pool.shake(chatId, "thinking").pipe(Effect.flip);
        assert.instanceOf(shakeFailure, AgentError);
        assert.strictEqual(acquisitions, 1);
        assert.strictEqual(sends, 1);
        assert.deepStrictEqual(shakenModes, ["images", "thinking"]);
      }),
    ),
  );
  it.effect("closes and evicts an existing session without creating one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle: Array<string> = [];
        let acquisitions = 0;
        const factory: SessionFactory = {
          open: () => {
            acquisitions += 1;
            return Effect.succeed({
              session: {
                isStreaming: false,
                waitForIdle: async () => {},
                settleInFlightMessagePersistence: () => Promise.resolve(),
                abort: () => Promise.resolve(),
                beginDispose: () => {
                  lifecycle.push("begin-dispose");
                },
                dispose: () => {
                  lifecycle.push("dispose");
                  return Promise.resolve();
                },
              },
              askBtw: () => Promise.reject(new Error("unexpected side question")),
              sendPrompt: () => Promise.resolve(admitted),
              shake: async (mode) => shakeResult(mode),
              appendAssistantMessage: () => Promise.resolve(),
              contextUsage: () => ({ kind: "unavailable" }),
              unsubscribe: () => {
                lifecycle.push("unsubscribe");
              },
            });
          },
        };
        const pool = yield* makeSessionPool({
          factory,
          loadTranscript: () => Effect.succeed([]),
        });

        yield* pool.close(chatId);
        assert.strictEqual(acquisitions, 0);
        yield* pool.send(chatId, prompt("open"));
        assert.strictEqual(acquisitions, 1);
        yield* pool.close(chatId);
        assert.deepStrictEqual(lifecycle, ["begin-dispose", "unsubscribe", "dispose"]);
        yield* pool.close(chatId);
        assert.strictEqual(acquisitions, 1);
        assert.deepStrictEqual(lifecycle, ["begin-dispose", "unsubscribe", "dispose"]);
        assert.deepStrictEqual(yield* pool.transcript(chatId), []);
        assert.strictEqual(acquisitions, 1);
      }),
    ),
  );

  it.effect("keeps close failures primary and reports independent cleanup only once", () => {
    const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
    return Effect.gen(function* () {
      for (const unsubscribeFails of [false, true]) {
        records.length = 0;
        let disposeCalls = 0;
        let disposal: Promise<void> | undefined;
        const lifecycle: string[] = [];
        const disposeFailure = new AgentError({ message: "Disposal failed" });
        const unsubscribeFailure = new AgentError({ message: "Subscription cleanup failed" });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const pool = yield* makeSessionPool({
              factory: {
                open: () =>
                  Effect.succeed({
                    session: {
                      isStreaming: false,
                      waitForIdle: async () => {},
                      settleInFlightMessagePersistence: () => Promise.resolve(),
                      abort: () => Promise.resolve(),
                      beginDispose: () => {
                        lifecycle.push("begin-dispose");
                      },
                      dispose: () => {
                        disposeCalls += 1;
                        lifecycle.push("dispose");
                        disposal ??= Promise.reject(disposeFailure);
                        return disposal;
                      },
                    },
                    askBtw: () => Promise.reject(new Error("unexpected side question")),
                    sendPrompt: () => Promise.resolve(admitted),
                    shake: async (mode) => shakeResult(mode),
                    appendAssistantMessage: () => Promise.resolve(),
                    contextUsage: () => ({ kind: "unavailable" }),
                    unsubscribe: () => {
                      lifecycle.push("unsubscribe");
                      if (unsubscribeFails) throw unsubscribeFailure;
                    },
                  }),
              },
              loadTranscript: () => Effect.succeed([]),
            });
            yield* pool.send(chatId, prompt("private prompt"));
            const first = yield* pool.close(chatId).pipe(Effect.flip);
            const second = yield* pool.close(chatId).pipe(Effect.flip);
            assert.strictEqual(first, unsubscribeFails ? unsubscribeFailure : disposeFailure);
            assert.strictEqual(second, first);
          }),
        );
        assert.strictEqual(disposeCalls, 1);
        assert.deepStrictEqual(lifecycle, ["begin-dispose", "unsubscribe", "dispose"]);
        const errors = records.filter((record) => record.level === "ERROR");
        assert.strictEqual(errors.length, unsubscribeFails ? 1 : 0);
        if (unsubscribeFails) {
          assert.strictEqual(errors[0]?.annotations.phase, "dispose");
          assert.strictEqual(errors[0]?.annotations.chatId, chatId);
        }
      }
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => records.push(Logger.formatStructured.log(options))),
        ]),
      ),
    );
  });

  it.effect("does not wait when its output queue is already closed", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const pool = yield* makeSessionPool({
        factory: {
          open: () => Effect.die("unexpected session open"),
        },
        loadTranscript: () => Effect.succeed([]),
      }).pipe(Scope.provide(scope));

      yield* Scope.close(scope, Exit.void);
      yield* pool.drain();
    }),
  );

  it.effect("waits for event consumers at the drain barrier", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const deliveryStarted = yield* Deferred.make<void>();
        const releaseDelivery = yield* Deferred.make<void>();
        const drainCompleted = yield* Deferred.make<void>();
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
                sendPrompt: () => {
                  emit({ type: "notice", level: "info", message: "last" });
                  return Promise.resolve(admitted);
                },
                shake: async (mode) => shakeResult(mode),
                appendAssistantMessage: () => Promise.resolve(),
                contextUsage: () => ({ kind: "unavailable" }),
                unsubscribe: () => {},
              }),
          },
          loadTranscript: () => Effect.succeed([]),
        });
        yield* pool.events.pipe(
          Stream.runForEach(() =>
            Deferred.succeed(deliveryStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDelivery)),
            ),
          ),
          Effect.forkChild,
        );
        yield* pool.send(chatId, prompt("emit"));
        yield* Deferred.await(deliveryStarted);
        yield* pool
          .drain()
          .pipe(Effect.ensuring(Deferred.succeed(drainCompleted, undefined)), Effect.forkChild);
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(drainCompleted));
        yield* Deferred.succeed(releaseDelivery, undefined);
        yield* Deferred.await(drainCompleted);
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
                sendPrompt: (_value, onStarted) => {
                  onStarted?.();
                  emit({ type: "run-started" });
                  emit({
                    type: "message-settled",
                    message: {
                      role: "assistant",
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
          loadTranscript: () => Effect.succeed([]),
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
          loadTranscript: () => Effect.succeed([]),
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
        yield* pool.drain();
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
          loadTranscript: () => Effect.succeed([]),
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
          loadTranscript: () => Effect.succeed([]),
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
            loadTranscript: () => Effect.succeed([]),
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

  it.effect("reports a dead session forwarder once without replaying it during release", () => {
    const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
    const reported = Promise.withResolvers<void>();
    return Effect.scoped(
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
                sendPrompt: async (_value, onStarted) => {
                  onStarted?.();
                  emit({ type: "run-started" });
                  return admitted;
                },
                shake: async (mode) => shakeResult(mode),
                appendAssistantMessage: () => Promise.resolve(),
                contextUsage: () => ({ kind: "unavailable" }),
                unsubscribe: () => {},
              }),
          },
          loadTranscript: () => Effect.succeed([]),
        });
        const capture = yield* pool
          .sendCaptured(
            chatId,
            Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003"),
            prompt("private capture"),
            () => Effect.die(new Error("private sink defect")),
          )
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => reported.promise);
        const failed = yield* Fiber.await(capture);
        assert.isTrue(Exit.isFailure(failed) && Cause.hasDies(failed.cause));
        yield* pool.close(chatId);
        const forwarderErrors = records.filter(
          (record) => record.annotations.operation === "event-forwarder",
        );
        assert.strictEqual(forwarderErrors.length, 1);
        assert.strictEqual(forwarderErrors[0]?.annotations.chatId, chatId);
        assert.notInclude(JSON.stringify(records), "private");
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            const record = Logger.formatStructured.log(options);
            records.push(record);
            if (record.annotations.operation === "event-forwarder") reported.resolve();
          }),
        ]),
      ),
    );
  });
});
