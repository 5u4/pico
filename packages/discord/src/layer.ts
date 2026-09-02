import type { DiscordConfig } from "@pico/config/config";
import { EventRouter } from "@pico/contract/event-router";
import { createBot, GatewayIntents, MessageFlags } from "discordeno";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as DiscordInput from "./discord-input.ts";
import * as DiscordOutput from "./discord-output.ts";

const start = Effect.fn("Discord.start")(function* (config: DiscordConfig) {
  const eventRouter = yield* EventRouter;
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
    catch: (cause) => DiscordInput.discordError("Failed to create Discord bot", cause),
  });

  const findThreadId = yield* DiscordInput.install(bot, config);
  const route = yield* eventRouter.open((envelope) => findThreadId(envelope.chatId) !== undefined);
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
      triggerTyping: (threadId) =>
        DiscordInput.promiseBoundary("Failed to trigger Discord typing indicator", () =>
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

  yield* Effect.acquireRelease(
    DiscordInput.promiseBoundary("Failed to start Discord bot", async () => {
      await bot.start();
      return bot;
    }),
    () =>
      DiscordInput.promiseBoundary("Failed to stop Discord bot", () => bot.shutdown()).pipe(
        Effect.catch((error) => Effect.logError("Discord shutdown failed", error.message)),
      ),
  );
});

export const layer = (config: DiscordConfig) => Layer.effectDiscard(start(config));
