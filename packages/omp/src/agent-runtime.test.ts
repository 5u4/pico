import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as OmpSessionManager from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentEvent, Publication } from "@pico/contract/agent-event";
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
import * as TestClock from "effect/testing/TestClock";
import { normalizeAgentEvent, normalizeTodo, normalizeTranscript } from "./agent-event.ts";
import { makeSessionPool, type SessionFactory } from "./session-pool.ts";

type CustomMessage = Extract<
  Parameters<typeof normalizeTranscript>[0][number],
  { readonly role: "custom" }
>;

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
              historyBoundary: () => "stable",
              settleHistory: () => Promise.resolve(),
              sendPrompt: async (): Promise<MessageDelivery> => ({
                kind: "steered",
                consumed: Deferred.await(nativeConsumption),
                completed: Effect.never,
              }),
              shake: async (mode) => shakeResult(mode),
              currentModel: () => null,
              contextUsage: () => ({ kind: "unavailable" }),
              availableSkills: () => [],
              appendAssistantMessage: async () => {},
              unsubscribe: () => {},
            }),
        },
        loadCurrentModel: () => Effect.succeed(null),
        loadTranscript: () => Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
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
                  historyBoundary: () => "stable",
                  settleHistory: () => Promise.resolve(),
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
                  currentModel: () => null,
                  contextUsage: () => ({ kind: "unavailable" }),
                  availableSkills: () => [],
                  appendAssistantMessage: async () => {},
                  unsubscribe: () => {},
                }),
            },
            loadCurrentModel: () => Effect.succeed(null),
            loadTranscript: () =>
              Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
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

  it("preserves original skill prompts in events and transcripts", () => {
    const prompt =
      "Inspect this change with /skill:review and keep  both spaces.\n\n  Keep the indentation.";
    const message: CustomMessage = {
      role: "custom",
      customType: "skill-prompt",
      attribution: "user",
      display: true,
      content: "Expanded skill instructions that must stay internal.",
      details: { prompt, __queueChipText: "/skill:review queued label" },
      timestamp: 42,
    };
    const expected = {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: 42,
    } satisfies Agent.AgentUserMessage;
    assert.deepStrictEqual(normalizeAgentEvent({ type: "message_end", message }), {
      type: "message-settled",
      message: expected,
    });
    assert.deepStrictEqual(normalizeTranscript([{ ...message, details: { prompt } }]), [expected]);
  });

  it("does not expose other custom messages or skills without a visible user prompt", () => {
    const message: CustomMessage = {
      role: "custom",
      customType: "skill-prompt",
      attribution: "user",
      display: true,
      content: "Expanded skill instructions that must stay internal.",
      details: { prompt: "/skill:review Inspect this change." },
      timestamp: 42,
    };
    const excluded: CustomMessage[] = [
      { ...message, customType: "extension-note" },
      { ...message, attribution: "agent" },
      { ...message, display: false },
      { ...message, details: undefined },
      { ...message, details: null },
      { ...message, details: { name: "review", args: "Legacy request" } },
      { ...message, details: { prompt: 42 } },
    ];
    assert.deepStrictEqual(normalizeTranscript(excluded), []);
    for (const message of excluded) {
      assert.isUndefined(normalizeAgentEvent({ type: "message_end", message }));
    }
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

  it.effect(
    "selects canonical todos on the persisted path before compaction and respects clear",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-todos-" });
          const file = path.join(directory, "session.jsonl");
          yield* Effect.acquireUseRelease(
            Effect.promise(() =>
              OmpSessionManager.SessionManager.open(file, directory, undefined, {
                initialCwd: directory,
                suppressBreadcrumb: true,
              }),
            ),
            (manager) =>
              Effect.promise(async () => {
                const initial = [
                  { name: "Build", tasks: [{ content: "Ship", status: "in_progress" }] },
                ];
                const edited = [
                  {
                    name: "Build",
                    tasks: [{ content: "Ship", status: "blocked" as const, blocker: "Review" }],
                  },
                ];
                const root = manager.appendMessage({
                  role: "user",
                  content: "Start",
                  timestamp: 1,
                });
                const appendTodo = (phases: unknown, op?: string, isError = false) =>
                  manager.appendMessage({
                    role: "toolResult",
                    toolCallId: `todo-${manager.getLeafId()}`,
                    toolName: "todo",
                    content: [{ type: "text", text: "Todo result" }],
                    details: { phases, op, storage: "session" },
                    isError,
                    timestamp: 2,
                  });
                const readSnapshot = async () => {
                  await manager.ensureOnDisk();
                  await manager.flush();
                  return OmpSessionLoader.loadSessionSnapshotReadOnly(file);
                };
                appendTodo(initial, "init");
                assert.deepStrictEqual((await readSnapshot()).todoPhases, initial);
                manager.appendCustomEntry("user_todo_edit", { phases: edited });
                appendTodo([], "view");
                appendTodo([], "done", true);
                assert.deepStrictEqual((await readSnapshot()).todoPhases, edited);

                const kept = manager.appendMessage({
                  role: "user",
                  content: "Continue",
                  timestamp: 3,
                });
                manager.appendCompaction("Earlier work", undefined, kept, 100);
                const compacted = await readSnapshot();
                assert.deepStrictEqual(compacted.todoPhases, edited);
                assert.deepStrictEqual(normalizeTranscript(compacted.messages), [
                  { role: "user", content: [{ type: "text", text: "Continue" }], timestamp: 3 },
                ]);

                manager.appendCustomEntry("user_todo_edit", { phases: [] });
                assert.deepStrictEqual(normalizeTodo((await readSnapshot()).todoPhases), {
                  kind: "ready",
                  phases: [],
                });
                manager.branch(root);
                manager.appendMessage({ role: "user", content: "Other branch", timestamp: 4 });
                assert.deepStrictEqual((await readSnapshot()).todoPhases, []);
                appendTodo(initial);
                assert.deepStrictEqual((await readSnapshot()).todoPhases, initial);
                appendTodo([], "init");
                assert.deepStrictEqual((await readSnapshot()).todoPhases, []);
              }),
            (manager) => Effect.promise(() => manager.close()),
          );
        }),
      ).pipe(Effect.provide(platformLayer)),
  );

  it.effect("keeps ordinary messages when the latest canonical todo snapshot is malformed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-invalid-todos-",
        });
        const file = path.join(directory, "session.jsonl");
        yield* Effect.acquireUseRelease(
          Effect.promise(() =>
            OmpSessionManager.SessionManager.open(file, directory, undefined, {
              initialCwd: directory,
              suppressBreadcrumb: true,
            }),
          ),
          (manager) =>
            Effect.promise(async () => {
              manager.appendMessage({ role: "user", content: "Keep this", timestamp: 1 });
              manager.appendCustomEntry("user_todo_edit", {
                phases: [{ name: "Old", tasks: [{ content: "Old task", status: "completed" }] }],
              });
              for (const phases of [
                [{ name: "Bad", tasks: null }],
                [{ name: "Bad", tasks: [{ content: "Task", status: "future-status" }] }],
                [{ name: "Bad", tasks: [{ content: "Task", status: "blocked", blocker: 42 }] }],
              ]) {
                manager.appendCustomEntry("user_todo_edit", { phases });
                await manager.ensureOnDisk();
                await manager.flush();
                const snapshot = await OmpSessionLoader.loadSessionSnapshotReadOnly(file);
                assert.deepStrictEqual(normalizeTodo(snapshot.todoPhases), { kind: "unavailable" });
                assert.deepStrictEqual(normalizeTranscript(snapshot.messages), [
                  { role: "user", content: [{ type: "text", text: "Keep this" }], timestamp: 1 },
                ]);
              }
            }),
          (manager) => Effect.promise(() => manager.close()),
        );
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
              historyBoundary: () => "stable",
              settleHistory: () => Promise.resolve(),
              sendPrompt: (value) => {
                if (value.text !== "acquire") {
                  emit({ type: "notice", level: "info", message: value.text });
                }
                return Promise.resolve(admitted);
              },
              shake: async (mode) => shakeResult(mode),
              appendAssistantMessage: () => Promise.resolve(),
              currentModel: () => null,
              contextUsage: () => ({ kind: "unavailable" }),
              availableSkills: () => [],
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
            loadCurrentModel: () => Effect.succeed(null),
            loadTranscript: () =>
              Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
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
              historyBoundary: () => "stable",
              settleHistory: () =>
                persistenceFailure === undefined
                  ? Promise.resolve()
                  : Promise.reject(persistenceFailure),
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
              currentModel: () => null,
              availableSkills: () => [],
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
          loadCurrentModel: () => Effect.succeed(null),
          loadTranscript: () =>
            transcriptFailure === undefined
              ? Effect.succeed({ messages, todo: { kind: "ready", phases: [] } })
              : Effect.fail(transcriptFailure),
        });

        assert.deepStrictEqual(yield* pool.transcript(chatId), {
          messages,
          todo: { kind: "ready", phases: [] },
          currentModel: null,
          contextUsage: { kind: "unavailable" },
          runtime: {
            publication: Publication.make(0),
            run: { kind: "idle" },
            assistant: [],
            tools: [],
          },
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
        assert.deepStrictEqual(
          (yield* Fiber.join(contextChanged)).map(({ event }) => event),
          [{ type: "context-invalidated" }],
        );
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
          todo: { kind: "ready", phases: [] },
          currentModel: null,
          contextUsage: { kind: "error" },
          runtime: {
            publication: Publication.make(1),
            run: { kind: "idle" },
            assistant: [],
            tools: [],
          },
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

  it.effect("reacquires context sessions after the ten minute eviction window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let acquisitions = 0;
        const pool = yield* makeSessionPool({
          factory: {
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
                switchModel: () => Promise.reject(new Error("unexpected model switch")),
                flush: () => Promise.resolve(),
                historyBoundary: () => "stable",
                settleHistory: () => Promise.resolve(),
                sendPrompt: () => Promise.resolve(admitted),
                shake: async (mode) => shakeResult(mode),
                appendAssistantMessage: () => Promise.resolve(),
                currentModel: () => null,
                contextUsage: () => ({ kind: "unavailable" }),
                availableSkills: () => [],
                unsubscribe: () => {},
              });
            },
          },
          loadCurrentModel: () => Effect.succeed(null),
          loadTranscript: () =>
            Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
        });

        yield* pool.contextUsage(chatId);
        assert.strictEqual(acquisitions, 1);

        yield* TestClock.adjust("10 minutes");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 millis");

        yield* pool.contextUsage(chatId);
        assert.strictEqual(acquisitions, 2);
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
              historyBoundary: () => "stable",
              settleHistory: () => Promise.resolve(),
              sendPrompt: () => Promise.resolve(admitted),
              shake: async (mode) => shakeResult(mode),
              appendAssistantMessage: () => Promise.resolve(),
              currentModel: () => null,
              contextUsage: () => ({ kind: "unavailable" }),
              availableSkills: () => [],
              unsubscribe: () => {
                lifecycle.push("unsubscribe");
              },
            });
          },
        };
        const pool = yield* makeSessionPool({
          factory,
          loadCurrentModel: () => Effect.succeed(null),
          loadTranscript: () =>
            Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
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
          todo: { kind: "ready", phases: [] },
          runtime: {
            publication: Publication.make(0),
            run: { kind: "idle" },
            assistant: [],
            tools: [],
          },
          currentModel: null,
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
                    historyBoundary: () => "stable",
                    settleHistory: () => Promise.resolve(),
                    sendPrompt: () => Promise.resolve(admitted),
                    shake: async (mode) => shakeResult(mode),
                    appendAssistantMessage: () => Promise.resolve(),
                    currentModel: () => null,
                    contextUsage: () => ({ kind: "unavailable" }),
                    availableSkills: () => [],
                    unsubscribe: () => {
                      lifecycle.push("unsubscribe");
                      if (unsubscribeFails) throw unsubscribeFailure;
                    },
                  }),
              },
              loadCurrentModel: () => Effect.succeed(null),
              loadTranscript: () =>
                Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
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
        loadCurrentModel: () => Effect.succeed(null),
        loadTranscript: () => Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
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
                historyBoundary: () => "stable",
                settleHistory: () => Promise.resolve(),
                sendPrompt: () => {
                  emit({ type: "notice", level: "info", message: "last" });
                  return Promise.resolve(admitted);
                },
                shake: async (mode) => shakeResult(mode),
                appendAssistantMessage: () => Promise.resolve(),
                currentModel: () => null,
                contextUsage: () => ({ kind: "unavailable" }),
                availableSkills: () => [],
                unsubscribe: () => {},
              }),
          },
          loadCurrentModel: () => Effect.succeed(null),
          loadTranscript: () =>
            Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
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
                historyBoundary: () => "stable",
                settleHistory: () => Promise.resolve(),
                sendPrompt: async (_value, onStarted) => {
                  onStarted?.();
                  emit({ type: "run-started" });
                  return admitted;
                },
                shake: async (mode) => shakeResult(mode),
                appendAssistantMessage: () => Promise.resolve(),
                currentModel: () => null,
                contextUsage: () => ({ kind: "unavailable" }),
                availableSkills: () => [],
                unsubscribe: () => {},
              }),
          },
          loadCurrentModel: () => Effect.succeed(null),
          loadTranscript: () =>
            Effect.succeed({ messages: [], todo: { kind: "ready", phases: [] } }),
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
        assert.instanceOf(yield* pool.transcript(chatId).pipe(Effect.flip), AgentError);
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

  it.effect(
    "captures a public runtime cut across streaming, late tool completion, and session replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let emit: (event: AgentEvent) => void = () => {
            throw new Error("Session not opened");
          };
          const reading = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let hold = false;
          let historyReads = 0;
          const pool = yield* makeSessionPool({
            factory: {
              open: (_id, callback) =>
                Effect.sync(() => {
                  emit = callback;
                  return {
                    session: {
                      isStreaming: false,
                      waitForIdle: async () => {},
                      settleInFlightMessagePersistence: async () => {},
                      abort: async () => {},
                      beginDispose: () => {},
                      dispose: async () => {},
                    },
                    sendPrompt: async () => admitted,
                    askBtw: () => Promise.reject(new Error("Unexpected side question")),
                    shake: async (mode) => shakeResult(mode),
                    switchModel: () => Promise.reject(new Error("Unexpected model switch")),
                    flush: async () => {},
                    historyBoundary: () => "stable",
                    settleHistory: async () => {},
                    contextUsage: () => ({ kind: "unavailable" }),
                    availableSkills: () => [],
                    currentModel: () => null,
                    appendAssistantMessage: async () => {},
                    unsubscribe: () => {},
                  };
                }),
            },
            loadCurrentModel: () => Effect.succeed(null),
            loadTranscript: () =>
              Effect.gen(function* () {
                historyReads++;
                if (hold) {
                  yield* Deferred.succeed(reading, undefined);
                  yield* Deferred.await(release);
                }
                return { messages: [], todo: { kind: "ready", phases: [] } };
              }),
          });
          yield* pool.contextUsage(chatId);
          const id = Agent.AgentMessageId.make("recoverable");
          const start = {
            type: "tool-started",
            toolCallId: "read",
            toolName: "read",
            argumentsJson: '{"path":"a.ts"}',
          } satisfies AgentEvent;
          const lateStart = {
            ...start,
            toolCallId: "late-read",
            argumentsJson: '{"path":"b.ts"}',
          } satisfies AgentEvent;
          emit({ type: "run-started" });
          emit({ type: "text-delta", messageId: id, contentIndex: 0, text: "prefix" });
          emit(start);
          emit(lateStart);
          const delivery = {
            role: "assistant",
            id: Agent.AgentMessageId.make("delivery"),
            status: "completed",
            stopReason: "stop",
            model: "schedule",
            timestamp: 1,
            content: [{ type: "text", text: "notice" }],
          } satisfies Agent.AgentAssistantMessage;
          yield* pool.deliver(chatId, delivery);
          hold = true;
          const pending = yield* pool.transcript(chatId).pipe(Effect.forkChild);
          yield* Deferred.await(reading);
          emit({ type: "text-delta", messageId: id, contentIndex: 0, text: " suffix" });
          hold = false;
          yield* Deferred.succeed(release, undefined);
          const active = yield* Fiber.join(pending);
          assert.strictEqual(historyReads, 1);
          assert.deepStrictEqual(active.runtime.run, { kind: "running" });
          assert.deepStrictEqual(active.runtime.assistant, [
            {
              kind: "draft",
              messageId: id,
              blocks: [
                { type: "text-delta", messageId: id, contentIndex: 0, text: "prefix suffix" },
              ],
            },
            { kind: "settled", message: delivery },
          ]);
          assert.deepStrictEqual(active.runtime.tools, [
            { kind: "running", start },
            { kind: "running", start: lateStart },
          ]);
          const end = {
            type: "tool-finished",
            toolCallId: start.toolCallId,
            toolName: start.toolName,
            status: "succeeded",
          } satisfies AgentEvent;
          emit(end);
          emit({ type: "run-finished", outcome: "completed" });
          const finished = yield* pool.transcript(chatId);
          assert.deepStrictEqual(finished.runtime.run, { kind: "finished", outcome: "completed" });
          assert.deepStrictEqual(finished.runtime.tools, [{ kind: "finished", start, end }]);
          assert.deepStrictEqual(finished.runtime.assistant, active.runtime.assistant);
          assert.isAbove(finished.runtime.publication, active.runtime.publication);
          const lateEnd = {
            ...end,
            toolCallId: lateStart.toolCallId,
          } satisfies AgentEvent;
          emit(lateEnd);
          const late = yield* pool.transcript(chatId);
          assert.deepStrictEqual(late.runtime.run, { kind: "finished", outcome: "completed" });
          assert.deepStrictEqual(late.runtime.tools, [
            { kind: "finished", start, end },
            { kind: "finished", start: null, end: lateEnd },
          ]);
          assert.deepStrictEqual(late.runtime.assistant, active.runtime.assistant);
          yield* pool.close(chatId);
          const absent = yield* pool.transcript(chatId);
          assert.deepStrictEqual(absent.runtime.run, { kind: "idle" });
          assert.deepStrictEqual(absent.runtime.assistant, []);
          yield* pool.contextUsage(chatId);
          emit({ type: "run-started" });
          assert.isAbove(
            (yield* pool.transcript(chatId)).runtime.publication,
            finished.runtime.publication,
          );
        }),
      ),
  );
});
