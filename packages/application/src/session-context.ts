/// <reference path="./markdown.d.ts" />
import { BotSessions } from "@pico/contract/bot-session";
import type * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import { AgentError } from "@pico/contract/errors";
import type { InstructionsReader, InstructionsScope } from "@pico/contract/instructions";
import type { ReplyTarget } from "@pico/contract/reply-target";
import type * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import persona from "./persona.md" with { type: "text" };

interface Options {
  readonly instructions: InstructionsReader;
  readonly discordBotId: Effect.Effect<string, AgentError> | null;
}

const make = Effect.fn("ChatSessionContext.make")(function* (options: Options) {
  const chats = yield* ChatRepository;
  const workspaces = yield* WorkspaceRepository;
  const bots = yield* BotSessions;
  return ChatSessionContext.of({
    resolve: (chatId) => resolve(chats, workspaces, bots, options, chatId),
  });
});

// Daemon installs this before opening live sessions through OMP.
export const layer = (options: Options) => Layer.effect(ChatSessionContext, make(options));

const personaPrompt = persona.trim();
const platformPrompts = {
  discord: "You are chatting with the user through Discord.",
  web: "You are chatting with the user through Pico Web.",
} satisfies Record<Workspace.WorkspacePlatform | "web", string>;

const instructionsGuidance =
  "Apply the following instructions from general to specific. More-specific instructions take precedence, but do not override higher-level safety requirements.";

const resolve = Effect.fn("ChatSessionContext.resolve")(function* (
  chats: ChatRepository["Service"],
  workspaces: WorkspaceRepository["Service"],
  bots: BotSessions["Service"],
  { instructions, discordBotId }: Options,
  chatId: Chat.ChatId,
) {
  const maybeChat = yield* chats
    .findById(chatId)
    .pipe(Effect.mapError(repositoryError("Failed to resolve chat")));
  if (Option.isNone(maybeChat)) {
    return yield* new AgentError({ message: "Chat not found" });
  }

  const chat = maybeChat.value;
  const maybeWorkspace = yield* workspaces
    .findById(chat.workspaceId)
    .pipe(Effect.mapError(repositoryError("Failed to resolve chat workspace")));
  if (Option.isNone(maybeWorkspace)) {
    return yield* new AgentError({ message: "Chat workspace not found" });
  }

  const bot = yield* bots
    .findByChat(chatId)
    .pipe(Effect.mapError(repositoryError("Failed to resolve bot session")));
  const binding = maybeWorkspace.value.binding;
  const platform = Option.isSome(bot) ? bot.value.platform : (binding?.platform ?? null);
  const scope: InstructionsScope = Option.isSome(bot)
    ? { kind: "bot", botRoot: bot.value.botRoot }
    : binding === null
      ? { kind: "global" }
      : {
          kind: "discord",
          botId: discordBotId === null ? null : yield* discordBotId,
          channelId: binding.externalId,
        };
  const instructionsText = yield* instructions(scope).pipe(
    Effect.mapError((cause) => new AgentError({ message: cause.message })),
  );
  const identity = JSON.stringify({
    workspaceId: chat.workspaceId,
    chatId: chat.id,
    ...(binding?.platform === "discord"
      ? {
          discord: {
            channelId: binding.externalId,
            ...(chat.externalId === null ? {} : { threadId: chat.externalId }),
            ...(binding.guildId === undefined ? {} : { guildId: binding.guildId }),
          },
        }
      : {}),
  });
  const platformPrompt =
    Option.isSome(bot) && platform === null ? "" : `\n\n${platformPrompts[platform ?? "web"]}`;
  const basePrompt = `${personaPrompt}${platformPrompt}\n\nChat context\n${identity}`;

  return {
    chat,
    platform,
    appendSystemPrompt:
      instructionsText.length === 0
        ? basePrompt
        : `${basePrompt}\n\n${instructionsGuidance}\n\n${instructionsText}`,
    formatTurnContext:
      Option.isSome(bot) && platform === "discord" ? formatDiscordTurnContext : null,
  };
});

const formatDiscordTurnContext = (target: ReplyTarget | undefined) =>
  target?.platform === "discord"
    ? `Current captured Discord reply context\n${JSON.stringify({
        discord: { replyChannelId: target.conversationId },
      })}`
    : undefined;

const repositoryError = (message: string) => (cause: { readonly message: string }) =>
  new AgentError({ message: `${message}: ${cause.message}` });
