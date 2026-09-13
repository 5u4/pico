import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as Instructions from "@pico/config/instructions";
import { BotSessions } from "@pico/contract/bot-session";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import { PicoRoot } from "@pico/contract/config";
import { AgentError, PersistenceError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Persistence from "@pico/persistence/layer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SessionContext from "./session-context.ts";

const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");
const missingWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000002");
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000003");
const secondChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000004");
const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000005");
const cwd = AbsolutePath.make("/tmp/pico-chat-session-context");
const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const makeChat = (
  id: Chat.ChatId,
  owningWorkspaceId: Workspace.WorkspaceId,
  externalId: string | null,
): Chat.Chat => ({
  id,
  workspaceId: owningWorkspaceId,
  cwd,
  externalId,
  createdAt: 1,
  archivedAt: null,
});

const makeWorkspace = (
  id: Workspace.WorkspaceId,
  binding: Workspace.WorkspaceBinding | null,
): Workspace.Workspace => ({
  id,
  name: "workspace",
  binding,
  defaultCwd: cwd,
  worktree: null,
  createdAt: 1,
});

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = PicoRoot.make(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-session-context-" }),
  );
  const instructions = yield* Instructions.make(root);
  const put = Effect.fn("ChatSessionContextTest.put")(function* (relative: string, source: string) {
    const target = path.join(root, "agents", relative);
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    yield* fileSystem.writeFileString(target, source);
    return target;
  });
  return {
    instructions,
    put,
    fileSystem,
    path,
    root,
    repositories: Persistence.layer(AbsolutePath.make(path.join(root, "store.db"))),
  };
});

const chatLayer = (findById: ChatRepository["Service"]["findById"]) =>
  Layer.succeed(
    ChatRepository,
    ChatRepository.of({
      listOpenByWorkspace: () => Effect.die("unexpected open chat list"),
      create: () => Effect.die("unexpected chat create"),
      archive: () => Effect.die("unexpected chat archive"),
      findById,
      findByExternalId: () => Effect.die("unexpected external chat lookup"),
    }),
  );

const workspaceLayer = (findById: WorkspaceRepository["Service"]["findById"]) =>
  Layer.succeed(
    WorkspaceRepository,
    WorkspaceRepository.of({
      list: () => Effect.die("unexpected workspace list"),
      create: () => Effect.die("unexpected workspace create"),
      getOrCreateByBinding: () => Effect.die("unexpected bound workspace creation"),
      findById,
      findByBinding: () => Effect.die("unexpected workspace binding lookup"),
      replaceConfiguration: () => Effect.die("unexpected workspace replacement"),
    }),
  );

const botSessionsLayer = Layer.succeed(
  BotSessions,
  BotSessions.of({
    findByRoot: () => Effect.succeed(Option.none()),
    findByChat: () => Effect.succeed(Option.none()),
    findByWorkspace: () => Effect.succeed(Option.none()),
    createConversation: () => Effect.die("unexpected bot conversation creation"),
    setTurn: () => Effect.die("unexpected bot turn update"),
    saveHandoff: () => Effect.die("unexpected bot handoff write"),
    readHandoff: () => Effect.die("unexpected bot handoff read"),
    rotate: () => Effect.die("unexpected bot rotation"),
  }),
);

const resolve = Effect.fn("ChatSessionContextTest.resolve")(function* (
  id: Chat.ChatId,
  chats: Layer.Layer<ChatRepository>,
  workspaces: Layer.Layer<WorkspaceRepository>,
) {
  const { instructions } = yield* fixture;
  return yield* Effect.gen(function* () {
    return yield* (yield* ChatSessionContext).resolve(id);
  }).pipe(
    Effect.provide(SessionContext.layer({ instructions, discordBotId: null })),
    Effect.provide(Layer.merge(chats, workspaces)),
    Effect.provide(botSessionsLayer),
  );
});

describe("ChatSessionContext", () => {
  it.effect(
    "uses persisted parent-channel instructions for direct and threadless scheduled chats",
    () =>
      Effect.gen(function* () {
        const { instructions, put, repositories } = yield* fixture;
        yield* put("instructions.md", "GLOBAL_CONVENTION");
        yield* put("discord/bots/123/instructions.md", "BOT_CONVENTION");
        yield* put("discord/channels/456/instructions.md", "CHANNEL_CONVENTION");
        yield* put("discord/channels/789/instructions.md", "WRONG_THREAD_CONVENTION");
        const context = SessionContext.layer({
          instructions,
          discordBotId: Effect.succeed("123"),
        }).pipe(Layer.provideMerge(repositories));

        yield* Effect.gen(function* () {
          const workspaces = yield* WorkspaceRepository;
          const chats = yield* ChatRepository;
          const resolver = yield* ChatSessionContext;
          yield* workspaces.create(
            makeWorkspace(workspaceId, { platform: "discord", externalId: "456" }),
          );
          yield* chats.create(makeChat(chatId, workspaceId, "789"));
          yield* chats.create(makeChat(secondChatId, workspaceId, null));
          const direct = yield* resolver.resolve(chatId);
          const scheduled = yield* resolver.resolve(secondChatId);
          assert.strictEqual(direct.platform, "discord");
          assert.strictEqual(scheduled.appendSystemPrompt, direct.appendSystemPrompt);
          assert.include(direct.appendSystemPrompt, "GLOBAL_CONVENTION");
          assert.include(direct.appendSystemPrompt, "BOT_CONVENTION");
          assert.include(direct.appendSystemPrompt, "CHANNEL_CONVENTION");
          assert.notInclude(direct.appendSystemPrompt, "WRONG_THREAD_CONVENTION");
          assert.isBelow(
            direct.appendSystemPrompt.indexOf("GLOBAL_CONVENTION"),
            direct.appendSystemPrompt.indexOf("BOT_CONVENTION"),
          );
          assert.isBelow(
            direct.appendSystemPrompt.indexOf("BOT_CONVENTION"),
            direct.appendSystemPrompt.indexOf("CHANNEL_CONVENTION"),
          );

          yield* put("discord/channels/456/instructions.md", "UPDATED_CHANNEL_CONVENTION");
          assert.include(
            (yield* resolver.resolve(chatId)).appendSystemPrompt,
            "UPDATED_CHANNEL_CONVENTION",
          );
        }).pipe(Effect.provide(context));
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "builds before authentication, keeps global independent, and resolves Discord after READY",
    () =>
      Effect.gen(function* () {
        const { instructions, put, repositories } = yield* fixture;
        yield* put("instructions.md", "GLOBAL_ONLY");
        yield* put("discord/bots/123/instructions.md", "AUTHENTICATED_BOT");
        yield* put("discord/channels/456/instructions.md", "CHANNEL_ONLY");
        const authenticated = yield* Deferred.make<string>();
        const discordBotId = Effect.gen(function* () {
          const ready = yield* Deferred.poll(authenticated);
          if (Option.isNone(ready)) {
            return yield* new AgentError({ message: "Discord is not authenticated" });
          }
          return yield* ready.value;
        });
        const context = SessionContext.layer({ instructions, discordBotId }).pipe(
          Layer.provideMerge(repositories),
        );
        yield* Effect.gen(function* () {
          const workspaces = yield* WorkspaceRepository;
          const chats = yield* ChatRepository;
          const resolver = yield* ChatSessionContext;
          yield* workspaces.create(makeWorkspace(workspaceId, null));
          yield* workspaces.create(
            makeWorkspace(missingWorkspaceId, { platform: "discord", externalId: "456" }),
          );
          yield* chats.create(makeChat(chatId, workspaceId, "456"));
          yield* chats.create(makeChat(secondChatId, missingWorkspaceId, null));
          const global = yield* resolver.resolve(chatId);
          assert.strictEqual(global.platform, null);
          assert.include(global.appendSystemPrompt, "GLOBAL_ONLY");
          assert.notInclude(global.appendSystemPrompt, "CHANNEL_ONLY");
          assert.notInclude(global.appendSystemPrompt, "AUTHENTICATED_BOT");
          const pending = yield* resolver.resolve(secondChatId).pipe(Effect.flip);
          assert.instanceOf(pending, AgentError);
          assert.include(pending.message, "not authenticated");

          yield* Deferred.succeed(authenticated, "123");
          const ready = yield* resolver.resolve(secondChatId);
          assert.include(ready.appendSystemPrompt, "AUTHENTICATED_BOT");
          assert.include(ready.appendSystemPrompt, "CHANNEL_ONLY");
        }).pipe(Effect.provide(context));
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("loads global and channel when Discord is disabled and retains read diagnostics", () =>
    Effect.gen(function* () {
      const { instructions, put, repositories, fileSystem } = yield* fixture;
      yield* put("instructions.md", "GLOBAL_WITHOUT_BOT");
      yield* put("discord/bots/123/instructions.md", "UNAVAILABLE_BOT");
      const channelFile = yield* put("discord/channels/456/instructions.md", "BOUND_CHANNEL");
      const context = SessionContext.layer({ instructions, discordBotId: null }).pipe(
        Layer.provideMerge(repositories),
      );
      yield* Effect.gen(function* () {
        const workspaces = yield* WorkspaceRepository;
        const chats = yield* ChatRepository;
        const resolver = yield* ChatSessionContext;
        yield* workspaces.create(
          makeWorkspace(workspaceId, { platform: "discord", externalId: "456" }),
        );
        yield* chats.create(makeChat(chatId, workspaceId, null));
        const resolved = yield* resolver.resolve(chatId);
        assert.include(resolved.appendSystemPrompt, "GLOBAL_WITHOUT_BOT");
        assert.include(resolved.appendSystemPrompt, "BOUND_CHANNEL");
        assert.notInclude(resolved.appendSystemPrompt, "UNAVAILABLE_BOT");

        yield* fileSystem.remove(channelFile);
        yield* fileSystem.makeDirectory(channelFile);
        const error = yield* resolver.resolve(chatId).pipe(Effect.flip);
        const cause = yield* fileSystem.readFileString(channelFile).pipe(Effect.flip);
        assert.instanceOf(error, AgentError);
        assert.notInclude(error.message, channelFile);
        assert.include(error.message, cause.reason._tag);
      }).pipe(Effect.provide(context));
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("fails when the chat or its owning workspace is missing", () =>
    Effect.gen(function* () {
      const missingChat = yield* resolve(
        missingChatId,
        chatLayer(() => Effect.succeed(Option.none())),
        workspaceLayer(() => Effect.die("unexpected workspace lookup")),
      ).pipe(Effect.flip);
      assert.instanceOf(missingChat, AgentError);
      const missingWorkspace = yield* resolve(
        chatId,
        chatLayer(() => Effect.succeed(Option.some(makeChat(chatId, missingWorkspaceId, null)))),
        workspaceLayer(() => Effect.succeed(Option.none())),
      ).pipe(Effect.flip);
      assert.instanceOf(missingWorkspace, AgentError);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("retains repository failure details", () =>
    Effect.gen(function* () {
      const chatError = yield* resolve(
        chatId,
        chatLayer(() =>
          Effect.fail(new PersistenceError({ message: "chat database unavailable" })),
        ),
        workspaceLayer(() => Effect.die("unexpected workspace lookup")),
      ).pipe(Effect.flip);
      assert.instanceOf(chatError, AgentError);
      assert.include(chatError.message, "chat database unavailable");
      const workspaceError = yield* resolve(
        chatId,
        chatLayer(() => Effect.succeed(Option.some(makeChat(chatId, workspaceId, null)))),
        workspaceLayer(() =>
          Effect.fail(new PersistenceError({ message: "workspace database unavailable" })),
        ),
      ).pipe(Effect.flip);
      assert.instanceOf(workspaceError, AgentError);
      assert.include(workspaceError.message, "workspace database unavailable");
    }).pipe(Effect.provide(platformLayer)),
  );
});
