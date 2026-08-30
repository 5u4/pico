import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as OmpSessionManager from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as Agent from "@pico/contract/agent";
import * as Chat from "@pico/contract/chat";
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
                sendUserMessage: (value) => {
                  if (value !== "acquire") {
                    emit({ type: "notice", level: "info", message: value });
                  }
                  return Promise.resolve();
                },
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
});
