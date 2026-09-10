import type { DiscordConfig } from "@pico/config/config";
import type { ContextUsage, ShakeResult } from "@pico/contract/agent-runtime";
import { Application, type CloseChatResult } from "@pico/contract/application";
import type * as Chat from "@pico/contract/chat-model";
import type { WorkspaceBindingInvalid } from "@pico/contract/errors";
import type * as Workspace from "@pico/contract/workspace-model";
import {
  ButtonStyles,
  ChannelTypes,
  type InteractionCallbackData,
  InteractionTypes,
  type MessageComponents,
  MessageComponentTypes,
} from "discordeno";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as DiscordCommand from "./discord-command.ts";

class DiscordError extends Schema.TaggedError<DiscordError>()("DiscordError", {
  message: Schema.String,
}) {}

export const discordError = (message: string, cause: unknown) =>
  new DiscordError({
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });

export const promiseBoundary = <A>(message: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => discordError(message, cause),
  });

export interface DiscordMessage {
  readonly guildId?: bigint;
  readonly webhookId?: bigint;
  readonly author: { readonly id: bigint };
  readonly channelId: bigint;
  readonly id: bigint;
  readonly content: string;
  readonly attachments?: { readonly length: number };
}

export interface DiscordChannel {
  readonly id: bigint;
  readonly guildId?: bigint;
  readonly type: ChannelTypes;
  readonly parentId?: bigint;
  readonly name?: string;
}

export interface DiscordInteraction {
  readonly type: InteractionTypes;
  readonly guildId?: bigint;
  readonly channelId?: bigint;
  readonly user?: { readonly id: bigint };
  readonly message?: { readonly id: bigint; readonly channelId: bigint };
  readonly data?: {
    readonly name?: string;
    readonly customId?: string;
    readonly options?: ReadonlyArray<DiscordCommand.CommandOption>;
  };
  readonly defer: (isPrivate?: boolean) => Promise<unknown>;
  readonly deferEdit: () => Promise<unknown>;
  readonly edit: (options: InteractionCallbackData) => Promise<unknown>;
}

export interface DiscordInputBot<
  Message extends DiscordMessage = DiscordMessage,
  Interaction extends DiscordInteraction = DiscordInteraction,
> {
  readonly id: bigint;
  readonly events: {
    messageCreate?: (message: Message) => unknown;
    interactionCreate?: (interaction: Interaction) => unknown;
  };
  readonly helpers: {
    readonly getChannel: (channelId: bigint) => Promise<DiscordChannel>;
    readonly sendMessage: (
      channelId: bigint,
      options: {
        readonly content: string;
        readonly allowedMentions: { readonly parse: []; readonly repliedUser: false };
      },
    ) => Promise<unknown>;
    readonly editChannel: (
      channelId: bigint,
      options: { readonly archived: true; readonly locked: true },
    ) => Promise<unknown>;
    readonly startThreadWithMessage: (
      channelId: bigint,
      messageId: bigint,
      options: { readonly name: string; readonly autoArchiveDuration: 1_440 },
    ) => Promise<{ readonly id: bigint }>;
  };
}

const isThread = (type: ChannelTypes) =>
  type === ChannelTypes.AnnouncementThread ||
  type === ChannelTypes.PublicThread ||
  type === ChannelTypes.PrivateThread;

interface CommandThread {
  readonly guildId: bigint;
  readonly parentId: bigint;
  readonly threadId: bigint;
}

const threadName = (content: string) => content.trim().replace(/\s+/g, " ").slice(0, 100);

interface CloseConfirmation {
  readonly chatId: Chat.ChatId;
  readonly guildId: bigint;
  readonly threadId: bigint;
  readonly requesterId: bigint;
  readonly expiresAt: number;
}

interface ComponentResponse {
  readonly content: string;
  readonly components: MessageComponents;
}

const closeConfirmationPrefix = "pico:close:";
const closeConfirmationTtl = 5 * 60 * 1_000;
const closedMessage = "This chat is closed. Start a new thread to continue.";
export const install = Effect.fn("DiscordInput.install")(function* <
  Message extends DiscordMessage,
  Interaction extends DiscordInteraction,
>(
  bot: DiscordInputBot<Message, Interaction>,
  config: DiscordConfig,
  drainOutput: () => Effect.Effect<void> = () => Effect.void,
) {
  const application = yield* Application;
  const crypto = yield* Crypto.Crypto;
  const run = yield* FiberSet.makeRuntime();
  const allowedGuildIds = new Set(config.allowedGuildIds);
  const workspaceIds = new Map<bigint, Workspace.WorkspaceId>();
  const chatIds = new Map<bigint, Chat.ChatId>();
  const channelLocks = new Map<bigint, Semaphore.Semaphore>();
  const closeConfirmations = new Map<string, CloseConfirmation>();
  const allowedMentions = { parse: [], repliedUser: false } satisfies {
    parse: [];
    repliedUser: false;
  };
  const formatNumber = new Intl.NumberFormat("en-US").format;

  const findThreadId = (chatId: Chat.ChatId) => {
    for (const [threadId, candidate] of chatIds) {
      if (candidate === chatId) return threadId;
    }
    return undefined;
  };

  const findWorkspace = Effect.fn("Discord.findWorkspace")(function* (channelId: bigint) {
    const cached = workspaceIds.get(channelId);
    if (cached !== undefined) return Option.some(cached);

    const workspace = yield* application.findWorkspaceByPlatformId("discord", channelId.toString());
    if (Option.isSome(workspace)) workspaceIds.set(channelId, workspace.value.id);
    return Option.map(workspace, (value) => value.id);
  });

  const resolveCommandThread = Effect.fn("Discord.resolveCommandThread")(function* (
    interaction: Interaction,
  ) {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (
      guildId === undefined ||
      channelId === undefined ||
      !allowedGuildIds.has(guildId.toString())
    ) {
      return Option.none<CommandThread>();
    }

    const channel = yield* promiseBoundary("Failed to resolve Discord interaction channel", () =>
      bot.helpers.getChannel(channelId),
    );
    if (channel.guildId !== guildId || !isThread(channel.type) || channel.parentId === undefined) {
      return Option.none<CommandThread>();
    }
    return Option.some({ guildId, parentId: channel.parentId, threadId: channel.id });
  });

  const resolveCommandChatId = Effect.fn("Discord.resolveCommandChatId")(function* (
    thread: CommandThread,
  ) {
    const cached = chatIds.get(thread.threadId);
    if (cached !== undefined) return Option.some(cached);

    const chat = yield* application.findChatByPlatformId(
      "discord",
      thread.parentId.toString(),
      thread.threadId.toString(),
    );
    if (Option.isNone(chat)) return Option.none<Chat.ChatId>();
    workspaceIds.set(thread.parentId, chat.value.workspaceId);
    chatIds.set(thread.threadId, chat.value.id);
    return Option.some(chat.value.id);
  });

  const sendMessageToChat = Effect.fn("Discord.sendMessageToChat")(function* (
    chatId: Chat.ChatId,
    message: Message,
  ) {
    yield* application
      .sendMessage(chatId, message.content)
      .pipe(
        Effect.catchTag("ChatClosed", () =>
          promiseBoundary("Failed to report closed Discord chat", () =>
            bot.helpers.sendMessage(message.channelId, { content: closedMessage, allowedMentions }),
          ).pipe(Effect.asVoid),
        ),
      );
  });

  const handleMessage = Effect.fn("Discord.handleMessage")(function* (message: Message) {
    if (
      message.guildId === undefined ||
      !allowedGuildIds.has(message.guildId.toString()) ||
      message.webhookId !== undefined ||
      message.author.id === bot.id
    ) {
      return;
    }
    const rejection =
      message.attachments !== undefined && message.attachments.length > 0
        ? "Attachments are not supported yet. Send the request as text."
        : message.content.trim().length === 0
          ? "Send a text message to start or continue a chat."
          : undefined;
    if (rejection !== undefined) {
      yield* promiseBoundary("Failed to reject unsupported Discord message", () =>
        bot.helpers.sendMessage(message.channelId, { content: rejection, allowedMentions }),
      );
      return;
    }

    const cachedChatId = chatIds.get(message.channelId);
    if (cachedChatId !== undefined) {
      yield* sendMessageToChat(cachedChatId, message);
      return;
    }

    const channel = yield* promiseBoundary("Failed to resolve Discord channel", () =>
      bot.helpers.getChannel(message.channelId),
    );

    if (isThread(channel.type)) {
      if (channel.parentId === undefined) return;

      const chat = yield* application.findChatByPlatformId(
        "discord",
        channel.parentId.toString(),
        channel.id.toString(),
      );
      if (Option.isNone(chat)) return;

      workspaceIds.set(channel.parentId, chat.value.workspaceId);
      chatIds.set(channel.id, chat.value.id);
      yield* sendMessageToChat(chat.value.id, message);
      return;
    }

    if (channel.type !== ChannelTypes.GuildText) return;

    const maybeWorkspaceId = yield* findWorkspace(channel.id);
    let workspaceId: Workspace.WorkspaceId;
    if (Option.isSome(maybeWorkspaceId)) {
      workspaceId = maybeWorkspaceId.value;
    } else {
      const workspace = yield* application.createWorkspace({
        name: channel.name ?? `Discord channel ${channel.id}`,
        binding: { platform: "discord", externalId: channel.id.toString() },
        defaultCwd: config.defaultCwd,
        worktree: null,
      });
      workspaceIds.set(channel.id, workspace.id);
      workspaceId = workspace.id;
    }
    const thread = yield* promiseBoundary("Failed to create Discord thread", () =>
      bot.helpers.startThreadWithMessage(channel.id, message.id, {
        name: threadName(message.content),
        autoArchiveDuration: 1_440,
      }),
    );
    const chat = yield* application.createChat({
      workspaceId,
      externalId: thread.id.toString(),
    });
    chatIds.set(thread.id, chat.id);
    yield* sendMessageToChat(chat.id, message);
  });

  type WorkspacePathIssue = Extract<
    WorkspaceBindingInvalid["issue"],
    { readonly field: "cwd" | "repository" }
  >;

  const pathFailureCopy = (label: string, issue: WorkspacePathIssue) => {
    switch (issue.reason) {
      case "surrounding-whitespace":
        return `The ${label} cannot start or end with whitespace.`;
      case "not-absolute":
        return `The ${label} must be an absolute path.`;
      case "not-found":
        return `That ${label} does not exist.`;
      case "not-directory":
        return `That ${label} is not a directory.`;
      case "unreadable":
        return `That ${label} cannot be inspected.`;
      case "not-repository":
        return "That path is not a Git repository.";
    }
  };

  const bindingFailureCopy = (error: WorkspaceBindingInvalid) => {
    const issue = error.issue;
    switch (issue.field) {
      case "cwd":
        return pathFailureCopy("working directory", issue);
      case "repository":
        return pathFailureCopy("repository path", issue);
      case "branch":
        return issue.reason === "surrounding-whitespace"
          ? "The branch cannot start or end with whitespace."
          : "The branch must resolve to a commit in that repository.";
      case "prefix":
        return issue.reason === "surrounding-whitespace"
          ? "The prefix cannot start or end with whitespace."
          : "The prefix cannot form valid Git branch names.";
    }
  };

  const bindResponse = Effect.fn("Discord.bindResponse")(function* (
    interaction: Interaction,
    command: DiscordCommand.BindCommand,
  ) {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (
      guildId === undefined ||
      channelId === undefined ||
      !allowedGuildIds.has(guildId.toString())
    ) {
      return "This command can only be used in a configured server text channel.";
    }

    const channel = yield* promiseBoundary("Failed to resolve Discord interaction channel", () =>
      bot.helpers.getChannel(channelId),
    );
    if (channel.guildId !== guildId || channel.type !== ChannelTypes.GuildText) {
      return "This command can only be used in a configured server text channel.";
    }

    switch (command.kind) {
      case "malformedBind":
        return "Use /bind set with cwd, or /bind worktree with repository, branch, and prefix.";
      case "bindDirect": {
        const workspace = yield* application.bindWorkspace({
          binding: { platform: "discord", externalId: channel.id.toString() },
          workspaceName: channel.name ?? channel.id.toString(),
          configuration: { kind: "direct", cwd: command.cwd },
        });
        workspaceIds.set(channel.id, workspace.id);
        return `Workspace binding updated to ${workspace.defaultCwd}. Worktrees are disabled for new chats.`;
      }
      case "bindWorktree": {
        const workspace = yield* application.bindWorkspace({
          binding: { platform: "discord", externalId: channel.id.toString() },
          workspaceName: channel.name ?? channel.id.toString(),
          configuration: {
            kind: "worktree",
            repository: command.repository,
            settings: { branch: command.branch, prefix: command.prefix },
          },
        });
        workspaceIds.set(channel.id, workspace.id);
        return `Workspace worktrees configured from ${workspace.defaultCwd}. This affects new chats only.`;
      }
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  });

  const formatShakeResult = (result: ShakeResult) => {
    switch (result.mode) {
      case "elide": {
        const parts: Array<string> = [];
        if (result.toolResultsDropped > 0) {
          parts.push(
            `${result.toolResultsDropped} tool result${result.toolResultsDropped === 1 ? "" : "s"}`,
          );
        }
        if (result.blocksDropped > 0) {
          parts.push(`${result.blocksDropped} block${result.blocksDropped === 1 ? "" : "s"}`);
        }
        return parts.length === 0
          ? "Nothing to shake."
          : `Shook ${parts.join(" + ")} (~${result.tokensFreed} tokens freed).`;
      }
      case "images":
        return result.imagesDropped === 0
          ? "No images found in this chat."
          : `Dropped ${result.imagesDropped} image${result.imagesDropped === 1 ? "" : "s"} from this chat.`;
      case "thinking":
        return result.thinkingBlocksDropped === 0
          ? "No thinking blocks found in this chat."
          : `Dropped ${result.thinkingBlocksDropped} thinking block${result.thinkingBlocksDropped === 1 ? "" : "s"} from this chat.`;
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  };

  const shakeResponse = Effect.fn("Discord.shakeResponse")(function* (
    interaction: Interaction,
    command: DiscordCommand.ShakeCommand,
  ) {
    const policyCopy = "This command can only be used in a pico-owned Discord thread.";
    const thread = yield* resolveCommandThread(interaction);
    if (Option.isNone(thread)) return policyCopy;
    if (command.kind === "malformedShake") {
      return "The /shake command accepts one mode: elide, images, or thinking.";
    }

    const chatId = yield* resolveCommandChatId(thread.value);
    if (Option.isNone(chatId)) return policyCopy;
    return formatShakeResult(yield* application.shake(chatId.value, command.mode));
  });

  const formatContextUsage = (usage: ContextUsage) => {
    if (usage.kind === "unavailable") return "Context usage is unavailable for this chat.";

    const percentUsed = Math.round((usage.usedTokens / usage.contextWindow) * 100);
    const lines = [
      `Context: ${formatNumber(usage.usedTokens)} / ${formatNumber(usage.contextWindow)} tokens (${percentUsed}% used)`,
    ];
    for (const [label, tokens] of [
      ["System prompt", usage.systemPromptTokens],
      ["System tools", usage.systemToolsTokens],
      ["System context", usage.systemContextTokens],
      ["Skills", usage.skillsTokens],
      ["Messages", usage.messagesTokens],
    ] as const) {
      if (tokens !== 0) lines.push(`${label}: ${formatNumber(tokens)} tokens`);
    }
    return lines.join("\n");
  };

  const contextResponse = Effect.fn("Discord.contextResponse")(function* (
    interaction: Interaction,
  ) {
    const policyCopy = "This command can only be used in a pico-owned Discord thread.";
    const thread = yield* resolveCommandThread(interaction);
    if (Option.isNone(thread)) return policyCopy;

    const chatId = yield* resolveCommandChatId(thread.value);
    if (Option.isNone(chatId)) return policyCopy;
    return formatContextUsage(yield* application.contextUsage(chatId.value));
  });

  const archiveThread = Effect.fn("Discord.archiveThread")(function* (threadId: bigint) {
    yield* drainOutput();
    yield* promiseBoundary("Failed to archive Discord thread", () =>
      bot.helpers.editChannel(threadId, { archived: true, locked: true }),
    );
  });
  const closeResultResponse = Effect.fn("Discord.closeResultResponse")(function* (
    result: CloseChatResult,
    thread: CommandThread,
    requesterId: bigint,
    chatId: Chat.ChatId,
  ) {
    const clearChatConfirmations = () => {
      for (const [nonce, confirmation] of closeConfirmations) {
        if (confirmation.chatId === chatId) closeConfirmations.delete(nonce);
      }
    };
    if (result.kind === "closed") {
      clearChatConfirmations();
      yield* archiveThread(thread.threadId);
      return "Chat closed. The transcript remains available in this archived thread.";
    }

    const nonce = yield* crypto.randomUUIDv4;
    const now = yield* Clock.currentTimeMillis;
    clearChatConfirmations();
    closeConfirmations.set(nonce, {
      chatId,
      guildId: thread.guildId,
      threadId: thread.threadId,
      requesterId,
      expiresAt: now + closeConfirmationTtl,
    });
    run(
      Effect.sleep(Duration.millis(closeConfirmationTtl)).pipe(
        Effect.andThen(Effect.sync(() => closeConfirmations.delete(nonce))),
      ),
    );
    return {
      content:
        "Git requires destructive removal for this worktree. Closing may discard changes or nested repositories. Local and remote branches will be kept.",
      components: [
        {
          type: MessageComponentTypes.ActionRow,
          components: [
            {
              type: MessageComponentTypes.Button,
              style: ButtonStyles.Danger,
              label: "Close with force",
              customId: closeConfirmationPrefix + nonce,
            },
          ],
        },
      ],
    } satisfies ComponentResponse;
  });

  const closeResponse = Effect.fn("Discord.closeResponse")(function* (interaction: Interaction) {
    const policyCopy = "This command can only be used in a persisted pico chat thread.";
    const requesterId = interaction.user?.id;
    if (requesterId === undefined) return policyCopy;
    const thread = yield* resolveCommandThread(interaction);
    if (Option.isNone(thread)) return policyCopy;
    const chatId = yield* resolveCommandChatId(thread.value);
    if (Option.isNone(chatId)) return policyCopy;

    const result = yield* application.closeChat(chatId.value, { allowDirtyWorktree: false });
    return yield* closeResultResponse(result, thread.value, requesterId, chatId.value);
  });

  const closeConfirmationResponse = Effect.fn("Discord.closeConfirmationResponse")(function* (
    interaction: Interaction,
    nonce: string,
  ) {
    const confirmation = closeConfirmations.get(nonce);
    if (confirmation === undefined) {
      return {
        content: "This close confirmation is no longer valid.",
        components: [],
      } satisfies ComponentResponse;
    }
    if (
      interaction.user?.id !== confirmation.requesterId ||
      interaction.guildId !== confirmation.guildId ||
      interaction.channelId !== confirmation.threadId ||
      interaction.message?.channelId !== confirmation.threadId
    ) {
      return "Only the person who requested this close can confirm it.";
    }

    const thread = yield* resolveCommandThread(interaction);
    if (Option.isNone(thread)) return "This close confirmation is no longer valid.";
    const chatId = yield* resolveCommandChatId(thread.value);
    if (Option.isNone(chatId) || chatId.value !== confirmation.chatId) {
      return "This close confirmation is no longer valid.";
    }

    const now = yield* Clock.currentTimeMillis;
    closeConfirmations.delete(nonce);
    if (now >= confirmation.expiresAt) {
      return {
        content: "This close confirmation expired. Run /close again.",
        components: [],
      } satisfies ComponentResponse;
    }

    return yield* application.closeChat(chatId.value, { allowDirtyWorktree: true }).pipe(
      Effect.flatMap((result) =>
        closeResultResponse(result, thread.value, confirmation.requesterId, chatId.value),
      ),
      Effect.map((response) =>
        typeof response === "string"
          ? ({ content: response, components: [] } satisfies ComponentResponse)
          : response,
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Discord close confirmation failed", Cause.pretty(cause)).pipe(
          Effect.as({
            content: "pico could not close this chat.",
            components: [],
          } satisfies ComponentResponse),
        ),
      ),
    );
  });

  const handleInteraction = Effect.fn("Discord.handleInteraction")(function* (
    interaction: Interaction,
    command: DiscordCommand.Command,
  ) {
    const response = yield* (() => {
      switch (command.kind) {
        case "bindDirect":
        case "bindWorktree":
        case "malformedBind":
          return bindResponse(interaction, command).pipe(
            Effect.catchTag("WorkspaceBindingInvalid", (error) =>
              Effect.succeed(bindingFailureCopy(error)),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("Discord interaction failed", Cause.pretty(cause)).pipe(
                Effect.as("pico could not update this workspace."),
              ),
            ),
          );
        case "shake":
        case "malformedShake":
          return shakeResponse(interaction, command).pipe(
            Effect.catchTag("ChatClosed", () => Effect.succeed(closedMessage)),
            Effect.catchCause((cause) =>
              Effect.logError("Discord shake failed", Cause.pretty(cause)).pipe(
                Effect.as("pico could not shake this chat."),
              ),
            ),
          );
        case "context":
          return contextResponse(interaction).pipe(
            Effect.catchTag("ChatClosed", () => Effect.succeed(closedMessage)),
            Effect.catchCause((cause) =>
              Effect.logError("Discord context failed", Cause.pretty(cause)).pipe(
                Effect.as("pico could not read this chat's context."),
              ),
            ),
          );
        case "close":
          return closeResponse(interaction).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Discord close failed", Cause.pretty(cause)).pipe(
                Effect.as("pico could not close this chat."),
              ),
            ),
          );
        default: {
          const exhaustive: never = command;
          return exhaustive;
        }
      }
    })();
    const options =
      typeof response === "string"
        ? { content: response, allowedMentions }
        : { ...response, allowedMentions };
    yield* promiseBoundary("Failed to edit Discord interaction", () =>
      interaction.edit(options),
    ).pipe(
      Effect.catch((error) => Effect.logError("Discord interaction edit failed", error.message)),
    );
  });

  bot.events.messageCreate = (message) => {
    const lock = channelLocks.get(message.channelId) ?? Semaphore.makeUnsafe(1);
    channelLocks.set(message.channelId, lock);
    run(
      lock
        .withPermit(handleMessage(message))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Discord input failed", Cause.pretty(cause)),
          ),
        ),
    );
  };

  bot.events.interactionCreate = (interaction) => {
    const customId = interaction.data?.customId;
    const closeNonce =
      interaction.type === InteractionTypes.MessageComponent &&
      customId?.startsWith(closeConfirmationPrefix) === true
        ? customId.slice(closeConfirmationPrefix.length)
        : undefined;
    const name = interaction.data?.name;
    const isCommand =
      interaction.type === InteractionTypes.ApplicationCommand &&
      (name === "bind" || name === "shake" || name === "context" || name === "close");
    if (closeNonce === undefined && !isCommand) return;

    const deferred = closeNonce === undefined ? interaction.defer(true) : interaction.deferEdit();
    void deferred.then(
      () => {
        const channelId = interaction.channelId;
        const effect = (() => {
          if (closeNonce !== undefined) {
            return closeConfirmationResponse(interaction, closeNonce).pipe(
              Effect.flatMap((response) => {
                const options =
                  typeof response === "string"
                    ? { content: response, allowedMentions }
                    : { ...response, allowedMentions };
                return promiseBoundary("Failed to edit Discord interaction", () =>
                  interaction.edit(options),
                );
              }),
              Effect.catch((error) =>
                Effect.logError("Discord interaction edit failed", error.message),
              ),
            );
          }
          const command: DiscordCommand.Command =
            name === "bind"
              ? DiscordCommand.parseBind(interaction.data?.options)
              : name === "shake"
                ? DiscordCommand.parseShake(interaction.data?.options)
                : name === "close"
                  ? { kind: "close" }
                  : { kind: "context" };
          return handleInteraction(interaction, command);
        })();
        if (channelId === undefined) {
          run(effect);
          return;
        }
        const lock = channelLocks.get(channelId) ?? Semaphore.makeUnsafe(1);
        channelLocks.set(channelId, lock);
        run(lock.withPermit(effect));
      },
      (cause: unknown) => {
        run(
          Effect.logError(
            "Discord interaction defer failed",
            discordError("Failed to defer Discord interaction", cause).message,
          ),
        );
      },
    );
  };

  return findThreadId;
});
