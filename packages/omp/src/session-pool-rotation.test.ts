import { assert, describe, it } from "@effect/vitest";
import type * as AgentEvent from "@pico/contract/agent-event";
import { AgentPrompt } from "@pico/contract/agent-message";
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
import * as TestClock from "effect/testing/TestClock";
import { makeSessionPool, type OpenedSession } from "./session-pool.ts";

const chatId = ChatId.make("018f47a0-0000-7000-8000-000000000001");
const prompt = AgentPrompt.make({ text: "Continue the task", attachments: [] });
const handoff = "Pending task: update work/result.txt. Keep the existing file format.";

const fixture = Effect.fn("RotationTest.fixture")(function* (
  options: {
    readonly createHandoff?: OpenedSession["createHandoff"];
    readonly streaming?: () => boolean;
    readonly persistence?: () => Promise<void>;
    readonly askBtw?: OpenedSession["askBtw"];
    readonly shake?: OpenedSession["shake"];
    readonly appendAssistantMessage?: OpenedSession["appendAssistantMessage"];
    readonly loadTranscript?: Parameters<typeof makeSessionPool>[0]["loadTranscript"];
    readonly runCompletion?: Effect.Effect<void>;
    readonly dispose?: () => Promise<void>;
  } = {},
) {
  let current = "old journal";
  let live = false;
  const pool = yield* makeSessionPool({
    factory: {
      open: (_id, emit) =>
        Effect.sync(() => {
          if (live) throw new Error("A second manager opened before the old one closed");
          live = true;
          const journal = current;
          return {
            eventMode: "captured",
            session: {
              get isStreaming() {
                return options.streaming?.() ?? false;
              },
              waitForIdle: async () => {},
              settleInFlightMessagePersistence: options.persistence ?? (async () => {}),
              abort: async () => {},
              beginDispose: () => {},
              dispose: async () => {
                await options.dispose?.();
                live = false;
              },
            },
            sendPrompt: async (_prompt, onStarted) => {
              onStarted?.();
              emit({ type: "run-started" });
              emit({ type: "title-changed", title: "Never publish a bot title" });
              return {
                kind: "started",
                completed: (options.runCompletion ?? Effect.void).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => emit({ type: "run-finished", outcome: "completed" })),
                  ),
                ),
              };
            },
            createHandoff: options.createHandoff ?? (async () => handoff),
            askBtw: options.askBtw ?? (async () => journal),
            shake:
              options.shake ?? (async () => ({ mode: "images", imagesDropped: 1, tokensFreed: 0 })),
            contextUsage: () => ({ kind: "unavailable" }),
            appendAssistantMessage: options.appendAssistantMessage ?? (async () => {}),
            unsubscribe: () => {},
          } satisfies OpenedSession;
        }),
    },
    loadTranscript: options.loadTranscript ?? (() => Effect.succeed([])),
  });
  return {
    pool,
    commit: (summary: string) =>
      Effect.sync(() => {
        assert.equal(summary, handoff);
        current = "new journal";
      }),
  };
});

const unexpectedCommit = () => Effect.die("A rejected rotation must not commit");

describe("session pool rotation", () => {
  it.effect("rejects capture ownership after terminal output until the sink settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { pool } = yield* fixture();
        const sinkEntered = yield* Deferred.make<void>();
        const releaseSink = yield* Deferred.make<void>();
        const captured: AgentEvent.AgentEvent[] = [];
        const broadcast: AgentEvent.AgentEvent[] = [];
        yield* pool.events.pipe(
          Stream.runForEach(({ event }) =>
            Effect.sync(() => {
              broadcast.push(event);
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const turn = yield* pool
          .sendTurn(chatId, prompt, (event) =>
            Effect.gen(function* () {
              captured.push(event);
              if (event.type === "run-finished") {
                yield* Deferred.succeed(sinkEntered, undefined);
                yield* Deferred.await(releaseSink);
              }
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(sinkEntered);
        assert.instanceOf(
          yield* pool.rotate(chatId, unexpectedCommit).pipe(Effect.flip),
          AgentError,
        );
        yield* Deferred.succeed(releaseSink, undefined);
        const result = yield* Fiber.join(turn);
        yield* pool.drain();
        assert.deepStrictEqual(result.events, [
          { type: "run-started" },
          { type: "run-finished", outcome: "completed" },
        ]);
        assert.deepStrictEqual(broadcast, captured);
        assert.equal(yield* pool.askBtw(chatId, "Which context?"), "old journal");
      }),
    ),
  );

  it.effect("rejects capture ownership while completed output is still persisting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const persistenceEntered = yield* Deferred.make<void>();
        const releasePersistence = yield* Deferred.make<void>();
        let terminal = false;
        const { pool } = yield* fixture({
          persistence: () =>
            terminal
              ? Effect.runPromise(
                  Deferred.succeed(persistenceEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releasePersistence)),
                  ),
                )
              : Promise.resolve(),
        });
        const turn = yield* pool
          .sendTurn(chatId, prompt, (event) =>
            Effect.sync(() => {
              if (event.type === "run-finished") terminal = true;
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(persistenceEntered);
        assert.instanceOf(
          yield* pool.rotate(chatId, unexpectedCommit).pipe(Effect.flip),
          AgentError,
        );
        yield* Deferred.succeed(releasePersistence, undefined);
        assert.equal((yield* Fiber.join(turn)).outcome, "completed");
      }),
    ),
  );

  it.effect("rejects an ordinary run until its completed receipt settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const finished = yield* Deferred.make<void>();
        const { pool, commit } = yield* fixture({ runCompletion: Deferred.await(finished) });
        const receipt = yield* pool.send(chatId, prompt);
        assert.instanceOf(
          yield* pool.rotate(chatId, unexpectedCommit).pipe(Effect.flip),
          AgentError,
        );
        yield* Deferred.succeed(finished, undefined);
        if (receipt.kind === "handled") return yield* Effect.die("Expected an ordinary turn");
        yield* receipt.completed;
        yield* pool.rotate(chatId, commit);
        assert.equal(yield* pool.askBtw(chatId, "Which context?"), "new journal");
      }),
    ),
  );

  it.effect("rejects SDK streaming without an admitted pool run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let streaming = true;
        const { pool, commit } = yield* fixture({ streaming: () => streaming });
        assert.instanceOf(
          yield* pool.rotate(chatId, unexpectedCommit).pipe(Effect.flip),
          AgentError,
        );
        streaming = false;
        yield* pool.rotate(chatId, commit);
        assert.equal(yield* pool.askBtw(chatId, "Which context?"), "new journal");
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

  for (const operation of ["btw", "shake", "publication"] as const) {
    it.effect(`rejects an in-flight ${operation} operation`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const wait = () =>
            Effect.runPromise(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            );
          const { pool, commit } = yield* fixture({
            askBtw: async () => {
              await wait();
              return "Side answer";
            },
            shake: async () => {
              await wait();
              return { mode: "images", imagesDropped: 1, tokensFreed: 0 };
            },
            appendAssistantMessage: wait,
          });
          const pending = yield* (
            operation === "btw"
              ? pool.askBtw(chatId, "Side question").pipe(Effect.asVoid)
              : operation === "shake"
                ? pool.shake(chatId, "images").pipe(Effect.asVoid)
                : pool.publish(chatId, "Published answer")
          ).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          assert.instanceOf(
            yield* pool.rotate(chatId, unexpectedCommit).pipe(Effect.flip),
            AgentError,
          );
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
          yield* pool.rotate(chatId, commit);
        }),
      ),
    );
  }

  for (const failure of ["provider", "empty", "oversized", "commit"] as const) {
    it.effect(`retains the live journal when ${failure} fails`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { pool } = yield* fixture({
            createHandoff: async () => {
              if (failure === "provider") throw new Error("Provider failed");
              if (failure === "empty") return " \n ";
              if (failure === "oversized") return "界".repeat(6000);
              return handoff;
            },
          });
          const commit =
            failure === "commit"
              ? () => Effect.fail(new AgentError({ message: "Cutover failed" }))
              : unexpectedCommit;
          assert.instanceOf(yield* pool.rotate(chatId, commit).pipe(Effect.flip), AgentError);
          assert.equal(yield* pool.askBtw(chatId, "Which context?"), "old journal");
        }),
      ),
    );
  }

  it.effect("cancels an interrupted handoff before releasing the old session admission", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handoffEntered = yield* Deferred.make<void>();
        const abortObserved = yield* Deferred.make<void>();
        const settleHandoff = yield* Deferred.make<void>();
        const interruptionFinished = yield* Deferred.make<void>();
        const answered = yield* Deferred.make<string>();
        const { pool } = yield* fixture({
          createHandoff: (signal) => {
            signal.addEventListener(
              "abort",
              () => {
                Deferred.doneUnsafe(abortObserved, Effect.void);
              },
              { once: true },
            );
            return Effect.runPromise(
              Deferred.succeed(handoffEntered, undefined).pipe(
                Effect.andThen(Deferred.await(settleHandoff)),
                Effect.andThen(Effect.fail(new AgentError({ message: "Handoff model aborted" }))),
              ),
            );
          },
        });
        const rotation = yield* pool.rotate(chatId, unexpectedCommit).pipe(Effect.forkChild);
        yield* Deferred.await(handoffEntered);
        const interruption = yield* Fiber.interrupt(rotation).pipe(
          Effect.tap(() => Deferred.succeed(interruptionFinished, undefined)),
          Effect.forkChild,
        );
        yield* Deferred.await(abortObserved);
        const sideQuestion = yield* pool.askBtw(chatId, "Which context?").pipe(
          Effect.tap((answer) => Deferred.succeed(answered, answer)),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(interruptionFinished));
        assert.isFalse(yield* Deferred.isDone(answered));
        yield* Deferred.succeed(settleHandoff, undefined);
        yield* Fiber.join(interruption);
        const interrupted = yield* Fiber.await(rotation);
        assert.isTrue(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause));
        assert.equal(yield* Fiber.join(sideQuestion), "old journal");
      }),
    ),
  );

  it.effect("holds admission during handoff and never returns the retired generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handoffEntered = yield* Deferred.make<void>();
        const releaseHandoff = yield* Deferred.make<void>();
        const { pool, commit } = yield* fixture({
          createHandoff: () =>
            Effect.runPromise(
              Deferred.succeed(handoffEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseHandoff)),
                Effect.as(handoff),
              ),
            ),
        });
        const rotation = yield* pool.rotate(chatId, commit).pipe(Effect.forkChild);
        yield* Deferred.await(handoffEntered);
        const sideQuestion = yield* pool
          .askBtw(chatId, "Which context?")
          .pipe(Effect.asVoid, Effect.result, Effect.forkChild);
        const shake = yield* pool
          .shake(chatId, "images")
          .pipe(Effect.asVoid, Effect.result, Effect.forkChild);
        const publication = yield* pool
          .publish(chatId, "Do not append to the retired journal")
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseHandoff, undefined);
        yield* Fiber.join(rotation);
        for (const pending of [sideQuestion, shake, publication]) {
          const result = yield* Fiber.join(pending);
          assert.equal(result._tag, "Failure");
        }
        assert.equal(yield* pool.askBtw(chatId, "Which context?"), "new journal");
      }),
    ),
  );

  it.effect("retired reader release cannot evict a replacement with an active owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handoffEntered = yield* Deferred.make<void>();
        const releaseHandoff = yield* Deferred.make<void>();
        const readerEntered = yield* Deferred.make<void>();
        const releaseReader = yield* Deferred.make<void>();
        const ownerEntered = yield* Deferred.make<void>();
        const releaseOwner = yield* Deferred.make<void>();
        const { pool, commit } = yield* fixture({
          createHandoff: () =>
            Effect.runPromise(
              Deferred.succeed(handoffEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseHandoff)),
                Effect.as(handoff),
              ),
            ),
          loadTranscript: () =>
            Deferred.succeed(readerEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseReader)),
              Effect.as([]),
            ),
          askBtw: () =>
            Effect.runPromise(
              Deferred.succeed(ownerEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseOwner)),
                Effect.as("Replacement stayed live"),
              ),
            ),
        });
        const rotation = yield* pool.rotate(chatId, commit).pipe(Effect.forkChild);
        yield* Deferred.await(handoffEntered);
        const oldReader = yield* pool
          .transcript(chatId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(releaseHandoff, undefined);
        yield* Fiber.join(rotation);
        yield* Deferred.await(readerEntered);
        const owner = yield* pool.askBtw(chatId, "Hold replacement").pipe(Effect.forkChild);
        yield* Deferred.await(ownerEntered);
        yield* Deferred.succeed(releaseReader, undefined);
        yield* Fiber.join(oldReader);
        yield* TestClock.adjust("10 minutes");
        assert.deepStrictEqual(yield* pool.contextUsage(chatId), { kind: "unavailable" });
        yield* Deferred.succeed(releaseOwner, undefined);
        assert.equal(yield* Fiber.join(owner), "Replacement stayed live");
      }),
    ),
  );
});
