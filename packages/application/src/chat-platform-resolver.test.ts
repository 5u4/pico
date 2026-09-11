import { assert, describe, it } from "@effect/vitest";
import * as Chat from "@pico/contract/chat-model";
import { ChatPlatformResolver } from "@pico/contract/chat-platform-resolver";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AgentError, PersistenceError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ApplicationLayer from "./application.ts";

const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");
const missingWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000002");
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000003");
const secondChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000004");
const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000005");
const cwd = AbsolutePath.make("/tmp/pico-chat-platform-resolver");

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

const chatLayer = (findById: ChatRepository["Service"]["findById"]) =>
  Layer.succeed(
    ChatRepository,
    ChatRepository.of({
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
      create: () => Effect.die("unexpected workspace create"),
      findById,
      findByBinding: () => Effect.die("unexpected workspace binding lookup"),
      replaceConfiguration: () => Effect.die("unexpected workspace replacement"),
    }),
  );

const resolve = (
  id: Chat.ChatId,
  chats: Layer.Layer<ChatRepository>,
  workspaces: Layer.Layer<WorkspaceRepository>,
) =>
  Effect.gen(function* () {
    return yield* (yield* ChatPlatformResolver).resolve(id);
  }).pipe(
    Effect.provide(ApplicationLayer.chatPlatformResolverLayer),
    Effect.provide(Layer.merge(chats, workspaces)),
  );

const assertAgentError = (error: AgentError, message: string) => {
  assert.instanceOf(error, AgentError);
  assert.strictEqual(error.message, message);
};

describe("ChatPlatformResolver", () => {
  it.effect("returns the Discord platform for a Discord workspace", () => {
    const chat = makeChat(chatId, workspaceId, "thread-1");
    const workspace = makeWorkspace(workspaceId, {
      platform: "discord",
      externalId: "channel-1",
    });

    return Effect.gen(function* () {
      const resolved = yield* resolve(
        chatId,
        chatLayer(() => Effect.succeed(Option.some(chat))),
        workspaceLayer(() => Effect.succeed(Option.some(workspace))),
      );

      assert.strictEqual(resolved.chat, chat);
      assert.strictEqual(resolved.platform, "discord");
    });
  });

  it.effect("returns null for unbound direct and scheduled chats", () => {
    const directChat = makeChat(chatId, workspaceId, null);
    const scheduledChat = makeChat(secondChatId, workspaceId, "scheduled-chat");
    const workspace = makeWorkspace(workspaceId, null);
    const repositories = Layer.merge(
      chatLayer((id) =>
        Effect.succeed(
          id === chatId
            ? Option.some(directChat)
            : id === secondChatId
              ? Option.some(scheduledChat)
              : Option.none(),
        ),
      ),
      workspaceLayer(() => Effect.succeed(Option.some(workspace))),
    );

    return Effect.gen(function* () {
      const resolver = yield* ChatPlatformResolver;
      const direct = yield* resolver.resolve(chatId);
      const scheduled = yield* resolver.resolve(secondChatId);

      assert.strictEqual(direct.chat, directChat);
      assert.strictEqual(scheduled.chat, scheduledChat);
      assert.strictEqual(direct.platform, null);
      assert.strictEqual(scheduled.platform, null);
    }).pipe(
      Effect.provide(ApplicationLayer.chatPlatformResolverLayer),
      Effect.provide(repositories),
    );
  });

  it.effect("fails when the chat is missing", () =>
    Effect.gen(function* () {
      const error = yield* resolve(
        missingChatId,
        chatLayer(() => Effect.succeed(Option.none())),
        workspaceLayer(() => Effect.die("unexpected workspace lookup")),
      ).pipe(Effect.flip);

      assertAgentError(error, "Chat not found");
    }),
  );

  it.effect("fails when the chat workspace is missing", () => {
    const chat = makeChat(chatId, missingWorkspaceId, null);
    return Effect.gen(function* () {
      const error = yield* resolve(
        chatId,
        chatLayer(() => Effect.succeed(Option.some(chat))),
        workspaceLayer(() => Effect.succeed(Option.none())),
      ).pipe(Effect.flip);

      assertAgentError(error, "Chat workspace not found");
    });
  });

  it.effect("maps chat repository failures to AgentError", () =>
    Effect.gen(function* () {
      const error = yield* resolve(
        chatId,
        chatLayer(() =>
          Effect.fail(new PersistenceError({ message: "chat database unavailable" })),
        ),
        workspaceLayer(() => Effect.die("unexpected workspace lookup")),
      ).pipe(Effect.flip);

      assertAgentError(error, "Failed to resolve chat: chat database unavailable");
    }),
  );

  it.effect("maps workspace repository failures to AgentError", () => {
    const chat = makeChat(chatId, workspaceId, null);
    return Effect.gen(function* () {
      const error = yield* resolve(
        chatId,
        chatLayer(() => Effect.succeed(Option.some(chat))),
        workspaceLayer(() =>
          Effect.fail(new PersistenceError({ message: "workspace database unavailable" })),
        ),
      ).pipe(Effect.flip);

      assertAgentError(error, "Failed to resolve chat workspace: workspace database unavailable");
    });
  });
});
