import type * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import { AgentError } from "@pico/contract/errors";
import type { InstructionsReader, InstructionsScope } from "@pico/contract/instructions";
import type * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

interface Options {
  readonly instructions: InstructionsReader;
  readonly discordBotId: Effect.Effect<string, AgentError> | null;
}

const make = Effect.fn("ChatSessionContext.make")(function* (options: Options) {
  const chats = yield* ChatRepository;
  const workspaces = yield* WorkspaceRepository;
  return ChatSessionContext.of({
    resolve: (chatId) => resolve(chats, workspaces, options, chatId),
  });
});

// Daemon installs this before opening live sessions through OMP.
export const layer = (options: Options) => Layer.effect(ChatSessionContext, make(options));

const platformPrompts = {
  discord:
    "You are pico, a personal agent assistant. You are chatting with the user through Discord.",
  web: "You are pico, a personal agent assistant. You are chatting with the user through Pico Web.",
} satisfies Record<Workspace.WorkspacePlatform | "web", string>;

const instructionsGuidance =
  "Apply the following instructions from general to specific. More-specific instructions take precedence, but do not override higher-level safety requirements.";

const resolve = Effect.fn("ChatSessionContext.resolve")(function* (
  chats: ChatRepository["Service"],
  workspaces: WorkspaceRepository["Service"],
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

  const binding = maybeWorkspace.value.binding;
  const platform = binding?.platform ?? null;
  const scope: InstructionsScope =
    binding === null
      ? { kind: "global" }
      : {
          kind: "discord",
          botId: discordBotId === null ? null : yield* discordBotId,
          channelId: binding.externalId,
        };
  const instructionsText = yield* instructions(scope).pipe(
    Effect.mapError((cause) => new AgentError({ message: cause.message })),
  );
  const platformPrompt = platformPrompts[platform ?? "web"];

  return {
    chat,
    platform,
    appendSystemPrompt:
      instructionsText.length === 0
        ? platformPrompt
        : `${platformPrompt}\n\n${instructionsGuidance}\n\n${instructionsText}`,
  };
});

const repositoryError = (message: string) => (cause: { readonly message: string }) =>
  new AgentError({ message: `${message}: ${cause.message}` });
