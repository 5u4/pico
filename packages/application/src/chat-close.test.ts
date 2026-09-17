import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as AgentMessage from "@pico/contract/agent-message";
import {
  AgentRuntime,
  type ShakeResult,
  type TranscriptSnapshot,
} from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AgentError, ApplicationError, ChatClosed } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import type { GitWorktree } from "@pico/contract/worktree";
import * as Persistence from "@pico/persistence/layer";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ApplicationLayer from "./application.ts";
import { unusedSchedulesLayer } from "./test-schedules.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000098");

const textPrompt = (text: string) => AgentMessage.AgentPrompt.make({ text, attachments: [] });

const scheduledReply: AgentMessage.AgentAssistantMessage = {
  role: "assistant",
  id: AgentMessage.AgentMessageId.make("scheduled-reply"),
  status: "completed",
  stopReason: "stop",
  content: [{ type: "text", text: "B" }],
  model: "test",
  timestamp: 7,
};

const runtimeTranscript: TranscriptSnapshot = {
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 7,
    },
  ],
  contextUsage: { kind: "unavailable" },
};

const assertApplicationError = (
  error: ApplicationError | ChatClosed,
  reason: ApplicationError["reason"],
) => {
  if (!(error instanceof ApplicationError)) {
    assert.fail(`Expected ApplicationError, received ${error._tag}`);
    return;
  }
  assert.strictEqual(error.reason, reason);
};

const makeScheduledDeliveryFixture = Effect.fn("makeScheduledDeliveryFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "pico-scheduled-delivery-",
  });
  const cwd = AbsolutePath.make(path.join(directory, "workspace"));
  yield* fileSystem.makeDirectory(cwd);
  const persistence = Persistence.layer(AbsolutePath.make(path.join(directory, "store.db")));
  const sendStarted = yield* Deferred.make<void>();
  const releaseSend = yield* Deferred.make<void>();
  const order: string[] = [];
  const runtime = Layer.effect(
    AgentRuntime,
    Effect.gen(function* () {
      const chats = yield* ChatRepository;
      return AgentRuntime.of({
        availableModels: () => Effect.die("unexpected model catalog read"),
        switchModel: () => Effect.die("unexpected model switch"),
        askBtw: () => Effect.die("unexpected side question"),
        events: Stream.empty,
        drain: () => Effect.void,
        transcript: () => Effect.die("unexpected transcript read"),
        send: () => Effect.die("unexpected ordinary send"),
        sendCaptured: () => Effect.die("unexpected captured run"),
        deliver: (_chatId, message) =>
          Effect.sync(() => {
            order.push(
              `deliver:${message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("")}`,
            );
          }),
        publish: (_chatId, content) =>
          Effect.sync(() => {
            order.push(`publish:${content}`);
          }),
        close: (chatId) =>
          Effect.gen(function* () {
            const chat = Option.getOrThrow(yield* chats.findById(chatId).pipe(Effect.orDie));
            assert.isNotNull(chat.archivedAt);
            order.push("runtime-close");
          }),
        abort: () => Effect.die("unexpected abort"),
        contextUsage: () => Effect.die("unexpected context read"),
        shake: () => Effect.die("unexpected shake"),
      });
    }),
  ).pipe(Layer.provide(persistence));
  const sessions = Layer.succeed(
    AgentSessionStore,
    AgentSessionStore.of({
      create: () => Effect.void,
      readTitle: () => Effect.succeed(null),
      remove: () => Effect.die("unexpected session removal"),
    }),
  );
  const git: GitWorktree = {
    validate: () => Effect.die("unexpected git validation"),
    create: () => Effect.die("unexpected worktree creation"),
    inspectChat: () => Effect.succeed({ kind: "not-managed" }),
    renameChatBranch: () => Effect.die("unexpected branch rename"),
    removeChat: () => Effect.die("unexpected worktree removal"),
  };
  const services = yield* Layer.build(
    ApplicationLayer.layer(git)
      .pipe(Layer.provide(unusedSchedulesLayer))
      .pipe(
        Layer.provideMerge(persistence),
        Layer.provide(runtime),
        Layer.provide(sessions),
        Layer.provide(BunCrypto.layer),
      ),
  );
  yield* Effect.addFinalizer(() => Deferred.succeed(releaseSend, undefined));
  const application = Context.get(services, Application);
  const chats = Context.get(services, ChatRepository);
  const adapter: Schedule.SchedulePlatform = {
    platform: "discord",
    resolveTarget: () => Effect.die("unexpected target lookup"),
    validateTarget: () => Effect.void,
    createThread: () => Effect.die("unexpected thread creation"),
    deleteThread: () => Effect.die("unexpected thread deletion"),
    send: ({ chatId, content }) =>
      Effect.gen(function* () {
        for (const chunk of [1, 2]) {
          const chat = Option.getOrThrow(yield* chats.findById(chatId).pipe(Effect.orDie));
          assert.isNull(chat.archivedAt);
          order.push(`send:${content}:${chunk}`);
          if (content === "A" && chunk === 1) {
            yield* Deferred.succeed(sendStarted, undefined);
            yield* Deferred.await(releaseSend);
          }
        }
      }),
  };
  const host = Context.get(services, Schedule.ScheduleRunHostFactory)(adapter);
  const workspace = yield* application.createWorkspace({
    name: "scheduled-delivery",
    platform: "discord",
    externalId: "1.10",
    defaultCwd: cwd,
    worktree: null,
  });
  const chat = yield* application.createChat({
    workspaceId: workspace.id,
    externalId: "thread-1",
  });
  return { application, chats, host, workspace, chat, order, sendStarted, releaseSend };
});

describe("Chat close", () => {
  it.effect(
    "serializes scheduled Discord publish and deliver across all chunks without blocking other chats",
    () =>
      Effect.gen(function* () {
        const { application, host, workspace, chat, order, sendStarted, releaseSend } =
          yield* makeScheduledDeliveryFixture();
        const otherChat = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: "thread-2",
        });
        const publishing = yield* host
          .publish(chat.id, "A")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(sendStarted);
        const delivering = yield* host
          .deliver(chat.id, scheduledReply)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const otherDelivery = yield* host
          .publish(otherChat.id, "C")
          .pipe(Effect.forkScoped({ startImmediately: true }));

        assert.deepStrictEqual(otherDelivery.pollUnsafe(), Exit.void);
        assert.isUndefined(delivering.pollUnsafe());
        assert.deepStrictEqual(order, [
          "publish:A",
          "send:A:1",
          "publish:C",
          "send:C:1",
          "send:C:2",
        ]);

        yield* Deferred.succeed(releaseSend, undefined);
        yield* Fiber.join(publishing);
        yield* Fiber.join(delivering);
        assert.deepStrictEqual(order, [
          "publish:A",
          "send:A:1",
          "publish:C",
          "send:C:1",
          "send:C:2",
          "send:A:2",
          "deliver:B",
          "send:B:1",
          "send:B:2",
        ]);
      }).pipe(
        Effect.provideService(Scheduler.PreventSchedulerYield, true),
        Effect.provide(platformLayer),
      ),
  );

  it.effect("waits for all scheduled Discord chunks before archiving and closing a chat", () =>
    Effect.gen(function* () {
      const { application, chats, host, chat, order, sendStarted, releaseSend } =
        yield* makeScheduledDeliveryFixture();
      const sending = yield* host
        .publish(chat.id, "A")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(sendStarted);
      const closing = yield* application
        .closeChat(chat.id, { allowDirtyWorktree: false })
        .pipe(Effect.forkScoped({ startImmediately: true }));

      assert.isUndefined(closing.pollUnsafe());
      assert.isNull(Option.getOrThrow(yield* chats.findById(chat.id)).archivedAt);
      assert.deepStrictEqual(order, ["publish:A", "send:A:1"]);

      yield* Deferred.succeed(releaseSend, undefined);
      yield* Fiber.join(sending);
      assert.deepStrictEqual(yield* Fiber.join(closing), { kind: "closed" });
      assert.isNotNull(Option.getOrThrow(yield* chats.findById(chat.id)).archivedAt);
      assert.deepStrictEqual(order, ["publish:A", "send:A:1", "send:A:2", "runtime-close"]);
      assert.instanceOf(
        yield* host
          .deliver(chat.id, {
            ...scheduledReply,
            id: AgentMessage.AgentMessageId.make("late-reply"),
            content: [{ type: "text", text: "late" }],
          })
          .pipe(Effect.flip),
        Schedule.ScheduleHostError,
      );
      assert.deepStrictEqual(order, ["publish:A", "send:A:1", "send:A:2", "runtime-close"]);
    }).pipe(
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
      Effect.provide(platformLayer),
    ),
  );

  it.effect("allows the next scheduled Discord delivery after interrupting a platform send", () =>
    Effect.gen(function* () {
      const { host, chat, order, sendStarted, releaseSend } = yield* makeScheduledDeliveryFixture();
      const sending = yield* host
        .publish(chat.id, "A")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(sendStarted);
      yield* Fiber.interrupt(sending);
      const result = yield* Fiber.await(sending);
      assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));

      const nextDelivery = yield* host
        .deliver(chat.id, scheduledReply)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      assert.deepStrictEqual(nextDelivery.pollUnsafe(), Exit.void);
      yield* Deferred.succeed(releaseSend, undefined);
      assert.deepStrictEqual(order, ["publish:A", "send:A:1", "deliver:B", "send:B:1", "send:B:2"]);
    }).pipe(
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
      Effect.provide(platformLayer),
    ),
  );

  it.effect(
    "admits input and more Shake work during a main run and waits for Shake before closing",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-btw-close-" });
        const cwd = AbsolutePath.make(path.join(directory, "workspace"));
        yield* fileSystem.makeDirectory(cwd);
        const persistence = Persistence.layer(AbsolutePath.make(path.join(directory, "store.db")));
        const started = yield* Deferred.make<void>();
        const mainFinished = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        const shakeStarted = yield* Deferred.make<void>();
        const anotherShakeStarted = yield* Deferred.make<void>();
        const releaseShake = yield* Deferred.make<void>();
        const releaseAnotherShake = yield* Deferred.make<void>();
        const sent: string[] = [];
        const order: string[] = [];
        const runtime = Layer.succeed(
          AgentRuntime,
          AgentRuntime.of({
            availableModels: () => Effect.die("unexpected model catalog read"),
            switchModel: () => Effect.die("unexpected model switch"),
            events: Stream.empty,
            drain: () => Effect.void,
            transcript: () => Effect.die("unexpected transcript read"),
            send: (_id, prompt) =>
              Effect.sync(() => {
                sent.push(prompt.text);
                return { kind: "started" as const, completed: Deferred.await(mainFinished) };
              }),
            askBtw: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Deferred.succeed(cleaning, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCleanup)),
                    Effect.andThen(
                      Effect.sync(() => {
                        order.push("side-settled");
                      }),
                    ),
                  ),
                ),
              ),
            sendCaptured: () => Effect.die("unexpected scheduled request"),
            deliver: () => Effect.die("unexpected delivery"),
            publish: () => Effect.die("unexpected publication"),
            close: () =>
              Effect.sync(() => {
                order.push("runtime-close");
              }),
            abort: () => Effect.die("unexpected main abort"),
            contextUsage: () => Effect.die("unexpected context read"),
            shake: (_id, mode) =>
              Effect.gen(function* () {
                switch (mode) {
                  case "images":
                    yield* Deferred.succeed(shakeStarted, undefined);
                    yield* Deferred.await(releaseShake);
                    return { mode, imagesDropped: 1, tokensFreed: 0 } satisfies ShakeResult;
                  case "thinking":
                    yield* Deferred.succeed(anotherShakeStarted, undefined);
                    yield* Deferred.await(releaseAnotherShake);
                    return { mode, thinkingBlocksDropped: 1, tokensFreed: 0 } satisfies ShakeResult;
                  case "elide":
                    return yield* Effect.die("unexpected elide");
                }
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    order.push(`shake-${mode}-settled`);
                  }),
                ),
              ),
          }),
        );
        const git: GitWorktree = {
          validate: () => Effect.void,
          create: (_options, use) => use(cwd),
          inspectChat: () => Effect.succeed({ kind: "managed", state: "clean" }),
          renameChatBranch: () => Effect.die("unexpected branch rename"),
          removeChat: () =>
            Effect.sync(() => {
              order.push("worktree-remove");
              return { kind: "removed" as const };
            }),
        };
        yield* Effect.gen(function* () {
          const application = yield* Application;
          const workspace = yield* application.createWorkspace({
            name: "btw",
            platform: "web",
            externalId: null,
            defaultCwd: cwd,
            worktree: { branch: "main", prefix: "chat/" },
          });
          const chat = yield* application.createChat({
            workspaceId: workspace.id,
            externalId: null,
          });
          assertApplicationError(
            yield* application.askBtw(missingChatId, "missing").pipe(Effect.flip),
            "not-found",
          );
          yield* application.sendMessage(chat.id, textPrompt("main"));
          const aside = yield* application
            .askBtw(chat.id, "side")
            .pipe(Effect.exit, Effect.forkChild);
          yield* Deferred.await(started);
          const shaking = yield* application.shake(chat.id, "images").pipe(Effect.forkChild);
          yield* Deferred.await(shakeStarted);
          yield* application.sendMessage(chat.id, textPrompt("later"));
          assert.deepStrictEqual(sent, ["main", "later"]);
          const anotherShake = yield* application.shake(chat.id, "thinking").pipe(Effect.forkChild);
          yield* Deferred.await(anotherShakeStarted);
          yield* Deferred.succeed(mainFinished, undefined);
          const closing = yield* application
            .closeChat(chat.id, { allowDirtyWorktree: false })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const chats = yield* ChatRepository;
          assert.isNull(Option.getOrThrow(yield* chats.findById(chat.id)).archivedAt);
          assert.deepStrictEqual(order, []);
          yield* Deferred.succeed(releaseShake, undefined);
          yield* Fiber.join(shaking);
          assert.isNull(Option.getOrThrow(yield* chats.findById(chat.id)).archivedAt);
          assert.isFalse(yield* Deferred.isDone(cleaning));
          yield* Deferred.succeed(releaseAnotherShake, undefined);
          yield* Fiber.join(anotherShake);
          yield* Deferred.await(cleaning);
          assert.deepStrictEqual(order, ["shake-images-settled", "shake-thinking-settled"]);
          yield* Deferred.succeed(releaseCleanup, undefined);
          assert.deepStrictEqual(yield* Fiber.join(closing), { kind: "closed" });
          const result = yield* Fiber.join(aside);
          assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
          assert.deepStrictEqual(order, [
            "shake-images-settled",
            "shake-thinking-settled",
            "side-settled",
            "runtime-close",
            "worktree-remove",
          ]);
          assert.instanceOf(
            yield* application.askBtw(chat.id, "closed").pipe(Effect.flip),
            ChatClosed,
          );
        }).pipe(
          Effect.ensuring(
            Effect.all(
              [
                Deferred.succeed(mainFinished, undefined),
                Deferred.succeed(releaseShake, undefined),
                Deferred.succeed(releaseAnotherShake, undefined),
                Deferred.succeed(releaseCleanup, undefined),
              ],
              { discard: true },
            ),
          ),
          Effect.provide(ApplicationLayer.layer(git).pipe(Layer.provide(unusedSchedulesLayer))),
          Effect.provide(persistence),
          Effect.provide(runtime),
          Effect.provide(
            Layer.succeed(
              AgentSessionStore,
              AgentSessionStore.of({
                create: () => Effect.void,
                readTitle: () => Effect.succeed(null),
                remove: () => Effect.void,
              }),
            ),
          ),
          Effect.provide(BunCrypto.layer),
          Effect.scoped,
        );
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("serializes close after sends and lets abort reach a scheduled run", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-application-close-",
      });
      const defaultCwd = AbsolutePath.make(path.join(temporaryDirectory, "workspace"));
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
      yield* fileSystem.makeDirectory(defaultCwd);
      const persistenceLayer = Persistence.layer(storeFile);
      const sendStarted = yield* Deferred.make<void>();
      const releaseSend = yield* Deferred.make<void>();
      const scheduledStarted = yield* Deferred.make<void>();
      const releaseScheduled = yield* Deferred.make<void>();
      const order: Array<string> = [];
      let aborts = 0;

      const runtimeLayer = Layer.effect(
        AgentRuntime,
        Effect.gen(function* () {
          const chats = yield* ChatRepository;
          return AgentRuntime.of({
            availableModels: () => Effect.die("unexpected model catalog read"),
            switchModel: () => Effect.die("unexpected model switch"),
            askBtw: () => Effect.die("unexpected side question"),
            events: Stream.empty,
            drain: () => Effect.void,
            transcript: () => Effect.succeed(runtimeTranscript),
            send: (_chatId, value) =>
              Effect.gen(function* () {
                if (value.text === "steer") {
                  return {
                    kind: "steered",
                    consumed: Effect.succeed("consumed" as const),
                    completed: Effect.void,
                  } as const;
                }
                order.push("send-start");
                yield* Deferred.succeed(sendStarted, undefined);
                return { kind: "started", completed: Deferred.await(releaseSend) } as const;
              }),
            sendCaptured: (_chatId, runId) =>
              Deferred.succeed(scheduledStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseScheduled)),
                Effect.as({
                  runId,
                  outcome: "aborted",
                  events: [],
                  finalAssistantText: "",
                }),
              ),
            deliver: () => Effect.die("unexpected scheduled delivery"),
            publish: () => Effect.die("unexpected scheduled publish"),
            close: (id) =>
              Effect.gen(function* () {
                const chat = Option.getOrThrow(yield* chats.findById(id).pipe(Effect.orDie));
                assert.strictEqual(chat.archivedAt, 3_000);
                order.push("runtime-close");
              }),
            abort: () =>
              Effect.sync(() => {
                aborts += 1;
              }).pipe(Effect.andThen(Deferred.succeed(releaseScheduled, undefined)), Effect.asVoid),
            contextUsage: () => Effect.succeed({ kind: "unavailable" }),
            shake: () =>
              Effect.succeed({
                mode: "elide",
                toolResultsDropped: 0,
                blocksDropped: 0,
                tokensFreed: 0,
              }),
          });
        }),
      ).pipe(Layer.provide(persistenceLayer));
      const sessionsLayer = Layer.succeed(
        AgentSessionStore,
        AgentSessionStore.of({
          create: () => Effect.void,
          readTitle: () => Effect.succeed(null),
          remove: () => Effect.void,
        }),
      );
      const gitWorktree: GitWorktree = {
        validate: () => Effect.void,
        create: (_options, use) => use(defaultCwd),
        inspectChat: () =>
          Effect.sync(() => {
            order.push("inspect");
            return { kind: "not-managed" };
          }),
        renameChatBranch: () => Effect.die("unexpected branch rename"),
        removeChat: () => Effect.die("direct chat must not remove a worktree"),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const scheduleHost = (yield* Schedule.ScheduleRunHostFactory)(null);
        yield* TestClock.setTime(1_000);
        const workspace = yield* application.createWorkspace({
          name: "close",
          platform: "web",
          externalId: null,
          defaultCwd,
          worktree: null,
        });
        yield* TestClock.setTime(2_000);
        const chat = yield* application.createChat({ workspaceId: workspace.id, externalId: null });

        const scheduled = yield* scheduleHost
          .runPrompt(
            chat.id,
            Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003"),
            textPrompt("scheduled"),
            () => Effect.void,
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(scheduledStarted);
        const steering = yield* application.sendMessage(chat.id, textPrompt("steer"));
        assert.strictEqual(steering.kind, "steered");
        yield* application.abort(chat.id);
        assert.strictEqual(aborts, 1);
        assert.strictEqual((yield* Fiber.join(scheduled)).outcome, "aborted");

        const send = yield* application
          .sendMessage(chat.id, textPrompt("in flight"))
          .pipe(Effect.forkChild);
        yield* Deferred.await(sendStarted);
        yield* TestClock.setTime(3_000);
        const closing = yield* application
          .closeChat(chat.id, { allowDirtyWorktree: false })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(order, ["send-start"]);
        yield* Deferred.succeed(releaseSend, undefined);
        yield* Fiber.join(send);
        assert.deepStrictEqual(yield* Fiber.join(closing), { kind: "closed" });
        assert.deepStrictEqual(order, ["send-start", "inspect", "runtime-close"]);

        const chats = yield* ChatRepository;
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(chat.id)).archivedAt, 3_000);
        assert.instanceOf(
          yield* application.sendMessage(chat.id, textPrompt("late")).pipe(Effect.flip),
          ChatClosed,
        );
        assert.instanceOf(yield* application.contextUsage(chat.id).pipe(Effect.flip), ChatClosed);
        assert.instanceOf(yield* application.shake(chat.id, "elide").pipe(Effect.flip), ChatClosed);
        assert.instanceOf(
          yield* application.availableModels(chat.id).pipe(Effect.flip),
          ChatClosed,
        );
        assert.instanceOf(
          yield* application
            .switchModel(chat.id, { provider: "openai", id: "gpt-4.1" })
            .pipe(Effect.flip),
          ChatClosed,
        );
        yield* application.abort(chat.id);
        assert.strictEqual(aborts, 1);
        assert.deepStrictEqual(yield* application.transcript(chat.id), runtimeTranscript);

        const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000099");
        assertApplicationError(
          yield* application.sendMessage(missingChatId, textPrompt("missing")).pipe(Effect.flip),
          "not-found",
        );
        assertApplicationError(
          yield* application.contextUsage(missingChatId).pipe(Effect.flip),
          "not-found",
        );
        assertApplicationError(
          yield* application.shake(missingChatId, "elide").pipe(Effect.flip),
          "not-found",
        );
        assertApplicationError(
          yield* application.availableModels(missingChatId).pipe(Effect.flip),
          "not-found",
        );
        assertApplicationError(
          yield* application
            .switchModel(missingChatId, { provider: "openai", id: "gpt-4.1" })
            .pipe(Effect.flip),
          "not-found",
        );
        assertApplicationError(
          yield* application.abort(missingChatId).pipe(Effect.flip),
          "not-found",
        );

        yield* TestClock.setTime(4_000);
        assert.deepStrictEqual(
          yield* application.closeChat(chat.id, { allowDirtyWorktree: false }),
          { kind: "closed" },
        );
        assert.strictEqual(Option.getOrThrow(yield* chats.findById(chat.id)).archivedAt, 3_000);
      }).pipe(
        Effect.provide(
          ApplicationLayer.layer(gitWorktree).pipe(Layer.provide(unusedSchedulesLayer)),
        ),
        Effect.provide(persistenceLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(sessionsLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.live("closes a chat while its scheduled run is waiting for runtime shutdown", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-scheduled-close-",
      });
      const defaultCwd = AbsolutePath.make(path.join(directory, "workspace"));
      yield* fileSystem.makeDirectory(defaultCwd);
      const persistenceLayer = Persistence.layer(
        AbsolutePath.make(path.join(directory, "store.db")),
      );
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          availableModels: () => Effect.die("unexpected model catalog read"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          events: Stream.empty,
          drain: () => Effect.void,
          transcript: () => Effect.succeed({ messages: [], contextUsage: { kind: "unavailable" } }),
          send: () => Effect.die("unexpected ordinary send"),
          sendCaptured: (_chatId, runId) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(stopped)),
              Effect.as({ runId, outcome: "aborted" as const, events: [], finalAssistantText: "" }),
              Effect.ensuring(
                Deferred.succeed(cleanupStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCleanup)),
                  Effect.andThen(
                    fileSystem
                      .writeFileString(path.join(defaultCwd, "cleanup.txt"), "complete")
                      .pipe(Effect.orDie),
                  ),
                ),
              ),
            ),
          deliver: () => Effect.die("unexpected delivery"),
          publish: () => Effect.die("unexpected publication"),
          close: () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
          abort: () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected shake"),
        }),
      );
      const sessionsLayer = Layer.succeed(
        AgentSessionStore,
        AgentSessionStore.of({
          create: () => Effect.void,
          readTitle: () => Effect.succeed(null),
          remove: () => Effect.void,
        }),
      );
      const gitWorktree: GitWorktree = {
        validate: () => Effect.void,
        create: (_options, use) => use(defaultCwd),
        inspectChat: () => Effect.succeed({ kind: "managed", state: "dirty" }),
        renameChatBranch: () => Effect.die("unexpected branch rename"),
        removeChat: ({ cwd }) =>
          fileSystem
            .remove(cwd, { recursive: true })
            .pipe(Effect.orDie, Effect.as({ kind: "removed" as const })),
      };
      yield* Effect.gen(function* () {
        const application = yield* Application;
        const host = (yield* Schedule.ScheduleRunHostFactory)(null);
        const chats = yield* ChatRepository;
        const workspace = yield* application.createWorkspace({
          name: "scheduled-close",
          platform: "web",
          externalId: null,
          defaultCwd,
          worktree: { branch: "main", prefix: "chat/" },
        });
        const chat = yield* application.createChat({ workspaceId: workspace.id, externalId: null });
        yield* Effect.gen(function* () {
          const scheduled = yield* host
            .runPrompt(
              chat.id,
              Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003"),
              textPrompt("scheduled"),
              () => Effect.void,
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const confirmation = yield* Effect.raceFirst(
            application.closeChat(chat.id, { allowDirtyWorktree: false }),
            Effect.sleep("1 second").pipe(Effect.as(null)),
          );
          assert.deepStrictEqual(confirmation, { kind: "worktree-confirmation-required" });
          assert.isFalse(yield* Deferred.isDone(stopped));
          assert.isNull(Option.getOrThrow(yield* chats.findById(chat.id)).archivedAt);
          const closing = yield* application
            .closeChat(chat.id, { allowDirtyWorktree: true })
            .pipe(Effect.forkChild);
          const cleaning = yield* Effect.raceFirst(
            Deferred.await(cleanupStarted).pipe(Effect.as(true)),
            Effect.sleep("1 second").pipe(Effect.as(false)),
          );
          assert.isTrue(cleaning);
          assert.isTrue(yield* fileSystem.exists(defaultCwd));
          yield* Deferred.succeed(releaseCleanup, undefined);
          const result = yield* Effect.raceFirst(
            Fiber.join(closing),
            Effect.sleep("1 second").pipe(Effect.as(null)),
          );
          assert.deepStrictEqual(result, { kind: "closed" });
          assert.strictEqual((yield* Fiber.join(scheduled)).outcome, "aborted");
          assert.isNotNull(Option.getOrThrow(yield* chats.findById(chat.id)).archivedAt);
          assert.isFalse(yield* fileSystem.exists(defaultCwd));
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(stopped, undefined).pipe(
              Effect.andThen(Deferred.succeed(releaseCleanup, undefined)),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          ApplicationLayer.layer(gitWorktree).pipe(Layer.provide(unusedSchedulesLayer)),
        ),
        Effect.provide(persistenceLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(sessionsLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("confirms destructive cleanup and never removes before runtime disposal", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-application-cleanup-",
      });
      const defaultCwd = AbsolutePath.make(path.join(temporaryDirectory, "repository"));
      yield* fileSystem.makeDirectory(defaultCwd);
      const worktreeCwd = AbsolutePath.make(path.join(temporaryDirectory, "worktree"));
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
      const persistenceLayer = Persistence.layer(storeFile);
      const order: Array<string> = [];
      let inspectionState: "clean" | "dirty" = "dirty";
      let removalResult: "removed" | "force-required" = "removed";
      let runtimeFails = false;

      const runtimeLayer = Layer.effect(
        AgentRuntime,
        Effect.gen(function* () {
          const chats = yield* ChatRepository;
          return AgentRuntime.of({
            availableModels: () => Effect.die("unexpected model catalog read"),
            switchModel: () => Effect.die("unexpected model switch"),
            askBtw: () => Effect.die("unexpected side question"),
            events: Stream.empty,
            drain: () => Effect.void,
            transcript: () =>
              Effect.succeed({ messages: [], contextUsage: { kind: "unavailable" } }),
            send: () => Effect.die("unexpected send"),
            sendCaptured: () => Effect.die("unexpected captured runtime send"),
            deliver: () => Effect.die("unexpected scheduled delivery"),
            publish: () => Effect.die("unexpected scheduled publish"),
            close: (id) =>
              Effect.gen(function* () {
                assert.isNotNull(
                  Option.getOrThrow(yield* chats.findById(id).pipe(Effect.orDie)).archivedAt,
                );
                order.push("runtime-close");
                if (runtimeFails) return yield* new AgentError({ message: "dispose failed" });
              }),
            abort: () => Effect.die("unexpected abort"),
            contextUsage: () => Effect.die("unexpected context read"),
            shake: () => Effect.die("unexpected shake"),
          });
        }),
      ).pipe(Layer.provide(persistenceLayer));
      const sessionsLayer = Layer.succeed(
        AgentSessionStore,
        AgentSessionStore.of({
          create: () => Effect.void,
          readTitle: () => Effect.succeed(null),
          remove: () => Effect.void,
        }),
      );
      const gitWorktree: GitWorktree = {
        validate: () => Effect.void,
        create: (_options, use) => use(worktreeCwd),
        inspectChat: () =>
          Effect.sync(() => {
            order.push(`inspect-${inspectionState}`);
            return { kind: "managed", state: inspectionState };
          }),
        renameChatBranch: () => Effect.die("unexpected branch rename"),
        removeChat: ({ force }) =>
          Effect.sync(() => {
            order.push(force ? "remove-force" : "remove-clean");
            return { kind: removalResult };
          }),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const chats = yield* ChatRepository;
        const workspace = yield* application.createWorkspace({
          name: "worktree",
          platform: "web",
          externalId: null,
          defaultCwd,
          worktree: { branch: "main", prefix: "chat/" },
        });
        const dirtyChat = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
        });

        assert.deepStrictEqual(
          yield* application.closeChat(dirtyChat.id, { allowDirtyWorktree: false }),
          { kind: "worktree-confirmation-required" },
        );
        assert.isNull(Option.getOrThrow(yield* chats.findById(dirtyChat.id)).archivedAt);
        assert.deepStrictEqual(order, ["inspect-dirty"]);

        assert.deepStrictEqual(
          yield* application.closeChat(dirtyChat.id, { allowDirtyWorktree: true }),
          { kind: "closed" },
        );
        assert.deepStrictEqual(order, [
          "inspect-dirty",
          "inspect-dirty",
          "runtime-close",
          "remove-force",
        ]);

        const racedChat = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
        });
        inspectionState = "clean";
        removalResult = "force-required";
        assert.deepStrictEqual(
          yield* application.closeChat(racedChat.id, { allowDirtyWorktree: false }),
          { kind: "worktree-confirmation-required" },
        );
        assert.isNotNull(Option.getOrThrow(yield* chats.findById(racedChat.id)).archivedAt);
        assert.deepStrictEqual(order.slice(-3), ["inspect-clean", "runtime-close", "remove-clean"]);

        const failedChat = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
        });
        runtimeFails = true;
        removalResult = "removed";
        const removalsBeforeFailure = order.filter((entry) => entry.startsWith("remove")).length;
        const closeError = yield* application
          .closeChat(failedChat.id, { allowDirtyWorktree: true })
          .pipe(Effect.flip);
        assertApplicationError(closeError, "operation");
        assert.include(closeError.message, "dispose failed");
        assert.isNotNull(Option.getOrThrow(yield* chats.findById(failedChat.id)).archivedAt);
        assert.strictEqual(
          order.filter((entry) => entry.startsWith("remove")).length,
          removalsBeforeFailure,
        );
      }).pipe(
        Effect.provide(
          ApplicationLayer.layer(gitWorktree).pipe(Layer.provide(unusedSchedulesLayer)),
        ),
        Effect.provide(persistenceLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(sessionsLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );
});
