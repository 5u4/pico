import type { DiscordConfig } from "@pico/config/config";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import { Application } from "@pico/contract/application";
import type * as Chat from "@pico/contract/chat-model";
import { EventRouter } from "@pico/contract/event-router";
import type * as Workspace from "@pico/contract/workspace-model";
import { ChannelTypes, createBot, GatewayIntents } from "discordeno";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

class DiscordError extends Schema.TaggedError<DiscordError>()("DiscordError", {
  message: Schema.String,
}) {}

interface RenderedChunk {
  id: bigint;
  content: string;
}
interface RenderState {
  chatId: Chat.ChatId;
  message: RenderedChunk | undefined;
}

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
  let renderState: RenderState | undefined;

  const appendText = Effect.fn("Discord.render.appendText")(function* (
    threadId: bigint,
    state: RenderState,
    text: string,
  ) {
    let remaining = text;
    const last = state.message;

    if (last !== undefined && last.content.length < 2_000 && remaining.length > 0) {
      const appended = remaining.slice(0, 2_000 - last.content.length);
      const content = last.content + appended;
      yield* promiseBoundary("Failed to edit Discord message", () =>
        bot.helpers.editMessage(threadId, last.id, { content, allowedMentions }),
      );
      last.content = content;
      remaining = remaining.slice(appended.length);
    }

    while (remaining.length > 0) {
      const content = remaining.slice(0, 2_000);
      const message = yield* promiseBoundary("Failed to send Discord message", () =>
        bot.helpers.sendMessage(threadId, { content, allowedMentions }),
      );
      state.message = { id: message.id, content };
      remaining = remaining.slice(content.length);
    }
  });

  const render = Effect.fn("Discord.render")(function* (envelope: AgentEventEnvelope) {
    const threadId = findThreadId(envelope.chatId);
    if (threadId === undefined) return;

    if (envelope.event.type === "run-started") {
      renderState = { chatId: envelope.chatId, message: undefined };
      return;
    }

    if (envelope.event.type === "text-delta") {
      if (renderState === undefined || renderState.chatId !== envelope.chatId) {
        renderState = { chatId: envelope.chatId, message: undefined };
      }
      yield* appendText(threadId, renderState, envelope.event.text);
      return;
    }

    if (envelope.event.type !== "message-settled" || envelope.event.message.role !== "assistant") {
      return;
    }

    if (renderState === undefined || renderState.chatId !== envelope.chatId) {
      renderState = { chatId: envelope.chatId, message: undefined };
    }
    if (renderState.message === undefined) {
      const text = envelope.event.message.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("");
      yield* appendText(threadId, renderState, text);
    }
    renderState = undefined;
  });

  yield* route.events.pipe(
    Stream.runForEach((envelope) =>
      render(envelope).pipe(
        Effect.catchCause((cause) => Effect.logError("Discord output failed", Cause.pretty(cause))),
      ),
    ),
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
    run(
      handleMessage(message).pipe(
        Effect.catchCause((cause) => Effect.logError("Discord input failed", Cause.pretty(cause))),
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
