import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as OmpSessionManager from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as Agent from "@pico/contract/agent-message";
import type { ContextUsage, ShakeMode, ShakeResult } from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { normalizeAgentEvent, normalizeTranscript } from "./agent-event.ts";
import { makeSessionPool, type SessionFactory } from "./session-pool.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001");
const prompt = Agent.AgentPrompt.make;

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
              sendPrompt: (value) => {
                if (value !== "acquire") {
                  emit({ type: "notice", level: "info", message: value });
                }
                return Promise.resolve();
              },
              shake: async (mode) => shakeResult(mode),
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
                settleInFlightMessagePersistence: () => Promise.resolve(),
                abort: () => Promise.resolve(),
                beginDispose: () => {},
                dispose: () => Promise.resolve(),
              },
              sendPrompt: () => {
                sends += 1;
                return Promise.reject(new Error("sender rejected"));
              },
              shake: (mode) => {
                shakenModes.push(mode);
                return mode === "thinking"
                  ? Promise.reject(new Error("shake rejected"))
                  : Promise.resolve(shakeResult(mode));
              },
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
        assert.strictEqual(contextFailure.message, "Failed to read OMP context");
        assert.strictEqual(acquisitions, 1);
        assert.strictEqual(sends, 0);
        assert.strictEqual(contextReads, 3);

        const sendFailure = yield* pool.send(chatId, prompt("reject")).pipe(Effect.flip);
        assert.instanceOf(sendFailure, AgentError);
        assert.strictEqual(sendFailure.message, "Failed to send OMP prompt");

        const shakeFailure = yield* pool.shake(chatId, "thinking").pipe(Effect.flip);
        assert.instanceOf(shakeFailure, AgentError);
        assert.strictEqual(shakeFailure.message, "Failed to shake OMP session");
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
              sendPrompt: () => Promise.resolve(),
              shake: async (mode) => shakeResult(mode),
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

  it.effect("surfaces a disposal failure without retrying the terminal session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let disposeCalls = 0;
        let disposal: Promise<void> | undefined;
        const pool = yield* makeSessionPool({
          factory: {
            open: () =>
              Effect.succeed({
                session: {
                  settleInFlightMessagePersistence: () => Promise.resolve(),
                  abort: () => Promise.resolve(),
                  beginDispose: () => {},
                  dispose: () => {
                    disposeCalls += 1;
                    disposal ??= Promise.reject(new Error("dispose failed"));
                    return disposal;
                  },
                },
                sendPrompt: () => Promise.resolve(),
                shake: async (mode) => shakeResult(mode),
                contextUsage: () => ({ kind: "unavailable" }),
                unsubscribe: () => {},
              }),
          },
          loadTranscript: () => Effect.succeed([]),
        });

        yield* pool.send(chatId, prompt("open"));
        const first = yield* pool.close(chatId).pipe(Effect.flip);
        const second = yield* pool.close(chatId).pipe(Effect.flip);
        assert.instanceOf(first, AgentError);
        assert.strictEqual(first.message, "Failed to dispose OMP session");
        assert.strictEqual(second, first);
        assert.strictEqual(disposeCalls, 1);
      }),
    ),
  );

  it.effect("continues teardown after an unsubscribe failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle: Array<string> = [];
        const pool = yield* makeSessionPool({
          factory: {
            open: () =>
              Effect.succeed({
                session: {
                  settleInFlightMessagePersistence: () => Promise.resolve(),
                  abort: () => Promise.resolve(),
                  beginDispose: () => {
                    lifecycle.push("begin-dispose");
                  },
                  dispose: () => {
                    lifecycle.push("dispose");
                    return Promise.reject(new Error("dispose failed"));
                  },
                },
                sendPrompt: () => Promise.resolve(),
                shake: async (mode) => shakeResult(mode),
                contextUsage: () => ({ kind: "unavailable" }),
                unsubscribe: () => {
                  lifecycle.push("unsubscribe");
                  throw new Error("unsubscribe failed");
                },
              }),
          },
          loadTranscript: () => Effect.succeed([]),
        });

        yield* pool.send(chatId, prompt("open"));
        const error = yield* pool.close(chatId).pipe(Effect.flip);
        assert.instanceOf(error, AgentError);
        assert.strictEqual(error.message, "Failed to unsubscribe from OMP session events");
        assert.deepStrictEqual(lifecycle, ["begin-dispose", "unsubscribe", "dispose"]);
      }),
    ),
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
                  settleInFlightMessagePersistence: () => Promise.resolve(),
                  abort: () => Promise.resolve(),
                  beginDispose: () => {},
                  dispose: () => Promise.resolve(),
                },
                sendPrompt: () => {
                  emit({ type: "notice", level: "info", message: "last" });
                  return Promise.resolve();
                },
                shake: async (mode) => shakeResult(mode),
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
});
