import type { DiscordConfig } from "@pico/config/config";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import type * as Chat from "@pico/contract/chat-model";
import { EventRouter } from "@pico/contract/event-router";
import { type CreateApplicationCommand, createBot, GatewayIntents, MessageFlags } from "discordeno";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as DiscordCommand from "./discord-command.ts";
import * as DiscordInput from "./discord-input.ts";
import * as DiscordOutput from "./discord-output.ts";

export interface DiscordStartupBot {
  readonly helpers: {
    readonly upsertGlobalApplicationCommands: (
      commands: Array<CreateApplicationCommand>,
    ) => Promise<unknown>;
    readonly upsertGuildApplicationCommands: (
      guildId: string | bigint,
      commands: Array<CreateApplicationCommand>,
    ) => Promise<unknown>;
  };
  readonly start: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

const stopBot = (bot: DiscordStartupBot) =>
  DiscordInput.promiseBoundary("Failed to stop Discord bot", () => bot.shutdown()).pipe(
    Effect.catch((error) => Effect.logError("Discord shutdown failed", error.message)),
  );

export const openBot = Effect.fn("Discord.openBot")(function* (
  bot: DiscordStartupBot,
  config: DiscordConfig,
  joinedGuildIds: ReadonlySet<string>,
) {
  const acquire = Effect.gen(function* () {
    yield* DiscordInput.promiseBoundary("Failed to start Discord bot", () => bot.start());
    const allowedGuildIdSet = new Set(config.allowedGuildIds);
    const allowedGuildIds = Array.from(allowedGuildIdSet);
    const missingGuildIds = allowedGuildIds.filter((guildId) => !joinedGuildIds.has(guildId));
    if (missingGuildIds.length > 0) {
      return yield* Effect.fail(
        DiscordInput.discordError(
          `Discord bot is not a member of allowed guild(s): ${missingGuildIds.join(", ")}`,
          undefined,
        ),
      );
    }

    yield* DiscordInput.promiseBoundary("Failed to clear global Discord commands", () =>
      bot.helpers.upsertGlobalApplicationCommands([]),
    );
    yield* Effect.forEach(allowedGuildIds, (guildId) =>
      DiscordInput.promiseBoundary("Failed to register Discord commands", () =>
        bot.helpers.upsertGuildApplicationCommands(guildId, DiscordCommand.applicationCommands),
      ),
    );
    yield* Effect.forEach(
      Array.from(joinedGuildIds).filter((guildId) => !allowedGuildIdSet.has(guildId)),
      (guildId) =>
        DiscordInput.promiseBoundary("Failed to clear disallowed guild Discord commands", () =>
          bot.helpers.upsertGuildApplicationCommands(guildId, []),
        ),
    );
    return bot;
  }).pipe(Effect.tapError(() => stopBot(bot)));

  return yield* Effect.acquireRelease(acquire, () => stopBot(bot));
});

export const pumpOutput = Effect.fn("Discord.pumpOutput")(function* (
  eventRouter: EventRouter["Service"],
  resolveThreadId: (chatId: Chat.ChatId) => Effect.Effect<Option.Option<bigint>, unknown>,
  dispatch: (threadId: bigint, envelope: AgentEventEnvelope) => Effect.Effect<unknown, unknown>,
) {
  const route = yield* eventRouter.open(() => true);
  yield* route.events.pipe(
    Stream.runForEach((envelope) =>
      resolveThreadId(envelope.chatId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (threadId) => dispatch(threadId, envelope),
          }),
        ),
        Effect.catchCause((cause) => Effect.logError("Discord output failed", Cause.pretty(cause))),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
});

const start = Effect.fn("Discord.start")(function* (config: DiscordConfig) {
  const eventRouter = yield* EventRouter;
  const httpClient = yield* HttpClient.HttpClient;
  const allowedMentions = { parse: [], repliedUser: false };

  const bot = yield* Effect.try({
    try: () =>
      createBot({
        token: Redacted.value(config.token),
        intents:
          GatewayIntents.Guilds | GatewayIntents.GuildMessages | GatewayIntents.MessageContent,
        desiredProperties: {
          attachment: {
            contentType: true,
            filename: true,
            size: true,
            url: true,
          },
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
          interaction: {
            channelId: true,
            data: true,
            guildId: true,
            message: true,
            id: true,
            token: true,
            type: true,
            user: true,
          },
        },
      }),
    catch: (cause) => DiscordInput.discordError("Failed to create Discord bot", cause),
  });
  const joinedGuildIds = new Set<string>();
  bot.events.ready = ({ guilds }) => {
    for (const guildId of guilds) joinedGuildIds.add(guildId.toString());
  };
  type InputMessage = Parameters<NonNullable<typeof bot.events.messageCreate>>[0];
  type InputInteraction = Parameters<NonNullable<typeof bot.events.interactionCreate>>[0];

  const resolveThreadId = yield* DiscordInput.install<InputMessage, InputInteraction>(
    bot,
    config,
    () => eventRouter.drain(),
    httpClient,
  );
  const scope = yield* Scope.Scope;
  const dispatch = DiscordOutput.make(
    {
      send: (threadId, message) =>
        DiscordInput.promiseBoundary("Failed to send Discord message", () =>
          bot.helpers.sendMessage(threadId, {
            content: message.content,
            allowedMentions,
            ...(message.silent ? { flags: MessageFlags.SuppressNotifications } : {}),
          }),
        ).pipe(Effect.map((sent) => sent.id)),
      edit: (threadId, messageId, content) =>
        DiscordInput.promiseBoundary("Failed to edit Discord message", () =>
          bot.helpers.editMessage(threadId, messageId, { content, allowedMentions }),
        ).pipe(Effect.asVoid),
      renameThread: (threadId, title) =>
        DiscordInput.promiseBoundary("Failed to rename Discord thread", () =>
          bot.helpers.editChannel(threadId, { name: title }),
        ).pipe(Effect.asVoid),
      triggerTyping: (threadId) =>
        DiscordInput.promiseBoundary("Failed to trigger Discord typing indicator", () =>
          bot.helpers.triggerTypingIndicator(threadId),
        ),
    },
    scope,
    { showToolCalls: config.showToolCalls, showThinking: config.showThinking },
  );

  yield* pumpOutput(eventRouter, resolveThreadId, dispatch);

  yield* openBot(bot, config, joinedGuildIds);
});

export const layer = (config: DiscordConfig) =>
  Layer.effectDiscard(start(config)).pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "error" })),
      ),
    ),
  );
