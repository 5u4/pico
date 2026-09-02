import type { DiscordConfig } from "@pico/config/config";
import { Application } from "@pico/contract/application";
import type * as Chat from "@pico/contract/chat-model";
import type * as Workspace from "@pico/contract/workspace-model";
import { ChannelTypes } from "discordeno";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

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
  readonly type: ChannelTypes;
  readonly parentId?: bigint;
  readonly name?: string;
}

export interface DiscordInputBot<Message extends DiscordMessage = DiscordMessage> {
  readonly id: bigint;
  readonly events: {
    messageCreate?: (message: Message) => unknown;
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

const threadName = (content: string) => content.trim().replace(/\s+/g, " ").slice(0, 100);

export const install = Effect.fn("DiscordInput.install")(function* <Message extends DiscordMessage>(
  bot: DiscordInputBot<Message>,
  config: DiscordConfig,
) {
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

  return findThreadId;
});
