import type { DiscordConfig } from "@pico/config/config";
import { Application } from "@pico/contract/application";
import type * as Chat from "@pico/contract/chat-model";
import { EventRouter } from "@pico/contract/event-router";
import type * as Workspace from "@pico/contract/workspace-model";
import { ChannelTypes, createBot, GatewayIntents, MessageFlags } from "discordeno";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as DiscordOutput from "./discord-output.ts";

class DiscordError extends Schema.TaggedError<DiscordError>()("DiscordError", {
  message: Schema.String,
}) {}

const discordError = (message: string, cause: unknown) =>
  new DiscordError({
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });

const promiseBoundary = <A>(message: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => discordError(message, cause),
  });

const isThread = (type: ChannelTypes) =>
  type === ChannelTypes.AnnouncementThread ||
  type === ChannelTypes.PublicThread ||
  type === ChannelTypes.PrivateThread;

const threadName = (content: string) => {
  const name = content.trim().replace(/\s+/g, " ").slice(0, 100);
  return name.length === 0 ? "Pico chat" : name;
};

const start = Effect.fn("Discord.start")(function* (config: DiscordConfig) {
  const application = yield* Application;
  const eventRouter = yield* EventRouter;
  const run = yield* FiberSet.makeRuntime();
  const allowedGuildIds = new Set(config.allowedGuildIds);
  const workspaceIds = new Map<bigint, Workspace.WorkspaceId>();
  const chatIds = new Map<bigint, Chat.ChatId>();
  const channelLocks = new Map<bigint, Semaphore.Semaphore>();
  const allowedMentions = { parse: [], repliedUser: false };

  const bot = yield* Effect.try({
    try: () =>
      createBot({
        token: Redacted.value(config.token),
        intents:
          GatewayIntents.Guilds | GatewayIntents.GuildMessages | GatewayIntents.MessageContent,
        desiredProperties: {
          channel: {
            guildId: true,
            id: true,
            name: true,
            parentId: true,
            type: true,
          },
          message: {
            author: true,
            channelId: true,
            content: true,
            guildId: true,
            id: true,
            webhookId: true,
            attachments: true,
          },
          user: {
            id: true,
          },
        },
      }),
    catch: (cause) => discordError("Failed to create Discord bot", cause),
  });

  const findThreadId = (chatId: Chat.ChatId) => {
    for (const [threadId, candidate] of chatIds) {
      if (candidate === chatId) return threadId;
    }
    return undefined;
  };

  const route = yield* eventRouter.open((envelope) => findThreadId(envelope.chatId) !== undefined);
  const scope = yield* Scope.Scope;
  const dispatch = DiscordOutput.make(
    {
      send: (threadId, message) =>
        promiseBoundary("Failed to send Discord message", () =>
          bot.helpers.sendMessage(threadId, {
            content: message.content,
            allowedMentions,
            ...(message.silent ? { flags: MessageFlags.SuppressNotifications } : {}),
          }),
        ).pipe(Effect.map((sent) => sent.id)),
      edit: (threadId, messageId, content) =>
        promiseBoundary("Failed to edit Discord message", () =>
          bot.helpers.editMessage(threadId, messageId, { content, allowedMentions }),
        ).pipe(Effect.asVoid),
      triggerTyping: (threadId) =>
        promiseBoundary("Failed to trigger Discord typing indicator", () =>
          bot.helpers.triggerTypingIndicator(threadId),
        ),
    },
    scope,
  );

  yield* route.events.pipe(
    Stream.runForEach((envelope) => {
      const threadId = findThreadId(envelope.chatId);
      if (threadId === undefined) return Effect.void;
      return dispatch(threadId, envelope).pipe(
        Effect.catchCause((cause) => Effect.logError("Discord output failed", Cause.pretty(cause))),
      );
    }),
    Effect.forkScoped({ startImmediately: true }),
  );

  const findWorkspace = Effect.fn("Discord.findWorkspace")(function* (channelId: bigint) {
    const cached = workspaceIds.get(channelId);
    if (cached !== undefined) return Option.some(cached);

    const workspace = yield* application.findWorkspaceByPlatformId("discord", channelId.toString());
    if (Option.isSome(workspace)) workspaceIds.set(channelId, workspace.value.id);
    return Option.map(workspace, (value) => value.id);
  });

  type DiscordMessage = Parameters<NonNullable<typeof bot.events.messageCreate>>[0];

  const handleMessage = Effect.fn("Discord.handleMessage")(function* (message: DiscordMessage) {
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

  yield* Effect.acquireRelease(
    promiseBoundary("Failed to start Discord bot", async () => {
      await bot.start();
      return bot;
    }),
    () =>
      promiseBoundary("Failed to stop Discord bot", () => bot.shutdown()).pipe(
        Effect.catch((error) => Effect.logError("Discord shutdown failed", error.message)),
      ),
  );
});

export const layer = (config: DiscordConfig) => Layer.effectDiscard(start(config));
