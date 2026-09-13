import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as AgentMessage from "@pico/contract/agent-message";
import { AgentRuntime } from "@pico/contract/agent-runtime";
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ApplicationLayer from "./application.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000098");

const textPrompt = (text: string) => AgentMessage.AgentPrompt.make({ text, attachments: [] });

const runtimeTranscript: AgentMessage.AgentTranscript = [
  {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: 7,
  },
];

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

describe("Chat close", () => {
  it.effect(
    "admits normal input during a side question and cancels the side before chat disposal",
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
        const sent: string[] = [];
        const order: string[] = [];
        const runtime = Layer.succeed(
          AgentRuntime,
          AgentRuntime.of({
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
            sendTurn: () => Effect.die("unexpected bot turn"),
            rotate: () => Effect.die("unexpected bot rotation"),
            deliver: () => Effect.die("unexpected delivery"),
            publish: () => Effect.die("unexpected publication"),
            close: () =>
              Effect.sync(() => {
                order.push("runtime-close");
              }),
            abort: () => Effect.die("unexpected main abort"),
            contextUsage: () => Effect.die("unexpected context read"),
            shake: () => Effect.die("unexpected shake"),
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
            binding: null,
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
          yield* application.sendMessage(chat.id, textPrompt("later"));
          assert.deepStrictEqual(sent, ["main", "later"]);
          yield* Deferred.succeed(mainFinished, undefined);
          const closing = yield* application
            .closeChat(chat.id, { allowDirtyWorktree: false })
            .pipe(Effect.forkChild);
          yield* Deferred.await(cleaning);
          assert.deepStrictEqual(order, []);
          yield* Deferred.succeed(releaseCleanup, undefined);
          assert.deepStrictEqual(yield* Fiber.join(closing), { kind: "closed" });
          const result = yield* Fiber.join(aside);
          assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
          assert.deepStrictEqual(order, ["side-settled", "runtime-close", "worktree-remove"]);
          assert.instanceOf(
            yield* application.askBtw(chat.id, "closed").pipe(Effect.flip),
            ChatClosed,
          );
        }).pipe(
          Effect.ensuring(Deferred.succeed(releaseCleanup, undefined)),
          Effect.provide(ApplicationLayer.layer(git)),
          Effect.provide(persistence),
          Effect.provide(runtime),
          Effect.provide(
            Layer.succeed(
              AgentSessionStore,
              AgentSessionStore.of({
                create: () => Effect.void,
                remove: () => Effect.void,
                createPhysical: () => Effect.die("unexpected physical session creation"),
                removePhysical: () => Effect.die("unexpected physical session removal"),
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
            sendTurn: () => Effect.die("unexpected bot turn"),
            rotate: () => Effect.die("unexpected bot rotation"),
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
          remove: () => Effect.void,
          createPhysical: () => Effect.die("unexpected physical session creation"),
          removePhysical: () => Effect.die("unexpected physical session removal"),
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
        const scheduleHost = yield* Schedule.ScheduleRunHostService;
        yield* TestClock.setTime(1_000);
        const workspace = yield* application.createWorkspace({
          name: "close",
          binding: null,
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
        Effect.provide(ApplicationLayer.layer(gitWorktree)),
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
          askBtw: () => Effect.die("unexpected side question"),
          events: Stream.empty,
          drain: () => Effect.void,
          transcript: () => Effect.succeed([]),
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
          sendTurn: () => Effect.die("unexpected bot turn"),
          rotate: () => Effect.die("unexpected bot rotation"),
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
          remove: () => Effect.void,
          createPhysical: () => Effect.die("unexpected physical session creation"),
          removePhysical: () => Effect.die("unexpected physical session removal"),
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
        const host = yield* Schedule.ScheduleRunHostService;
        const chats = yield* ChatRepository;
        const workspace = yield* application.createWorkspace({
          name: "scheduled-close",
          binding: null,
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
        Effect.provide(ApplicationLayer.layer(gitWorktree)),
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
            askBtw: () => Effect.die("unexpected side question"),
            events: Stream.empty,
            drain: () => Effect.void,
            transcript: () => Effect.succeed([]),
            send: () => Effect.die("unexpected send"),
            sendCaptured: () => Effect.die("unexpected captured runtime send"),
            sendTurn: () => Effect.die("unexpected bot turn"),
            rotate: () => Effect.die("unexpected bot rotation"),
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
          remove: () => Effect.void,
          createPhysical: () => Effect.die("unexpected physical session creation"),
          removePhysical: () => Effect.die("unexpected physical session removal"),
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
          binding: null,
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
        Effect.provide(ApplicationLayer.layer(gitWorktree)),
        Effect.provide(persistenceLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(sessionsLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );
});
