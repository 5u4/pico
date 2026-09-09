import type { DiscordConfig } from "@pico/config/config";
import type { ContextUsage, ShakeResult } from "@pico/contract/agent-runtime";
import { Application } from "@pico/contract/application";
import type * as Chat from "@pico/contract/chat-model";
import type { WorkspaceCwdInvalid } from "@pico/contract/errors";
import type * as Workspace from "@pico/contract/workspace-model";
import { ChannelTypes, InteractionTypes } from "discordeno";
import * as Cause from "effect/Cause";
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
  readonly data?: {
    readonly name: string;
    readonly options?: ReadonlyArray<DiscordCommand.CommandOption>;
  };
  readonly defer: (isPrivate?: boolean) => Promise<unknown>;
  readonly edit: (options: {
    readonly content: string;
    readonly allowedMentions: { readonly parse: []; readonly repliedUser: false };
  }) => Promise<unknown>;
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
  readonly parentId: bigint;
  readonly threadId: bigint;
}

const threadName = (content: string) => content.trim().replace(/\s+/g, " ").slice(0, 100);

export const install = Effect.fn("DiscordInput.install")(function* <
  Message extends DiscordMessage,
  Interaction extends DiscordInteraction,
>(bot: DiscordInputBot<Message, Interaction>, config: DiscordConfig) {
  const application = yield* Application;
  const run = yield* FiberSet.makeRuntime();
  const allowedGuildIds = new Set(config.allowedGuildIds);
  const workspaceIds = new Map<bigint, Workspace.WorkspaceId>();
  const chatIds = new Map<bigint, Chat.ChatId>();
  const channelLocks = new Map<bigint, Semaphore.Semaphore>();
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
    return Option.some({ parentId: channel.parentId, threadId: channel.id });
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
      yield* application.sendMessage(cachedChatId, message.content);
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
      yield* application.sendMessage(chat.value.id, message.content);
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
    yield* application.sendMessage(chat.id, message.content);
  });

  const cwdFailureCopy = (reason: WorkspaceCwdInvalid["reason"]) => {
    switch (reason) {
      case "surrounding-whitespace":
        return "The working directory cannot start or end with whitespace.";
      case "not-absolute":
        return "The working directory must be an absolute path.";
      case "not-found":
        return "That working directory does not exist.";
      case "not-directory":
        return "That path is not a directory.";
      case "unreadable":
        return "That working directory cannot be inspected.";
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
        return "The /bind set command requires one cwd value.";
      case "bindSetCwd": {
        const workspace = yield* application.bindWorkspace({
          binding: { platform: "discord", externalId: channel.id.toString() },
          workspaceName: channel.name ?? channel.id.toString(),
          cwd: command.cwd,
        });
        workspaceIds.set(channel.id, workspace.id);
        return `Workspace binding updated to ${workspace.defaultCwd}.`;
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

  const handleInteraction = Effect.fn("Discord.handleInteraction")(function* (
    interaction: Interaction,
    command: DiscordCommand.Command,
  ) {
    const content = yield* (() => {
      switch (command.kind) {
        case "bindSetCwd":
        case "malformedBind":
          return bindResponse(interaction, command).pipe(
            Effect.catchTag("WorkspaceCwdInvalid", (error) =>
              Effect.succeed(cwdFailureCopy(error.reason)),
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
            Effect.catchCause((cause) =>
              Effect.logError("Discord shake failed", Cause.pretty(cause)).pipe(
                Effect.as("pico could not shake this chat."),
              ),
            ),
          );
        case "context":
          return contextResponse(interaction).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Discord context failed", Cause.pretty(cause)).pipe(
                Effect.as("pico could not read this chat's context."),
              ),
            ),
          );
        default: {
          const exhaustive: never = command;
          return exhaustive;
        }
      }
    })();
    yield* promiseBoundary("Failed to edit Discord interaction", () =>
      interaction.edit({ content, allowedMentions }),
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
    if (interaction.type !== InteractionTypes.ApplicationCommand) return;
    const name = interaction.data?.name;
    if (name !== "bind" && name !== "shake" && name !== "context") return;

    void interaction.defer(true).then(
      () => {
        const command: DiscordCommand.Command =
          name === "bind"
            ? DiscordCommand.parseBind(interaction.data?.options)
            : name === "shake"
              ? DiscordCommand.parseShake(interaction.data?.options)
              : { kind: "context" };
        const channelId = interaction.channelId;
        if (channelId === undefined) {
          run(handleInteraction(interaction, command));
          return;
        }
        const lock = channelLocks.get(channelId) ?? Semaphore.makeUnsafe(1);
        channelLocks.set(channelId, lock);
        run(lock.withPermit(handleInteraction(interaction, command)));
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
