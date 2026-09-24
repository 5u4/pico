import { assert, describe, it } from "@effect/vitest";
import type * as AgentEvent from "@pico/contract/agent-event";
import { HistoryRevision } from "@pico/contract/agent-history";
import { ChatId } from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeSessionPool, type OpenedSession } from "./session-pool.ts";

const chatId = ChatId.make("018f47a0-0000-7000-8000-000000000001");

const fixture = Effect.fn("SessionPoolOperationsTest.fixture")(function* (
  options: {
    readonly askBtw?: OpenedSession["askBtw"];
    readonly shake?: OpenedSession["shake"];
    readonly appendAssistantMessage?: OpenedSession["appendAssistantMessage"];
    readonly dispose?: () => Promise<void>;
  } = {},
) {
  let live = false;
  const pool = yield* makeSessionPool({
    factory: {
      open: () =>
        Effect.sync(() => {
          if (live) throw new Error("A second manager opened before the old one closed");
          live = true;
          return {
            session: {
              isStreaming: false,
              waitForIdle: async () => {},
              settleInFlightMessagePersistence: async () => {},
              abort: async () => {},
              beginDispose: () => {},
              dispose: async () => {
                await options.dispose?.();
                live = false;
              },
            },
            sendPrompt: () => Promise.reject(new Error("unexpected prompt")),
            askBtw: options.askBtw ?? (() => Promise.reject(new Error("unexpected side question"))),
            shake:
              options.shake ?? (async () => ({ mode: "images", imagesDropped: 1, tokensFreed: 0 })),
            switchModel: () => Promise.reject(new Error("unexpected model switch")),
            flush: async () => {},
            navigateHistory: () => Promise.reject(new Error("unexpected history navigation")),
            historyBoundary: () => "stable",
            settleHistory: async () => {},
            currentModel: () => null,
            contextUsage: () => ({ kind: "unavailable" }),
            appendAssistantMessage: options.appendAssistantMessage ?? (async () => {}),
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
      Effect.succeed({
        historyRevision: HistoryRevision.make("test-history"),
        messages: [],
        todo: { kind: "ready", phases: [] },
      }),
  });
  return { pool };
});

describe("session pool operations", () => {
  it.effect("reads the transcript while an ephemeral side answer is still pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<string>();
        const { pool } = yield* fixture({
          askBtw: () =>
            Effect.runPromise(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(answer))),
            ),
        });
        const pending = yield* pool
          .askBtw(chatId, "Explain without changing the conversation")
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const snapshot = yield* pool
          .transcript(chatId)
          .pipe(Effect.ensuring(Deferred.succeed(answer, "Ephemeral explanation")));
        assert.deepStrictEqual(snapshot.messages, []);
        assert.deepStrictEqual(snapshot.runtime.assistant, []);
        assert.strictEqual(yield* Fiber.join(pending), "Ephemeral explanation");
        const after = yield* pool.transcript(chatId);
        assert.deepStrictEqual(after.messages, snapshot.messages);
        assert.deepStrictEqual(after.runtime, snapshot.runtime);
      }),
    ),
  );

  for (const stop of ["interrupt", "close", "shutdown"] as const) {
    it.live(`cancels an admitted shake before disposal on ${stop}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const poolScope = yield* Scope.make();
          const order: string[] = [];
          const { pool } = yield* fixture({
            shake: async (_mode, signal) => {
              order.push("started");
              try {
                await new Promise<void>((_resolve, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      order.push("cancelled");
                      queueMicrotask(() => reject(signal.reason));
                    },
                    { once: true },
                  );
                  Deferred.doneUnsafe(entered, Effect.void);
                });
                order.push("mutated");
                return { mode: "images", imagesDropped: 1, tokensFreed: 0 };
              } finally {
                order.push("settled");
              }
            },
            dispose: async () => {
              order.push("disposed");
            },
          }).pipe(Effect.provideService(Scope.Scope, poolScope));
          const pending = yield* pool.shake(chatId, "images").pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const observation = yield* pool.transcript(chatId).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(observation));
          yield* (
            stop === "interrupt"
              ? Fiber.interrupt(pending).pipe(Effect.andThen(pool.close(chatId)))
              : stop === "close"
                ? pool.close(chatId)
                : Scope.close(poolScope, Exit.void)
          ).pipe(Effect.timeout("1 second"));
          const result = yield* Fiber.await(pending);
          assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
          yield* Scope.close(poolScope, Exit.void);
          yield* Effect.sleep("1 millis");
          assert.deepStrictEqual(order, ["started", "cancelled", "settled", "disposed"]);
        }),
      ),
    );
  }

  it.live("keeps a native shake failure that arrives during cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const failure = new AgentError({ message: "Journal write failed while stopping" });
        const { pool } = yield* fixture({
          shake: (_mode, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(failure), { once: true });
              Deferred.doneUnsafe(entered, Effect.void);
            }),
        });
        const pending = yield* pool.shake(chatId, "images").pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(pending).pipe(Effect.timeout("1 second"));
        const result = yield* Fiber.await(pending);
        if (Exit.isSuccess(result)) return assert.fail("Cancelled shake unexpectedly succeeded");
        assert.strictEqual(Option.getOrThrow(Cause.findErrorOption(result.cause)), failure);
        yield* pool.close(chatId);
      }),
    ),
  );

  it.effect(
    "finishes publication persistence and emits once before cancellation releases ownership",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const finishWrite = yield* Deferred.make<void>();
          const order: string[] = [];
          const { pool } = yield* fixture({
            appendAssistantMessage: () =>
              Effect.runPromise(
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(finishWrite)),
                  Effect.andThen(Effect.sync(() => order.push("persisted"))),
                  Effect.asVoid,
                ),
              ),
            dispose: async () => {
              order.push("disposed");
            },
          });
          const delivered: AgentEvent.AgentEvent[] = [];
          yield* pool.events.pipe(
            Stream.runForEach(({ event }) => Effect.sync(() => delivered.push(event))),
            Effect.forkChild,
          );
          const publication = yield* pool
            .publish(chatId, "Persisted despite cancellation")
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const interruption = yield* Fiber.interrupt(publication).pipe(Effect.forkChild);
          const closing = yield* pool.close(chatId).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.deepStrictEqual(order, []);
          yield* Deferred.succeed(finishWrite, undefined);
          yield* Fiber.join(interruption);
          yield* Fiber.join(closing);
          yield* pool.drain();
          assert.deepStrictEqual(order, ["persisted", "disposed"]);
          assert.deepStrictEqual(
            delivered.map((event) => event.type),
            ["run-started", "message-settled", "run-finished"],
          );
          const settled = delivered.find((event) => event.type === "message-settled");
          assert.deepStrictEqual(settled?.message.content, [
            { type: "text", text: "Persisted despite cancellation" },
          ]);
        }),
      ),
  );
});
