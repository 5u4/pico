import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as OmpSessionManager from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type * as AgentEvent from "@pico/contract/agent-event";
import { HistoryRevision } from "@pico/contract/agent-history";
import * as Agent from "@pico/contract/agent-message";
import type { MessageDelivery, ShakeMode, ShakeResult } from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import * as Schedule from "@pico/contract/schedule";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { normalizeMessage, normalizeTodo, normalizeTranscript } from "./agent-event.ts";
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
  it.effect(
    "includes delivery settlements received during a snapshot without resetting a live run",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const observing = yield* Deferred.make<void>();
          const finishRead = yield* Deferred.make<void>();
          const opened = yield* Deferred.make<Parameters<SessionFactory["open"]>[1]>();
          let messages: ReadonlyArray<Agent.AgentMessage> = [];
          let reads = 0;
          const pool = yield* makeSessionPool({
            factory: {
              open: (_id, emit) =>
                Effect.sync(() => {
                  Deferred.doneUnsafe(opened, Effect.succeed(emit));
                  return {
                    session: {
                      isStreaming: false,
                      waitForIdle: async () => {},
                      settleInFlightMessagePersistence: async () => {},
                      abort: async () => {},
                      beginDispose: () => {},
                      dispose: async () => {},
                    },
                    sendPrompt: () => Promise.reject(new Error("Unexpected prompt")),
                    askBtw: () => Promise.reject(new Error("Unexpected side question")),
                    shake: () => Promise.reject(new Error("Unexpected shake")),
                    switchModel: () => Promise.reject(new Error("Unexpected model switch")),
                    appendAssistantMessage: () =>
                      Promise.reject(new Error("Delivery must not append")),
                    flush: async () => {},
                    navigateHistory: () =>
                      Promise.reject(new Error("unexpected history navigation")),
                    historyBoundary: () => JSON.stringify(messages),
                    settleHistory: async () => {},
                    contextUsage: () => ({ kind: "unavailable" }),
                    currentModel: () => null,
                    unsubscribe: () => {},
                    availableSkills: () => [],
                  } satisfies OpenedSession;
                }),
            },
            loadHistory: () => Effect.die("unexpected history read"),
            loadHistoryPreview: () => Effect.die("unexpected history preview"),
            loadCurrentModel: () => Effect.succeed(null),
            loadResultSummary: (_chatId, _seen) =>
              Effect.succeed({ kind: "ready", latest: null, relation: "none" }),
            loadTranscript: () =>
              Effect.gen(function* () {
                const current = messages;
                if (reads++ === 0) {
                  yield* Deferred.succeed(observing, undefined);
                  yield* Deferred.await(finishRead);
                }
                return {
                  historyRevision: HistoryRevision.make("test-history"),
                  messages: current,
                  todo: { kind: "ready", phases: [] },
                };
              }),
          });
          const envelopes: AgentEvent.AgentEventEnvelope[] = [];
          yield* pool.events.pipe(
            Stream.runForEach((event) => Effect.sync(() => envelopes.push(event))),
            Effect.forkChild,
          );
          yield* pool.contextUsage(chatId);
          const emit = yield* Deferred.await(opened);
          const prefix = {
            type: "text-delta",
            messageId: Agent.AgentMessageId.make("active-assistant"),
            contentIndex: 0,
            text: "Already streaming",
          } satisfies AgentEvent.AgentEvent;
          const tool = {
            type: "tool-started",
            toolCallId: "active-tool",
            toolName: "read",
            argumentsJson: '{"path":"source.ts"}',
          } satisfies AgentEvent.AgentEvent;
          emit(prefix);
          emit(tool);
          emit({ type: "run-started" });
          const reading = yield* pool.transcript(chatId).pipe(Effect.forkChild);
          yield* Deferred.await(observing);
          const delivery = {
            role: "assistant",
            id: Agent.AgentMessageId.make("delivered-assistant"),
            status: "completed",
            stopReason: "stop",
            content: [{ type: "text", text: "Delivered beside the main answer" }],
            model: "test",
            timestamp: 1,
          } satisfies Agent.AgentAssistantMessage;
          yield* pool.deliver(chatId, delivery);
          yield* pool.drain();
          yield* Deferred.succeed(finishRead, undefined);
          const snapshot = yield* Fiber.join(reading);
          const draft = {
            kind: "draft",
            messageId: prefix.messageId,
            blocks: [prefix],
          } satisfies (typeof snapshot.runtime.assistant)[number];
          assert.deepStrictEqual(snapshot.messages, []);
          assert.deepStrictEqual(snapshot.runtime.run, { kind: "running" });
          assert.deepStrictEqual(snapshot.runtime.assistant, [
            draft,
            { kind: "settled", message: delivery },
          ]);
          assert.deepStrictEqual(snapshot.runtime.tools, [{ kind: "running", start: tool }]);
          assert.strictEqual(snapshot.runtime.publication, envelopes.at(-1)?.publication);

          messages = [delivery];
          const acknowledged = yield* pool.transcript(chatId);
          assert.deepStrictEqual(acknowledged.messages, [delivery]);
          assert.deepStrictEqual(acknowledged.runtime.assistant, [draft]);
          yield* pool.deliver(chatId, {
            ...delivery,
            id: Agent.AgentMessageId.make("unpersisted-delivery"),
          });
          yield* pool.close(chatId);
          const evicted = yield* pool.transcript(chatId);
          assert.deepStrictEqual(evicted.messages, [delivery]);
          assert.deepStrictEqual(evicted.runtime.run, { kind: "idle" });
          assert.deepStrictEqual(evicted.runtime.assistant, []);
          assert.deepStrictEqual(evicted.runtime.tools, []);
        }),
      ),
  );

  it.effect(
    "persists local-only scheduled publications and still notifies transcript subscribers",
    () =>
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
                  navigateHistory: () => Promise.reject(new Error("unexpected history navigation")),
                  historyBoundary: () => JSON.stringify(manager.getEntries()),
                  settleHistory: () => manager.flush(),
                  sendPrompt: () => Promise.resolve(admitted),
                  shake: async (mode) => shakeResult(mode),
                  appendAssistantMessage: async (message) => {
                    manager.appendMessage(message);
                    liveMessages.push(message);
                    await manager.flush();
                    publicationOrder.push("persisted");
                  },
                  currentModel: () => null,
                  contextUsage: () => ({ kind: "unavailable" }),
                  unsubscribe: () => {},
                  availableSkills: () => [],
                } satisfies OpenedSession;
              }),
          };
          const pool = yield* makeSessionPool({
            factory,
            loadHistory: () => Effect.die("unexpected history read"),
            loadHistoryPreview: () => Effect.die("unexpected history preview"),
            loadCurrentModel: () => Effect.succeed(null),
            loadResultSummary: (_chatId, _seen) =>
              Effect.succeed({ kind: "ready", latest: null, relation: "none" }),
            loadTranscript: () =>
              Effect.promise(() => OmpSessionLoader.loadSessionSnapshotReadOnly(sessionFile)).pipe(
                Effect.map((snapshot) => ({
                  messages: normalizeTranscript(snapshot.messages),
                  historyRevision: HistoryRevision.make(snapshot.historyRevision),
                  todo: normalizeTodo(snapshot.todoPhases),
                })),
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

          yield* pool.publish(chatId, "durable publication", true);
          const envelopes = yield* Fiber.join(delivered);
          assert.deepStrictEqual(
            envelopes.map(({ event }) => event.type),
            ["run-started", "message-settled", "run-finished"],
          );
          assert.isTrue(envelopes.every((envelope) => envelope.localOnly === true));
          assert.deepStrictEqual(publicationOrder, [
            "persisted",
            "run-started",
            "message-settled",
            "run-finished",
          ]);
          const liveMessage = liveMessages[0];
          if (liveMessage === undefined)
            return yield* Effect.die("Publication missed live context");

          yield* pool.close(chatId);
          const { messages: transcript } = yield* pool.transcript(chatId);
          const published = transcript[0];
          if (published === undefined) return yield* Effect.die("Publication missed transcript");
          assert.deepInclude(published, {
            role: "assistant",
            status: "completed",
            stopReason: "stop",
            content: [{ type: "text", text: "durable publication" }],
            model: "pico/schedule",
          });
          const settlement = envelopes.find(({ event }) => event.type === "message-settled");
          assert.strictEqual(settlement?.event.type, "message-settled");
          if (settlement?.event.type !== "message-settled") return;
          assert.deepStrictEqual(settlement.event.message, published);
          assert.deepStrictEqual(normalizeMessage(liveMessage), published);
        }),
      ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("preserves assistant tool-call structure before its result is persisted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-pending-tool-snapshot-",
        });
        const sessionFile = path.join(directory, "session.jsonl");
        const manager = yield* Effect.acquireRelease(
          Effect.promise(() =>
            OmpSessionManager.SessionManager.open(sessionFile, directory, undefined, {
              initialCwd: directory,
              suppressBreadcrumb: true,
            }),
          ),
          (manager) => Effect.promise(() => manager.close()),
        );
        const assistantMessage: Parameters<OpenedSession["appendAssistantMessage"]>[0] & {
          messageId: string;
        } = {
          role: "assistant",
          messageId: "in-flight-assistant",
          content: [
            { type: "thinking", thinking: "Checking the source" },
            { type: "toolCall", id: "pending-read", name: "read", arguments: { path: "file.ts" } },
            { type: "text", text: "Waiting for the source" },
          ],
          api: "test",
          provider: "test",
          model: "test",
          stopReason: "toolUse",
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
        manager.appendMessage(assistantMessage);
        yield* Effect.promise(() => manager.ensureOnDisk());
        yield* Effect.promise(() => manager.flush());
        const beforeResult = normalizeTranscript(
          yield* Effect.promise(() => OmpSessionLoader.loadSessionMessagesReadOnly(sessionFile)),
        );
        assert.deepStrictEqual(beforeResult, [
          {
            role: "assistant",
            id: Agent.AgentMessageId.make("in-flight-assistant"),
            status: "completed",
            stopReason: "tool-use",
            content: [
              { type: "thinking", text: "Checking the source" },
              {
                type: "tool-call",
                id: "pending-read",
                name: "read",
                argumentsJson: '{"path":"file.ts"}',
              },
              { type: "text", text: "Waiting for the source" },
            ],
            model: "test",
            timestamp: 1,
          },
        ]);
        manager.appendMessage({
          role: "toolResult",
          toolCallId: "pending-read",
          toolName: "read",
          content: [{ type: "text", text: "Source contents" }],
          isError: false,
          timestamp: 2,
        });
        yield* Effect.promise(() => manager.flush());
        const afterResult = normalizeTranscript(
          yield* Effect.promise(() => OmpSessionLoader.loadSessionMessagesReadOnly(sessionFile)),
        );
        assert.deepStrictEqual(afterResult[0], beforeResult[0]);
        assert.deepStrictEqual(afterResult[1], {
          role: "tool-result",
          toolCallId: "pending-read",
          toolName: "read",
          content: [{ type: "text", text: "Source contents" }],
          status: "succeeded",
          timestamp: 2,
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
                const assistantMessage: Parameters<OpenedSession["appendAssistantMessage"]>[0] & {
                  messageId: string;
                } = {
                  role: "assistant",
                  messageId: "scheduled-answer",
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
                  navigateHistory: () => Promise.reject(new Error("unexpected history navigation")),
                  historyBoundary: () => JSON.stringify(manager.getEntries()),
                  settleHistory: () => manager.flush(),
                  sendPrompt: (_value, onStarted) => {
                    onStarted?.();
                    manager.appendMessage(assistantMessage);
                    emit({ type: "run-started" });
                    emit({
                      type: "message-settled",
                      message: normalizeMessage(assistantMessage),
                    });
                    emit({ type: "run-finished", outcome: "completed" });
                    return Promise.resolve(admitted);
                  },
                  shake: async (mode) => shakeResult(mode),
                  appendAssistantMessage: () => Promise.resolve(),
                  currentModel: () => null,
                  contextUsage: () => ({ kind: "unavailable" }),
                  unsubscribe: () => {},
                  availableSkills: () => [],
                } satisfies OpenedSession;
              }),
          },
          loadHistory: () => Effect.die("unexpected history read"),
          loadHistoryPreview: () => Effect.die("unexpected history preview"),
          loadCurrentModel: () => Effect.succeed(null),
          loadResultSummary: (_chatId, _seen) =>
            Effect.succeed({ kind: "ready", latest: null, relation: "none" }),
          loadTranscript: () =>
            Effect.promise(() => OmpSessionLoader.loadSessionSnapshotReadOnly(sessionFile)).pipe(
              Effect.map((snapshot) => ({
                messages: normalizeTranscript(snapshot.messages),
                historyRevision: HistoryRevision.make(snapshot.historyRevision),
                todo: normalizeTodo(snapshot.todoPhases),
              })),
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
        const settled = captured.events.find((event) => event.type === "message-settled");
        if (settled?.type !== "message-settled" || settled.message.role !== "assistant") {
          return yield* Effect.die("Capture missed assistant settlement");
        }
        yield* pool.deliver(chatId, settled.message);

        yield* pool.drain();
        assert.deepStrictEqual(observed, ["run-started", "message-settled", "run-finished"]);
        yield* Fiber.interrupt(delivery);
        yield* pool.close(chatId);
        const { messages: transcript } = yield* pool.transcript(chatId);
        assert.strictEqual(transcript.length, 1);
        assert.deepStrictEqual(transcript[0], settled.message);
        assert.deepInclude(transcript[0], {
          role: "assistant",
          content: [{ type: "text", text: "scheduled answer" }],
        });
      }),
    ).pipe(Effect.provide(platformLayer)),
  );
});
