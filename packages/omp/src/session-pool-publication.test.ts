import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as OmpSessionManager from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as Agent from "@pico/contract/agent-message";
import type { MessageDelivery, ShakeMode, ShakeResult } from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import * as Schedule from "@pico/contract/schedule";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { normalizeTranscript } from "./agent-event.ts";
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

describe("session pool publication", () => {
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
                switchModel: () => Promise.reject(new Error("unexpected model switch")),
                flush: async () => {
                  await manager.ensureOnDisk();
                  await manager.flush();
                },
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
                  switchModel: () => Promise.reject(new Error("unexpected model switch")),
                  flush: async () => {
                    await manager.ensureOnDisk();
                    await manager.flush();
                  },
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
});
