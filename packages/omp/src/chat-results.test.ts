import NodeFileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ChatId } from "@pico/contract/chat-model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenedSession } from "./session-pool.ts";

const importNative = async () => {
  const [managers, loaders, adapter, pool] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/session/session-manager"),
    import("@oh-my-pi/pi-coding-agent/session/session-loader"),
    import("./layer.ts"),
    import("./session-pool.ts"),
  ]);
  return { ...managers, ...loaders, ...adapter, ...pool };
};

let native: Awaited<ReturnType<typeof importNative>>;
let root: string;

beforeAll(async () => {
  root = await NodeFileSystem.realpath(
    await NodeFileSystem.mkdtemp(join(tmpdir(), "pico-chat-results-")),
  );
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("OMP_PROFILE", "default");
  vi.stubEnv("PI_PROFILE", "default");
  vi.stubEnv("PI_TEST_RUNTIME", "1");
  vi.stubEnv("PI_NO_TITLE", "1");
  native = await importNative();
}, 30_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (root) await NodeFileSystem.rm(root, { recursive: true, force: true });
});

const assistant = (
  messageId: string,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage & { messageId: string } => ({
  role: "assistant",
  messageId,
  content,
  stopReason,
  api: "pico",
  provider: "pico",
  model: "pico/test",
  timestamp: 1,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

const withJournal = async (run: (manager: SessionManager, file: string) => Promise<void>) => {
  const cwd = await NodeFileSystem.mkdtemp(join(root, "session-"));
  const manager = native.SessionManager.create(cwd, join(cwd, "sessions"));
  const file = manager.getSessionFile();
  if (file === undefined) throw new Error("Expected a file-backed native session");
  try {
    await manager.ensureOnDisk();
    await run(manager, file);
  } finally {
    await manager.close();
  }
};

describe("durable chat results", () => {
  it("uses append order across branches and ignores branch selection and non-results", async () => {
    await withJournal(async (manager, file) => {
      const first = manager.appendMessage({
        ...assistant("first", [{ type: "text", text: "First answer" }]),
        timestamp: 200,
      });
      manager.resetLeaf();
      const last = manager.appendMessage(
        assistant("last", [{ type: "text", text: "Later append" }]),
      );
      manager.branch(first);
      manager.appendMessage({ role: "user", content: "A new request", timestamp: 300 });
      manager.appendMessage(assistant("thinking", [{ type: "thinking", thinking: "Private" }]));
      manager.appendMessage(
        assistant("tool-use", [{ type: "text", text: "Running tool" }], "toolUse"),
      );
      manager.appendMessage(
        assistant(
          "mixed-tool",
          [
            { type: "text", text: "Still running a tool" },
            { type: "toolCall", id: "call", name: "read", arguments: {} },
          ],
          "length",
        ),
      );
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        content: [{ type: "text", text: "Tool result" }],
        isError: false,
        timestamp: 400,
      });
      await manager.flush();
      const journal = await native.loadSessionHistoryReadOnly(file);
      const latest = { cursor: { sessionId: journal.sessionId, entryId: last }, messageId: "last" };
      expect(
        native.projectResultSummary(journal, { sessionId: journal.sessionId, entryId: first }),
      ).toEqual({
        kind: "ready",
        latest,
        relation: "behind",
      });
      manager.branch(first);
      await manager.flush();
      const selected = await native.loadSessionHistoryReadOnly(file);
      expect(native.projectResultSummary(selected, latest.cursor)).toEqual({
        kind: "ready",
        latest,
        relation: "covered",
      });
      expect(
        (await native.loadSessionMessagesReadOnly(file)).map((message) => message.role),
      ).toEqual(["assistant"]);
    });
  });

  it("qualifies visible error notices and retained abort output but not empty aborts", async () => {
    await withJournal(async (manager, file) => {
      const error = manager.appendMessage(assistant("error", [], "error"));
      manager.appendMessage(assistant("empty-abort", [], "aborted"));
      await manager.setSessionName("Changed title", "user");
      manager.appendMessage(
        assistant("thinking-abort", [{ type: "thinking", thinking: "Private" }], "aborted"),
      );
      manager.appendMessage(assistant("blank-abort", [{ type: "text", text: " \n " }], "aborted"));
      await manager.flush();
      const journal = await native.loadSessionHistoryReadOnly(file);
      const errorCursor = { sessionId: journal.sessionId, entryId: error };
      expect(native.projectResultSummary(journal, null)).toEqual({
        kind: "ready",
        latest: { cursor: errorCursor, messageId: "error" },
        relation: "none",
      });
      const retained = manager.appendMessage(
        assistant("retained-abort", [{ type: "text", text: "Partial answer" }], "aborted"),
      );
      await manager.flush();
      expect(
        native.projectResultSummary(await native.loadSessionHistoryReadOnly(file), errorCursor),
      ).toEqual({
        kind: "ready",
        latest: {
          cursor: { sessionId: journal.sessionId, entryId: retained },
          messageId: "retained-abort",
        },
        relation: "behind",
      });
      const image = manager.appendMessage(
        assistant("image", [{ type: "image", data: "AA==", mimeType: "image/png" }]),
      );
      await manager.flush();
      expect(
        native.projectResultSummary(await native.loadSessionHistoryReadOnly(file), null),
      ).toEqual({
        kind: "ready",
        latest: { cursor: { sessionId: journal.sessionId, entryId: image }, messageId: "image" },
        relation: "none",
      });
    });
  });

  it("reports missing or foreign anchors as resets without inventing continuity", async () => {
    await withJournal(async (manager, file) => {
      const entryId = manager.appendMessage(
        assistant("survivor", [{ type: "text", text: "Surviving answer" }]),
      );
      await manager.flush();
      const journal = await native.loadSessionHistoryReadOnly(file);
      const latest = { cursor: { sessionId: journal.sessionId, entryId }, messageId: "survivor" };
      expect(
        native.projectResultSummary(journal, {
          sessionId: journal.sessionId,
          entryId: "deleted-entry",
        }),
      ).toEqual({ kind: "reset", latest });
      expect(
        native.projectResultSummary(journal, { sessionId: "replaced-session", entryId }),
      ).toEqual({ kind: "reset", latest });
    });
  });

  it("waits for an emitted assistant to reach disk before returning its result", async () => {
    await withJournal(async (manager, file) => {
      const chatId = ChatId.make("018f47a0-0000-7000-8000-000000000001");
      const waiting = Promise.withResolvers<void>();
      const persisted = Promise.withResolvers<void>();
      let publish: Parameters<AgentSession["subscribe"]>[0] = () => {
        throw new Error("Session observation has not subscribed");
      };
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pool = yield* native.makeSessionPool({
              factory: {
                open: (_id, emit) =>
                  Effect.sync(() => {
                    const observation = native.makeSessionObservation(
                      {
                        sessionManager: manager,
                        settleInFlightMessagePersistence: async () => {
                          waiting.resolve();
                          await persisted.promise;
                        },
                        subscribe: (listener) => {
                          publish = listener;
                          return () => {};
                        },
                      },
                      emit,
                      (cause) => {
                        throw cause;
                      },
                    );
                    return {
                      ...observation,
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
                        Promise.reject(new Error("Unexpected publication")),
                      navigateHistory: () =>
                        Promise.reject(new Error("Unexpected history navigation")),
                      flush: () => manager.flush(),
                      contextUsage: () => ({ kind: "unavailable" }),
                      currentModel: () => null,
                      availableSkills: () => [],
                    } satisfies OpenedSession;
                  }),
              },
              loadTranscript: () => Effect.die("Unexpected transcript hydration"),
              loadCurrentModel: () => Effect.succeed(null),
              loadHistory: () => Effect.die("Unexpected history read"),
              loadHistoryPreview: () => Effect.die("Unexpected history preview"),
              loadResultSummary: (_id, seen) =>
                Effect.promise(async () =>
                  native.projectResultSummary(await native.loadSessionHistoryReadOnly(file), seen),
                ),
            });
            yield* pool.availableSkills(chatId);
            const message = assistant("settling", [
              { type: "text", text: "Persisted after notification" },
            ]);
            publish({ type: "message_end", message });
            const read = yield* pool.resultSummary(chatId, null).pipe(Effect.forkChild);
            yield* Effect.promise(() => waiting.promise);
            const entryId = manager.appendMessage(message);
            persisted.resolve();
            const summary = yield* Fiber.join(read);
            const journal = yield* Effect.promise(() => native.loadSessionHistoryReadOnly(file));
            expect(summary).toEqual({
              kind: "ready",
              latest: { cursor: { sessionId: journal.sessionId, entryId }, messageId: "settling" },
              relation: "none",
            });
            expect(native.projectResultSummary(journal, null)).toEqual(summary);
          }),
        ),
      );
    });
  });
});
