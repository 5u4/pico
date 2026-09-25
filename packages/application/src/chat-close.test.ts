import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Publication } from "@pico/contract/agent-event";
import { HistoryRevision } from "@pico/contract/agent-history";
import * as AgentMessage from "@pico/contract/agent-message";
import { AgentRuntime, type ShakeResult } from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import type { TranscriptSnapshot } from "@pico/contract/agent-snapshot";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import {
  AgentError,
  ApplicationError,
  ChatClosed,
  type PersistenceError,
} from "@pico/contract/errors";
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
  historyRevision: HistoryRevision.make("test-history"),
  todo: { kind: "ready", phases: [] },
  runtime: { publication: Publication.make(0), run: { kind: "idle" }, assistant: [], tools: [] },
  currentModel: null,
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
        history: () => Effect.die("unexpected history read"),
        previewHistory: () => Effect.die("unexpected history preview"),
        navigateHistory: () => Effect.die("unexpected history navigation"),
        availableModels: () => Effect.die("unexpected model catalog read"),
        discoverSkills: () => Effect.die("unexpected workspace skill command discovery"),
        switchModel: () => Effect.die("unexpected model switch"),
        askBtw: () => Effect.die("unexpected side question"),
        events: Stream.empty,
        drain: () => Effect.void,
        transcript: () => Effect.die("unexpected transcript read"),
        resultSummary: () => Effect.die("unexpected chat results read"),
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
        availableSkills: () => Effect.die("unexpected skill command discovery"),
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
    slotCandidate: () => Effect.succeed(Option.none()),
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
    modelOverride: null,
    sourceChatId: null,
  });
  return { application, chats, host, workspace, chat, order, sendStarted, releaseSend };
});

const makeSharedCwdFixture = Effect.fn("makeSharedCwdFixture")(function* (
  hooks: {
    readonly closeRuntime?: AgentRuntime["Service"]["close"];
    readonly sendCaptured?: AgentRuntime["Service"]["sendCaptured"];
    readonly afterArchive?: (chatId: Chat.ChatId) => Effect.Effect<void, PersistenceError>;
    readonly beforeSession?: () => Effect.Effect<void, AgentError>;
    readonly beforeRemove?: (cwd: AbsolutePath) => Effect.Effect<void>;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-shared-close-" });
  const repository = AbsolutePath.make(path.join(directory, "repository"));
  const worktreesDir = AbsolutePath.make(path.join(directory, "worktrees"));
  const sessionsDir = path.join(directory, "sessions");
  yield* fileSystem.makeDirectory(repository);
  yield* fileSystem.makeDirectory(worktreesDir);
  yield* fileSystem.makeDirectory(sessionsDir);
  const persistence = Persistence.layer(AbsolutePath.make(path.join(directory, "store.db")));
  const repositories = Layer.effect(
    ChatRepository,
    Effect.gen(function* () {
      const chats = yield* ChatRepository;
      return ChatRepository.of({
        ...chats,
        archive: (id, archivedAt) =>
          chats
            .archive(id, archivedAt)
            .pipe(Effect.tap(() => hooks.afterArchive?.(id) ?? Effect.void)),
      });
    }),
  ).pipe(Layer.provideMerge(persistence));
  const sessions = Layer.succeed(
    AgentSessionStore,
    AgentSessionStore.of({
      create: ({ chatId, cwd }) =>
        Effect.gen(function* () {
          yield* hooks.beforeSession?.() ?? Effect.void;
          yield* fileSystem.writeFileString(path.join(sessionsDir, chatId), cwd).pipe(Effect.orDie);
        }),
      readTitle: () => Effect.succeed(null),
      remove: (chatId) => fileSystem.remove(path.join(sessionsDir, chatId)).pipe(Effect.orDie),
    }),
  );
  const runtime = Layer.effect(
    AgentRuntime,
    Effect.gen(function* () {
      const chats = yield* ChatRepository;
      return AgentRuntime.of({
        history: () => Effect.die("unexpected history read"),
        previewHistory: () => Effect.die("unexpected history preview"),
        navigateHistory: () => Effect.die("unexpected history navigation"),
        availableModels: () => Effect.die("unexpected model catalog read"),
        discoverSkills: () => Effect.die("unexpected skill discovery"),
        switchModel: () => Effect.die("unexpected model switch"),
        askBtw: () => Effect.die("unexpected side question"),
        events: Stream.empty,
        drain: () => Effect.void,
        transcript: () => Effect.succeed(runtimeTranscript),
        resultSummary: () => Effect.die("unexpected results read"),
        send: () => Effect.die("unexpected send"),
        sendCaptured: hooks.sendCaptured ?? (() => Effect.die("unexpected captured send")),
        deliver: () => Effect.die("unexpected delivery"),
        publish: () => Effect.die("unexpected publish"),
        close: (id) =>
          Effect.gen(function* () {
            const chat = Option.getOrThrow(yield* chats.findById(id).pipe(Effect.orDie));
            assert.isNotNull(chat.archivedAt);
            yield* hooks.closeRuntime?.(id) ?? Effect.void;
          }),
        abort: () => Effect.die("unexpected abort"),
        contextUsage: () => Effect.die("unexpected context read"),
        shake: () => Effect.die("unexpected shake"),
        availableSkills: () => Effect.die("unexpected skills read"),
      });
    }),
  ).pipe(Layer.provide(repositories));
  const slots = new Map<AbsolutePath, Chat.ChatId>();
  const git: GitWorktree = {
    validate: () => Effect.void,
    create: (options, use) =>
      Effect.gen(function* () {
        const cwd = AbsolutePath.make(path.join(worktreesDir, options.chatId));
        yield* fileSystem.makeDirectory(cwd).pipe(Effect.orDie);
        slots.set(cwd, options.chatId);
        return yield* use(cwd);
      }),
    slotCandidate: (cwd) =>
      Effect.sync(() => {
        const chatId = slots.get(cwd);
        return chatId === undefined ? Option.none() : Option.some({ chatId, cwd });
      }),
    inspectChat: ({ cwd }) =>
      Effect.gen(function* () {
        if (!(yield* fileSystem.exists(cwd).pipe(Effect.orDie))) {
          return { kind: "managed", state: "absent" } as const;
        }
        return {
          kind: "managed",
          state: (yield* fileSystem.exists(path.join(cwd, "dirty.txt")).pipe(Effect.orDie))
            ? "dirty"
            : "clean",
        } as const;
      }),
    renameChatBranch: () => Effect.die("unexpected branch rename"),
    removeChat: ({ cwd, force }) =>
      Effect.gen(function* () {
        yield* hooks.beforeRemove?.(cwd) ?? Effect.void;
        if (!force && (yield* fileSystem.exists(path.join(cwd, "dirty.txt")).pipe(Effect.orDie))) {
          return { kind: "force-required" } as const;
        }
        yield* fileSystem.remove(cwd, { recursive: true }).pipe(Effect.orDie);
        return { kind: "removed" } as const;
      }),
  };
  const services = yield* Layer.build(
    ApplicationLayer.layer(git).pipe(
      Layer.provide(unusedSchedulesLayer),
      Layer.provideMerge(repositories),
      Layer.provide(runtime),
      Layer.provide(sessions),
      Layer.provide(BunCrypto.layer),
    ),
  );
  const application = Context.get(services, Application);
  const chats = Context.get(services, ChatRepository);
  const host = Context.get(services, Schedule.ScheduleRunHostFactory)(null);
  const workspace = yield* application.createWorkspace({
    name: "shared",
    platform: "web",
    externalId: null,
    defaultCwd: repository,
    worktree: { branch: "main", prefix: "chat/" },
  });
  const create = (sourceChatId: Chat.ChatId | null = null) =>
    application.createChat({
      workspaceId: workspace.id,
      externalId: null,
      modelOverride: null,
      sourceChatId,
    });
  const owner = yield* create();
  return {
    application,
    chats,
    host,
    workspace,
    owner,
    create,
    fileSystem,
    path,
    directory,
    sessionsDir,
    worktreesDir,
  };
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
          modelOverride: null,
          sourceChatId: null,
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
            history: () => Effect.die("unexpected history read"),
            previewHistory: () => Effect.die("unexpected history preview"),
            navigateHistory: () => Effect.die("unexpected history navigation"),
            availableModels: () => Effect.die("unexpected model catalog read"),
            discoverSkills: () => Effect.die("unexpected workspace skill command discovery"),
            switchModel: () => Effect.die("unexpected model switch"),
            events: Stream.empty,
            drain: () => Effect.void,
            transcript: () => Effect.die("unexpected transcript read"),
            resultSummary: () => Effect.die("unexpected chat results read"),
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
            availableSkills: () => Effect.die("unexpected skill command discovery"),
          }),
        );
        let worktreeChatId: Chat.ChatId | undefined;
        const git: GitWorktree = {
          validate: () => Effect.void,
          create: (options, use) => {
            worktreeChatId = options.chatId;
            return use(cwd);
          },
          inspectChat: () => Effect.succeed({ kind: "managed", state: "clean" }),
          slotCandidate: () =>
            Effect.succeed(
              worktreeChatId === undefined
                ? Option.none()
                : Option.some({ chatId: worktreeChatId, cwd }),
            ),
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
            modelOverride: null,
            sourceChatId: null,
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
            history: () => Effect.die("unexpected history read"),
            previewHistory: () => Effect.die("unexpected history preview"),
            navigateHistory: () => Effect.die("unexpected history navigation"),
            availableModels: () => Effect.die("unexpected model catalog read"),
            discoverSkills: () => Effect.die("unexpected workspace skill command discovery"),
            switchModel: () => Effect.die("unexpected model switch"),
            askBtw: () => Effect.die("unexpected side question"),
            events: Stream.empty,
            drain: () => Effect.void,
            transcript: () => Effect.succeed(runtimeTranscript),
            resultSummary: () => Effect.die("unexpected chat results read"),
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
            availableSkills: () => Effect.die("unexpected skill command discovery"),
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
        slotCandidate: () => Effect.succeed(Option.none()),
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
        const chat = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
          modelOverride: null,
          sourceChatId: null,
        });

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
        assert.deepStrictEqual(order, ["send-start", "runtime-close"]);

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
          history: () => Effect.die("unexpected history read"),
          previewHistory: () => Effect.die("unexpected history preview"),
          navigateHistory: () => Effect.die("unexpected history navigation"),
          availableModels: () => Effect.die("unexpected model catalog read"),
          discoverSkills: () => Effect.die("unexpected workspace skill command discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          events: Stream.empty,
          drain: () => Effect.void,
          transcript: () =>
            Effect.succeed({
              messages: [],
              contextUsage: { kind: "unavailable" },
              historyRevision: HistoryRevision.make("test-history"),
              todo: { kind: "ready", phases: [] },
              runtime: {
                publication: Publication.make(0),
                run: { kind: "idle" },
                assistant: [],
                tools: [],
              },
              currentModel: null,
            }),
          resultSummary: () => Effect.die("unexpected chat results read"),
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
          availableSkills: () => Effect.die("unexpected skill command discovery"),
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
      let worktreeChatId: Chat.ChatId | undefined;
      const gitWorktree: GitWorktree = {
        validate: () => Effect.void,
        create: (options, use) => {
          worktreeChatId = options.chatId;
          return use(defaultCwd);
        },
        inspectChat: () => Effect.succeed({ kind: "managed", state: "dirty" }),
        slotCandidate: () =>
          Effect.succeed(
            worktreeChatId === undefined
              ? Option.none()
              : Option.some({ chatId: worktreeChatId, cwd: defaultCwd }),
          ),
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
        const chat = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
          modelOverride: null,
          sourceChatId: null,
        });
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

  for (const first of ["owner", "peer"] as const) {
    it.effect(
      `retains dirty shared files when ${first} closes first and confirms the last close`,
      () =>
        Effect.gen(function* () {
          const { application, chats, owner, create, fileSystem, path } =
            yield* makeSharedCwdFixture();
          const peer = yield* create(owner.id);
          const dirtyFile = path.join(owner.cwd, "dirty.txt");
          yield* fileSystem.writeFileString(dirtyFile, "uncommitted work");
          const [closing, remaining] = first === "owner" ? [owner, peer] : [peer, owner];
          assert.deepStrictEqual(
            yield* application.closeChat(closing.id, { allowDirtyWorktree: false }),
            { kind: "closed" },
          );
          assert.deepStrictEqual(
            (yield* chats.listOpen()).map((chat) => chat.id),
            [remaining.id],
          );
          assert.strictEqual(yield* fileSystem.readFileString(dirtyFile), "uncommitted work");
          assert.deepStrictEqual(
            yield* application.closeChat(remaining.id, { allowDirtyWorktree: false }),
            { kind: "worktree-confirmation-required" },
          );
          assert.deepStrictEqual(
            (yield* chats.listOpen()).map((chat) => chat.id),
            [remaining.id],
          );
          assert.isTrue(yield* fileSystem.exists(owner.cwd));
          assert.deepStrictEqual(
            yield* application.closeChat(remaining.id, { allowDirtyWorktree: true }),
            { kind: "closed" },
          );
          assert.deepStrictEqual(yield* chats.listOpen(), []);
          assert.isFalse(yield* fileSystem.exists(owner.cwd));
        }).pipe(Effect.provide(platformLayer)),
    );
  }

  it.effect(
    "serializes concurrent closes through runtime release and removes only after both archive",
    () =>
      Effect.gen(function* () {
        const closingStarted = yield* Deferred.make<void>();
        const releaseClose = yield* Deferred.make<void>();
        let blockedId: Chat.ChatId | undefined;
        const { application, chats, owner, create, fileSystem } = yield* makeSharedCwdFixture({
          closeRuntime: (id) =>
            id === blockedId
              ? Deferred.succeed(closingStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseClose)),
                )
              : Effect.void,
        });
        const peer = yield* create(owner.id);
        blockedId = owner.id;
        const closingOwner = yield* application
          .closeChat(owner.id, { allowDirtyWorktree: false })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(closingStarted);
        const closingPeer = yield* application
          .closeChat(peer.id, { allowDirtyWorktree: false })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        assert.deepStrictEqual(
          (yield* chats.listOpen()).map((chat) => chat.id),
          [peer.id],
        );
        assert.isTrue(yield* fileSystem.exists(owner.cwd));
        yield* Deferred.succeed(releaseClose, undefined);
        assert.deepStrictEqual(yield* Fiber.join(closingOwner), { kind: "closed" });
        assert.deepStrictEqual(yield* Fiber.join(closingPeer), { kind: "closed" });
        assert.deepStrictEqual(yield* chats.listOpen(), []);
        assert.isFalse(yield* fileSystem.exists(owner.cwd));
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "lets source creation finish before a concurrent owner close can remove its directory",
    () =>
      Effect.gen(function* () {
        const creatingStarted = yield* Deferred.make<void>();
        const releaseCreate = yield* Deferred.make<void>();
        let pauseCreation = false;
        const { application, chats, owner, create, fileSystem } = yield* makeSharedCwdFixture({
          beforeSession: () =>
            pauseCreation
              ? Deferred.succeed(creatingStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCreate)),
                )
              : Effect.void,
        });
        pauseCreation = true;
        const creating = yield* create(owner.id).pipe(Effect.forkScoped);
        yield* Deferred.await(creatingStarted);
        const closing = yield* application
          .closeChat(owner.id, { allowDirtyWorktree: false })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        assert.deepStrictEqual(
          (yield* chats.listOpen()).map((chat) => chat.id),
          [owner.id],
        );
        assert.isTrue(yield* fileSystem.exists(owner.cwd));
        yield* Deferred.succeed(releaseCreate, undefined);
        const peer = yield* Fiber.join(creating);
        assert.strictEqual(peer.cwd, owner.cwd);
        assert.deepStrictEqual(yield* Fiber.join(closing), { kind: "closed" });
        assert.deepStrictEqual(
          (yield* chats.listOpen()).map((chat) => chat.id),
          [peer.id],
        );
        assert.isTrue(yield* fileSystem.exists(owner.cwd));
        assert.deepStrictEqual(
          yield* application.closeChat(peer.id, { allowDirtyWorktree: false }),
          { kind: "closed" },
        );
        assert.isFalse(yield* fileSystem.exists(owner.cwd));
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "rejects source, ordinary, and scheduled creation after an in-flight last close removes cwd",
    () =>
      Effect.gen(function* () {
        const closingStarted = yield* Deferred.make<void>();
        const releaseClose = yield* Deferred.make<void>();
        const { application, chats, host, owner, create, fileSystem, sessionsDir } =
          yield* makeSharedCwdFixture({
            closeRuntime: () =>
              Deferred.succeed(closingStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseClose)),
              ),
          });
        const direct = yield* application.createWorkspace({
          name: "direct shared",
          platform: "web",
          externalId: null,
          defaultCwd: owner.cwd,
          worktree: null,
        });
        const closing = yield* application
          .closeChat(owner.id, { allowDirtyWorktree: false })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(closingStarted);
        const sourced = yield* create(owner.id).pipe(
          Effect.flip,
          Effect.forkScoped({ startImmediately: true }),
        );
        const ordinary = yield* application
          .createChat({
            workspaceId: direct.id,
            externalId: null,
            modelOverride: null,
            sourceChatId: null,
          })
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        const scheduled = yield* host
          .materialize({
            destination: { kind: "workspace", workspaceId: direct.id, newChatId: missingChatId },
            title: "scheduled",
          })
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        assert.deepStrictEqual(yield* fileSystem.readDirectory(sessionsDir), [owner.id]);
        assert.isTrue(yield* fileSystem.exists(owner.cwd));
        yield* Deferred.succeed(releaseClose, undefined);
        assert.deepStrictEqual(yield* Fiber.join(closing), { kind: "closed" });
        assertApplicationError(yield* Fiber.join(sourced), "invalid-state");
        assertApplicationError(yield* Fiber.join(ordinary), "invalid-state");
        assert.instanceOf(yield* Fiber.join(scheduled), Schedule.ScheduleHostError);
        assert.deepStrictEqual(yield* chats.listOpen(), []);
        assert.isTrue(Option.isNone(yield* chats.findById(missingChatId)));
        assert.deepStrictEqual(yield* fileSystem.readDirectory(sessionsDir), [owner.id]);
        assert.isFalse(yield* fileSystem.exists(owner.cwd));
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "keeps failed runtime releases as blockers without prompting a dirty peer and allows archived retry",
    () =>
      Effect.gen(function* () {
        let failingId: Chat.ChatId | undefined;
        const { application, chats, owner, create, fileSystem, path } = yield* makeSharedCwdFixture(
          {
            closeRuntime: (id) =>
              id === failingId
                ? Effect.fail(new AgentError({ message: "dispose failed" }))
                : Effect.void,
          },
        );
        const peer = yield* create(owner.id);
        yield* fileSystem.writeFileString(path.join(owner.cwd, "dirty.txt"), "keep me");
        failingId = owner.id;
        assertApplicationError(
          yield* application.closeChat(owner.id, { allowDirtyWorktree: false }).pipe(Effect.flip),
          "operation",
        );
        const archivedAt = Option.getOrThrow(yield* chats.findById(owner.id)).archivedAt;
        assert.isNotNull(archivedAt);
        assert.deepStrictEqual(
          (yield* chats.listOpen()).map((chat) => chat.id),
          [peer.id],
        );
        assert.deepStrictEqual(
          yield* application.closeChat(peer.id, { allowDirtyWorktree: false }),
          { kind: "closed" },
        );
        assert.deepStrictEqual(yield* chats.listOpen(), []);
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(owner.cwd, "dirty.txt")),
          "keep me",
        );
        failingId = undefined;
        assert.deepStrictEqual(
          yield* application.closeChat(owner.id, { allowDirtyWorktree: true }),
          { kind: "closed" },
        );
        assert.strictEqual(
          Option.getOrThrow(yield* chats.findById(owner.id)).archivedAt,
          archivedAt,
        );
        assert.isFalse(yield* fileSystem.exists(owner.cwd));
      }).pipe(Effect.provide(platformLayer)),
  );

  for (const phase of ["archive", "runtime"] as const) {
    it.effect(
      `keeps an interrupted ${phase} release blocking peer deletion until the archived chat retries`,
      () =>
        Effect.gen(function* () {
          const paused = yield* Deferred.make<void>();
          let blockedId: Chat.ChatId | undefined;
          const pause = (id: Chat.ChatId) =>
            id === blockedId
              ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void;
          const { application, chats, owner, create, fileSystem } = yield* makeSharedCwdFixture(
            phase === "archive" ? { afterArchive: pause } : { closeRuntime: pause },
          );
          const peer = yield* create(owner.id);
          blockedId = owner.id;
          const closing = yield* application
            .closeChat(owner.id, { allowDirtyWorktree: false })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(paused);
          yield* Fiber.interrupt(closing);
          const result = yield* Fiber.await(closing);
          assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
          assert.isNotNull(Option.getOrThrow(yield* chats.findById(owner.id)).archivedAt);
          assert.deepStrictEqual(
            yield* application.closeChat(peer.id, { allowDirtyWorktree: false }),
            { kind: "closed" },
          );
          assert.deepStrictEqual(yield* chats.listOpen(), []);
          assert.isTrue(yield* fileSystem.exists(owner.cwd));
          blockedId = undefined;
          assert.deepStrictEqual(
            yield* application.closeChat(owner.id, { allowDirtyWorktree: false }),
            { kind: "closed" },
          );
          assert.isFalse(yield* fileSystem.exists(owner.cwd));
        }).pipe(Effect.provide(platformLayer)),
    );
  }

  it.effect(
    "keeps an interrupted operation drain blocking peers after runtime close succeeds",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const runtimeClosed = yield* Deferred.make<void>();
        const releaseOperation = yield* Deferred.make<void>();
        const { application, chats, host, owner, create, fileSystem } = yield* makeSharedCwdFixture(
          {
            closeRuntime: () => Deferred.succeed(runtimeClosed, undefined).pipe(Effect.asVoid),
            sendCaptured: (_id, runId) =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(releaseOperation)),
                Effect.as({
                  runId,
                  outcome: "aborted" as const,
                  events: [],
                  finalAssistantText: "",
                }),
              ),
          },
        );
        const peer = yield* create(owner.id);
        const running = yield* host
          .runPrompt(
            owner.id,
            Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003"),
            textPrompt("scheduled"),
            () => Effect.void,
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const closing = yield* application
          .closeChat(owner.id, { allowDirtyWorktree: false })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(runtimeClosed);
        yield* Fiber.interrupt(closing);
        const result = yield* Fiber.await(closing);
        assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
        assert.deepStrictEqual(
          yield* application.closeChat(peer.id, { allowDirtyWorktree: false }),
          { kind: "closed" },
        );
        assert.deepStrictEqual(yield* chats.listOpen(), []);
        assert.isTrue(yield* fileSystem.exists(owner.cwd));
        yield* Deferred.succeed(releaseOperation, undefined);
        assert.strictEqual((yield* Fiber.join(running)).outcome, "aborted");
        assert.deepStrictEqual(
          yield* application.closeChat(owner.id, { allowDirtyWorktree: false }),
          { kind: "closed" },
        );
        assert.isFalse(yield* fileSystem.exists(owner.cwd));
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "retains files that become dirty during removal and supports confirmed archived cleanup",
    () =>
      Effect.gen(function* () {
        const { application, chats, owner, fileSystem, path } = yield* makeSharedCwdFixture({
          beforeRemove: (cwd) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              yield* fs.writeFileString(`${cwd}/dirty.txt`, "late write").pipe(Effect.orDie);
            }).pipe(Effect.provide(platformLayer)),
        });
        assert.deepStrictEqual(
          yield* application.closeChat(owner.id, { allowDirtyWorktree: false }),
          { kind: "worktree-confirmation-required" },
        );
        assert.deepStrictEqual(yield* chats.listOpen(), []);
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(owner.cwd, "dirty.txt")),
          "late write",
        );
        assert.deepStrictEqual(
          yield* application.closeChat(owner.id, { allowDirtyWorktree: true }),
          { kind: "closed" },
        );
        assert.isFalse(yield* fileSystem.exists(owner.cwd));
      }).pipe(Effect.provide(platformLayer)),
  );

  for (const sourceState of ["missing", "closed", "missing-directory"] as const) {
    it.effect(`rejects a ${sourceState} source without new chats, sessions, or worktrees`, () =>
      Effect.gen(function* () {
        const { application, chats, owner, create, fileSystem, sessionsDir, worktreesDir } =
          yield* makeSharedCwdFixture();
        if (sourceState === "closed") {
          assert.deepStrictEqual(
            yield* application.closeChat(owner.id, { allowDirtyWorktree: false }),
            { kind: "closed" },
          );
        } else if (sourceState === "missing-directory") {
          yield* fileSystem.remove(owner.cwd, { recursive: true });
        }
        const openBefore = yield* chats.listOpen();
        const slotsBefore = yield* fileSystem.readDirectory(worktreesDir);
        assertApplicationError(
          yield* create(sourceState === "missing" ? missingChatId : owner.id).pipe(Effect.flip),
          "invalid-state",
        );
        assert.deepStrictEqual(yield* chats.listOpen(), openBefore);
        assert.deepStrictEqual(yield* fileSystem.readDirectory(sessionsDir), [owner.id]);
        assert.deepStrictEqual(yield* fileSystem.readDirectory(worktreesDir), slotsBefore);
      }).pipe(Effect.provide(platformLayer)),
    );
  }

  it.effect(
    "retains the source cwd after workspace edits and rejects failed peer persistence without deleting shared files",
    () =>
      Effect.gen(function* () {
        const {
          application,
          chats,
          workspace,
          owner,
          create,
          fileSystem,
          path,
          sessionsDir,
          worktreesDir,
        } = yield* makeSharedCwdFixture();
        yield* application.updateWorkspace({
          workspaceId: workspace.id,
          configuration: { kind: "direct", cwd: workspace.defaultCwd },
        });
        const peer = yield* create(owner.id);
        assert.strictEqual(peer.cwd, owner.cwd);
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(sessionsDir, peer.id)),
          owner.cwd,
        );
        const source = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: "duplicate",
          modelOverride: null,
          sourceChatId: owner.id,
        });
        const before = yield* chats.listOpen();
        assertApplicationError(
          yield* application
            .createChat({
              workspaceId: workspace.id,
              externalId: "duplicate",
              modelOverride: null,
              sourceChatId: owner.id,
            })
            .pipe(Effect.flip),
          "operation",
        );
        assert.deepStrictEqual(yield* chats.listOpen(), before);
        assert.deepStrictEqual(
          (yield* fileSystem.readDirectory(sessionsDir)).sort(),
          [owner.id, peer.id, source.id].sort(),
        );
        assert.deepStrictEqual(yield* fileSystem.readDirectory(worktreesDir), [owner.id]);
        assert.isTrue(yield* fileSystem.exists(owner.cwd));
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("counts a different workspace's open cwd reference until its final close", () =>
    Effect.gen(function* () {
      const { application, chats, owner, fileSystem } = yield* makeSharedCwdFixture();
      const workspace = yield* application.createWorkspace({
        name: "another workspace",
        platform: "web",
        externalId: null,
        defaultCwd: owner.cwd,
        worktree: null,
      });
      const peer = yield* application.createChat({
        workspaceId: workspace.id,
        externalId: null,
        modelOverride: null,
        sourceChatId: null,
      });
      assert.deepStrictEqual(
        yield* application.closeChat(owner.id, { allowDirtyWorktree: false }),
        { kind: "closed" },
      );
      assert.deepStrictEqual(
        (yield* chats.listOpen()).map((chat) => chat.id),
        [peer.id],
      );
      assert.isTrue(yield* fileSystem.exists(owner.cwd));
      assert.deepStrictEqual(yield* application.closeChat(peer.id, { allowDirtyWorktree: false }), {
        kind: "closed",
      });
      assert.deepStrictEqual(yield* chats.listOpen(), []);
      assert.isFalse(yield* fileSystem.exists(owner.cwd));
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "counts a symlink alias as an open reference without granting that alias deletion authority",
    () =>
      Effect.gen(function* () {
        const { application, chats, owner, fileSystem, path, directory } =
          yield* makeSharedCwdFixture();
        const alias = AbsolutePath.make(path.join(directory, "alias"));
        yield* fileSystem.symlink(owner.cwd, alias);
        const workspace = yield* application.createWorkspace({
          name: "alias workspace",
          platform: "web",
          externalId: null,
          defaultCwd: alias,
          worktree: null,
        });
        const peer = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
          modelOverride: null,
          sourceChatId: null,
        });
        assert.strictEqual(peer.cwd, alias);
        assert.deepStrictEqual(
          yield* application.closeChat(owner.id, { allowDirtyWorktree: false }),
          { kind: "closed" },
        );
        assert.deepStrictEqual(
          (yield* chats.listOpen()).map((chat) => chat.id),
          [peer.id],
        );
        assert.isTrue(yield* fileSystem.exists(owner.cwd));
        assert.deepStrictEqual(
          yield* application.closeChat(peer.id, { allowDirtyWorktree: false }),
          { kind: "closed" },
        );
        assert.deepStrictEqual(yield* chats.listOpen(), []);
        assert.isTrue(yield* fileSystem.exists(owner.cwd));
        assert.deepStrictEqual(
          yield* application.closeChat(owner.id, { allowDirtyWorktree: false }),
          { kind: "closed" },
        );
        assert.isFalse(yield* fileSystem.exists(owner.cwd));
      }).pipe(Effect.provide(platformLayer)),
  );
});
