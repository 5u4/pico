import type { DiscordConfig } from "@pico/config/config";
import { discordBotRoot } from "@pico/config/root";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import type * as Chat from "@pico/contract/chat-model";
import type { PicoRoot } from "@pico/contract/config";
import { EventRouter } from "@pico/contract/event-router";
import { ReplyDelivery } from "@pico/contract/reply-target";
import { type CreateApplicationCommand, createBot, GatewayIntents, MessageFlags } from "discordeno";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as DiscordCommand from "./discord-command.ts";
import { DiscordError, discordError, promiseBoundary, reportFailure } from "./discord-error.ts";
import * as DiscordInput from "./discord-input.ts";
import * as DiscordOutput from "./discord-output.ts";

export { DiscordError };

export interface DiscordOptions {
  readonly picoRoot: PicoRoot;
  readonly onAuthenticated: (botId: string) => void;
}

export interface DiscordStartupBot {
  readonly id?: bigint;
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
  promiseBoundary("stop-bot", () => bot.shutdown()).pipe(
    Effect.andThen(Effect.logInfo("Discord bot stopped")),
    Effect.catchCause((cause) => reportFailure("stop-bot", cause)),
    Effect.annotateLogs({ component: "discord", operation: "stop-bot", botId: bot.id?.toString() }),
  );

export const openBot = Effect.fn("Discord.openBot")(function* (
  bot: DiscordStartupBot,
  config: DiscordConfig,
  joinedGuildIds: ReadonlySet<string>,
) {
  const acquire = Effect.gen(function* () {
    yield* Effect.logDebug("Starting Discord bot").pipe(
      Effect.annotateLogs({
        component: "discord",
        operation: "start-bot",
        botId: bot.id?.toString(),
      }),
    );
    yield* promiseBoundary("start-bot", () => bot.start());
    const allowedGuildIdSet = new Set(config.allowedGuildIds);
    const allowedGuildIds = Array.from(allowedGuildIdSet);
    const missingGuildIds = allowedGuildIds.filter((guildId) => !joinedGuildIds.has(guildId));
    if (missingGuildIds.length > 0) {
      return yield* Effect.fail(
        new DiscordError({
          operation: "validate-guild-membership",
          message: `Discord bot is not a member of allowed guild(s): ${missingGuildIds.join(", ")}`,
        }),
      );
    }

    yield* promiseBoundary("clear-global-commands", () =>
      bot.helpers.upsertGlobalApplicationCommands([]),
    );
    yield* Effect.forEach(allowedGuildIds, (guildId) =>
      promiseBoundary(
        "register-guild-commands",
        () =>
          bot.helpers.upsertGuildApplicationCommands(guildId, DiscordCommand.applicationCommands),
        guildId,
      ),
    );
    yield* Effect.forEach(
      Array.from(joinedGuildIds).filter((guildId) => !allowedGuildIdSet.has(guildId)),
      (guildId) =>
        promiseBoundary(
          "clear-guild-commands",
          () => bot.helpers.upsertGuildApplicationCommands(guildId, []),
          guildId,
        ),
    );
    yield* Effect.logInfo("Discord bot ready").pipe(
      Effect.annotateLogs({
        component: "discord",
        operation: "start-bot",
        botId: bot.id?.toString(),
        configuredGuildCount: allowedGuildIds.length,
        joinedGuildCount: joinedGuildIds.size,
        directMessages: "enabled",
      }),
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
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.annotateLogsScoped({ phase: "resolve-thread" });
          const thread = yield* resolveThreadId(envelope.chatId);
          if (Option.isNone(thread)) return;
          yield* Effect.annotateLogsScoped({
            phase: "deliver-event",
            threadId: thread.value.toString(),
          });
          yield* dispatch(thread.value, envelope);
        }).pipe(
          Effect.catchCause((cause) => reportFailure("deliver-event", cause)),
          Effect.annotateLogs({
            component: "discord",
            chatId: envelope.chatId,
            eventType: envelope.event.type,
          }),
        ),
      ),
    ),
    Effect.catchCause((cause) => reportFailure("output-pump", cause)),
    Effect.forkScoped({ startImmediately: true }),
  );
});

export const sdkLoggerFactory =
  (run: (effect: Effect.Effect<void>) => unknown) => (name: "REST" | "GATEWAY" | "BOT") => {
    const discard = () => {};
    const report = (level: "warning" | "error", message: unknown) => {
      if (name !== "GATEWAY") return;
      const connection =
        typeof message === "string"
          ? /^\[Shard\] There was an error connecting Shard #(\d+)\.$/.exec(message)
          : null;
      const category = connection !== null ? "connection" : "sdk-gateway";
      run(
        (level === "warning"
          ? Effect.logWarning("Discord gateway degraded")
          : Effect.logError("Discord gateway failed")
        ).pipe(
          Effect.annotateLogs({
            component: "discord",
            operation: "gateway",
            category,
            ...(connection?.[1] === undefined ? {} : { shardId: connection[1] }),
          }),
        ),
      );
    };
    return {
      debug: discard,
      info: (message: unknown) => {
        if (name !== "GATEWAY" || typeof message !== "string") return;
        const disconnected =
          /^\[Shard\] Shard #(\d+) closed with code (\d+)\. Attempting to resume\.\.\.$/.exec(
            message,
          );
        if (disconnected === null) return;
        run(
          Effect.logWarning("Discord gateway reconnecting").pipe(
            Effect.annotateLogs({
              component: "discord",
              operation: "gateway",
              eventType: "disconnected",
              shardId: disconnected[1],
              closeCode: Number(disconnected[2]),
            }),
          ),
        );
      },
      warn: (message: unknown) => report("warning", message),
      error: (message: unknown) => report("error", message),
      fatal: (message: unknown) => report("error", message),
    };
  };

const start = Effect.fn("Discord.start")(function* (
  config: DiscordConfig,
  options: DiscordOptions,
) {
  const eventRouter = yield* EventRouter;
  const httpClient = yield* HttpClient.HttpClient;
  const run = yield* FiberSet.makeRuntime();
  const gatewayEvent = (event: string, shardId: number, resumable?: boolean) => {
    run(
      Effect.logInfo("Discord gateway lifecycle").pipe(
        Effect.annotateLogs({
          component: "discord",
          operation: "gateway",
          eventType: event,
          shardId,
          ...(resumable === undefined ? {} : { resumable }),
        }),
      ),
    );
  };
  const allowedMentions = { parse: [], repliedUser: false };

  const bot = yield* Effect.try({
    try: () =>
      createBot({
        token: Redacted.value(config.token),
        loggerFactory: sdkLoggerFactory(run),
        gateway: {
          events: {
            connecting: (shard) => gatewayEvent("connecting", shard.id),
            connected: (shard) => gatewayEvent("connected", shard.id),
            requestedReconnect: (shard) => gatewayEvent("reconnect-requested", shard.id),
            resumed: (shard) => gatewayEvent("resumed", shard.id),
            invalidSession: (shard, resumable) =>
              gatewayEvent("invalid-session", shard.id, resumable),
          },
        },
        intents:
          GatewayIntents.Guilds |
          GatewayIntents.GuildMessages |
          GatewayIntents.DirectMessages |
          GatewayIntents.MessageContent,
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
            toggles: true,
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
    catch: (cause) => discordError("create-bot", cause),
  });
  const joinedGuildIds = new Set<string>();
  bot.events.ready = ({ guilds, user }) => {
    options.onAuthenticated(user.id.toString());
    for (const guildId of guilds) joinedGuildIds.add(guildId.toString());
  };
  type InputMessage = Parameters<NonNullable<typeof bot.events.messageCreate>>[0];
  type InputInteraction = Parameters<NonNullable<typeof bot.events.interactionCreate>>[0];

  const outputClient: DiscordOutput.DiscordOutputClient = {
    send: (threadId, message) =>
      promiseBoundary("send-message", () =>
        bot.helpers.sendMessage(threadId, {
          content: message.content,
          allowedMentions,
          ...(message.silent ? { flags: MessageFlags.SuppressNotifications } : {}),
          ...(message.replyTo === undefined
            ? {}
            : { messageReference: { messageId: message.replyTo, failIfNotExists: false } }),
        }),
      ).pipe(Effect.map((sent) => sent.id)),
    edit: (threadId, messageId, content) =>
      promiseBoundary("edit-message", () =>
        bot.helpers.editMessage(threadId, messageId, { content, allowedMentions }),
      ).pipe(Effect.asVoid),
    renameThread: (threadId, title) =>
      promiseBoundary("rename-thread", () =>
        bot.helpers.editChannel(threadId, { name: title }),
      ).pipe(Effect.asVoid),
    triggerTyping: (threadId) =>
      promiseBoundary("trigger-typing", () => bot.helpers.triggerTypingIndicator(threadId)),
  };
  const resolveThreadId = yield* DiscordInput.install<InputMessage, InputInteraction>(
    bot,
    config,
    () => eventRouter.drain(),
    httpClient,
    { botRoot: yield* discordBotRoot(options.picoRoot, bot.id.toString()), outputClient },
  );
  const dispatch = DiscordOutput.make(outputClient, yield* Scope.Scope, config);

  yield* pumpOutput(eventRouter, resolveThreadId, dispatch);

  yield* openBot(bot, config, joinedGuildIds);
  return DiscordOutput.makeReplyDelivery(outputClient);
});

// Daemon starts Discord and receives the authenticated bot identity on READY.
export const layer = (config: DiscordConfig, options: DiscordOptions) =>
  Layer.effect(ReplyDelivery, start(config, options)).pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "error" })),
      ),
    ),
  );
