import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as OmpSessionManager from "@oh-my-pi/pi-coding-agent/session/session-manager";
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
import { makeSessionPool, type SessionFactory } from "./session-pool.ts";

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
              switchModel: () => Promise.reject(new Error("unexpected model switch")),
              flush: () => Promise.resolve(),
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
                  switchModel: () => Promise.reject(new Error("unexpected model switch")),
                  flush: () => Promise.resolve(),
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

  it("invalidates context snapshots after model and compaction changes", () => {
    assert.deepStrictEqual(normalizeAgentEvent({ type: "model_changed" }), {
      type: "context-invalidated",
    });
    assert.deepStrictEqual(
      normalizeAgentEvent({
        type: "auto_compaction_end",
        action: "context-full",
        result: undefined,
        aborted: false,
        willRetry: false,
      }),
      { type: "context-invalidated" },
    );
  });

  it.effect("keeps legacy assistant identity across read-only loads and writable migrations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-identity-" });
        const timestamp = "2026-01-01T00:00:00.000Z";
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "Same legacy answer" }],
          api: "test",
          provider: "test",
          model: "test",
          stopReason: "stop",
          timestamp: 1,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        for (const version of [1, 3]) {
          const sessionId = `legacy-session-${version}`;
          const sessionFile = path.join(directory, `${sessionId}.jsonl`);
          const entries = [
            { type: "session", version, id: sessionId, timestamp, cwd: directory },
            ...["first", "second", "third"].map((id, index, ids) => ({
              type: "message",
              ...(version === 1 ? {} : { id, parentId: ids[index - 1] ?? null }),
              timestamp,
              message: index === 2 ? { ...message, messageId: "retained-sdk-id" } : message,
            })),
          ];
          const journal = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
          yield* fileSystem.writeFileString(sessionFile, journal);
          const first = normalizeTranscript(
            yield* Effect.promise(() => OmpSessionLoader.loadSessionMessagesReadOnly(sessionFile)),
          );
          const second = normalizeTranscript(
            yield* Effect.promise(() => OmpSessionLoader.loadSessionMessagesReadOnly(sessionFile)),
          );
          assert.deepStrictEqual(first, second);
          assert.deepStrictEqual(
            first.flatMap((entry) => (entry.role === "assistant" ? [entry.id] : [])),
            [
              `legacy:${sessionId}:${version === 1 ? "entry:1" : "first"}`,
              `legacy:${sessionId}:${version === 1 ? "entry:2" : "second"}`,
              "retained-sdk-id",
            ],
          );
          assert.strictEqual(yield* fileSystem.readFileString(sessionFile), journal);
          yield* Effect.acquireUseRelease(
            Effect.promise(() =>
              OmpSessionManager.SessionManager.open(sessionFile, directory, undefined, {
                initialCwd: directory,
                suppressBreadcrumb: true,
              }),
            ),
            (manager) =>
              Effect.promise(async () => {
                await manager.ensureOnDisk();
                await manager.flush();
              }),
            (manager) => Effect.promise(() => manager.close()),
          );
          const resumed = normalizeTranscript(
            yield* Effect.promise(() => OmpSessionLoader.loadSessionMessagesReadOnly(sessionFile)),
          );
          assert.deepStrictEqual(resumed, first);
        }
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

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
              switchModel: () => Promise.reject(new Error("unexpected model switch")),
              flush: () => Promise.resolve(),
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

  it.effect("acquires idle sessions, reads context, forwards shake, and maps failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shakenModes: Array<ShakeMode> = [];
        let acquisitions = 0;
        let sends = 0;
        let contextReads = 0;
        let throwContext = false;
        let transcriptFailure: AgentError | undefined;
        let persistenceFailure: AgentError | undefined;
        const messages: Agent.AgentTranscript = [
          {
            role: "user",
            content: [{ type: "text", text: "Keep this history readable." }],
            timestamp: 1,
          },
        ];
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
                settleInFlightMessagePersistence: () =>
                  persistenceFailure === undefined
                    ? Promise.resolve()
                    : Promise.reject(persistenceFailure),
                abort: () => Promise.resolve(),
                beginDispose: () => {},
                dispose: () => Promise.resolve(),
              },
              askBtw: () => Promise.reject(new Error("unexpected side question")),
              switchModel: () => Promise.reject(new Error("unexpected model switch")),
              flush: () => Promise.resolve(),
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
          loadTranscript: () =>
            transcriptFailure === undefined
              ? Effect.succeed(messages)
              : Effect.fail(transcriptFailure),
        });

        assert.deepStrictEqual(yield* pool.transcript(chatId), {
          messages,
          contextUsage: { kind: "unavailable" },
        });
        assert.strictEqual(acquisitions, 0);
        assert.strictEqual(contextReads, 0);

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
        contextValue = { ...contextValue, usedTokens: 6_000 };
        assert.deepStrictEqual((yield* pool.transcript(chatId)).contextUsage, contextValue);

        const contextChanged = yield* pool.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        assert.deepStrictEqual(yield* pool.shake(chatId, "images"), {
          mode: "images",
          imagesDropped: 3,
          tokensFreed: 0,
        });
        assert.deepStrictEqual(yield* Fiber.join(contextChanged), [
          { chatId, event: { type: "context-invalidated" } },
        ]);
        assert.strictEqual(acquisitions, 1);
        assert.strictEqual(sends, 0);
        assert.deepStrictEqual(shakenModes, ["images"]);

        contextValue = { kind: "unavailable" };
        assert.deepStrictEqual(yield* pool.contextUsage(chatId), { kind: "unavailable" });
        assert.strictEqual(acquisitions, 1);
        assert.strictEqual(sends, 0);
        assert.strictEqual(contextReads, 3);

        throwContext = true;
        const contextFailure = yield* pool.contextUsage(chatId).pipe(Effect.flip);
        assert.instanceOf(contextFailure, AgentError);
        assert.strictEqual(acquisitions, 1);
        assert.strictEqual(sends, 0);
        assert.strictEqual(contextReads, 4);
        assert.deepStrictEqual(yield* pool.transcript(chatId), {
          messages,
          contextUsage: { kind: "error" },
        });

        transcriptFailure = new AgentError({ message: "History read failed" });
        assert.strictEqual(yield* pool.transcript(chatId).pipe(Effect.flip), transcriptFailure);
        transcriptFailure = undefined;

        persistenceFailure = new AgentError({ message: "History persistence failed" });
        assert.strictEqual(yield* pool.transcript(chatId).pipe(Effect.flip), persistenceFailure);
        persistenceFailure = undefined;

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
              switchModel: () => Promise.reject(new Error("unexpected model switch")),
              flush: () => Promise.resolve(),
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
        assert.deepStrictEqual(yield* pool.transcript(chatId), {
          messages: [],
          contextUsage: { kind: "unavailable" },
        });
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
                    switchModel: () => Promise.reject(new Error("unexpected model switch")),
                    flush: () => Promise.resolve(),
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
                switchModel: () => Promise.reject(new Error("unexpected model switch")),
                flush: () => Promise.resolve(),
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
                switchModel: () => Promise.reject(new Error("unexpected model switch")),
                flush: () => Promise.resolve(),
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
