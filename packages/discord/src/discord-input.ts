import type { DiscordConfig } from "@pico/config/config";
import type * as AgentMessage from "@pico/contract/agent-message";
import type { ContextUsage, MessageDelivery, ShakeResult } from "@pico/contract/agent-runtime";
import { Application, type CloseChatResult } from "@pico/contract/application";
import type * as Chat from "@pico/contract/chat-model";
import { ApplicationError, type WorkspaceBindingInvalid } from "@pico/contract/errors";
import {
  ScheduleHostError,
  type SchedulePlatform,
  type ScheduleTarget,
} from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
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
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { AcknowledgementIntent, InteractionAcknowledger } from "./discord-acknowledgement.ts";
import * as DiscordBtw from "./discord-btw.ts";
import * as DiscordCommand from "./discord-command.ts";
import { discordError, promiseBoundary, reportFailure } from "./discord-error.ts";
import * as DiscordMarkdown from "./discord-markdown.ts";
import * as DiscordModel from "./discord-model.ts";
import { type DiscordMessage, projectDiscordPrompt } from "./discord-prompt.ts";

export interface DiscordChannel {
  readonly id: bigint;
  readonly guildId?: bigint;
  readonly type: ChannelTypes;
  readonly parentId?: bigint;
  readonly name?: string;
  readonly archived?: boolean;
  readonly locked?: boolean;
}

export interface DiscordInteraction {
  readonly id: bigint;
  readonly token: string;
  acknowledged: boolean;
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
  readonly edit: (options: InteractionCallbackData) => Promise<unknown>;
  readonly respond: (options: InteractionCallbackData) => Promise<unknown>;
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
    readonly addReaction: (channelId: bigint, messageId: bigint, reaction: string) => Promise<void>;
    readonly deleteOwnReaction: (
      channelId: bigint,
      messageId: bigint,
      reaction: string,
    ) => Promise<void>;
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
    readonly startThreadWithoutMessage: (
      channelId: bigint,
      options: {
        readonly name: string;
        readonly autoArchiveDuration: 1_440;
        readonly type: ChannelTypes.PublicThread;
      },
    ) => Promise<{ readonly id: bigint }>;
    readonly deleteChannel: (channelId: bigint) => Promise<unknown>;
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
// Interaction tokens last 15 minutes. Leave five minutes for public response delivery.
const btwResponseDeadline = "10 minutes";
const closedMessage = "This chat is closed. Start a new thread to continue.";
const decodeThreadId = Schema.decodeUnknownEffect(Schema.BigIntFromString);
const encodeWorkspaceExternalId = Schema.encodeSync(Workspace.DiscordWorkspaceExternalId);
const workspaceExternalId = (guildId: bigint, channelId: bigint) =>
  encodeWorkspaceExternalId([guildId.toString(), ".", channelId.toString()]);
const decodeWorkspaceExternalId = Schema.decodeUnknownEffect(Workspace.DiscordWorkspaceExternalId);
const decodeScheduleId = Schema.decodeUnknownEffect(
  Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,19}$/u)).pipe(
    Schema.decodeTo(
      Schema.BigIntFromString.check(
        Schema.isBetweenBigInt({ minimum: 1n, maximum: 18_446_744_073_709_551_615n }),
      ),
    ),
  ),
);
const scheduleFailure = (error: { readonly message: string }) =>
  new ScheduleHostError({ message: error.message });

export const install = Effect.fn("DiscordInput.install")(function* <
  Message extends DiscordMessage,
  Interaction extends DiscordInteraction,
>(
  bot: DiscordInputBot<Message, Interaction>,
  config: DiscordConfig,
  acknowledgeInteraction: InteractionAcknowledger<Interaction>,
  drainOutput: () => Effect.Effect<void> = () => Effect.void,
  httpClient?: HttpClient.HttpClient,
) {
  const application = yield* Application;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const run = yield* FiberSet.makeRuntime();
  const allowedGuildIds = new Set(config.allowedGuildIds);
  const workspaceIds = new Map<bigint, Workspace.WorkspaceId>();
  const chatIds = new Map<bigint, Chat.ChatId>();
  const threadIds = new Map<Chat.ChatId, bigint>();
  const inputLocks = new Map<
    bigint,
    {
      readonly semaphore: Semaphore.Semaphore;
      readonly btwReplies: Set<Deferred.Deferred<void>>;
      acceptingBtw: boolean;
      knownThread: boolean;
    }
  >();
  const workspaceLocks = new Map<bigint, Semaphore.Semaphore>();
  const closeConfirmations = new Map<string, CloseConfirmation>();
  const allowedMentions = { parse: [], repliedUser: false } satisfies {
    parse: [];
    repliedUser: false;
  };
  const formatNumber = new Intl.NumberFormat("en-US").format;

  const inputLock = (channelId: bigint) => {
    const existing = inputLocks.get(channelId);
    if (existing !== undefined) return existing;
    const entry = {
      semaphore: Semaphore.makeUnsafe(1),
      btwReplies: new Set<Deferred.Deferred<void>>(),
      acceptingBtw: true,
      knownThread: false,
    };
    inputLocks.set(channelId, entry);
    return entry;
  };
  const threadLock = (threadId: bigint) => {
    const entry = inputLock(threadId);
    entry.knownThread = true;
    return entry.semaphore;
  };

  const cacheChat = (threadId: bigint, chatId: Chat.ChatId) => {
    const previousChatId = chatIds.get(threadId);
    if (previousChatId !== undefined && previousChatId !== chatId) {
      threadIds.delete(previousChatId);
    }
    const previousThreadId = threadIds.get(chatId);
    if (previousThreadId !== undefined && previousThreadId !== threadId) {
      chatIds.delete(previousThreadId);
    }
    chatIds.set(threadId, chatId);
    threadIds.set(chatId, threadId);
  };

  const resolveThreadId = Effect.fn("Discord.resolveThreadId")(function* (chatId: Chat.ChatId) {
    const cached = threadIds.get(chatId);
    if (cached !== undefined) return Option.some(cached);

    const binding = yield* application.findChatPlatformBinding(chatId);
    if (Option.isNone(binding) || binding.value.platform !== "discord") {
      return Option.none<bigint>();
    }
    const threadId = yield* decodeThreadId(binding.value.externalId).pipe(
      Effect.mapError(() => discordError("decode-thread-binding", undefined)),
    );
    threadIds.set(chatId, threadId);
    return Option.some(threadId);
  });

  const resolveWorkspace = Effect.fn("Discord.resolveWorkspace")(function* (
    channelId: bigint,
    guildId: bigint,
    name?: string,
  ) {
    const cached = workspaceIds.get(channelId);
    if (cached !== undefined) return cached;

    const workspace = yield* application.getOrCreateWorkspaceByBinding({
      name: name ?? `Discord channel ${channelId.toString()}`,
      platform: "discord",
      externalId: workspaceExternalId(guildId, channelId),
      defaultCwd: config.defaultCwd,
      worktree: null,
    });
    workspaceIds.set(channelId, workspace.id);
    return workspace.id;
  });

  const scheduleChannel = Effect.fn("Discord.scheduleChannel")(function* (externalId: string) {
    const id = yield* decodeScheduleId(externalId);
    const channel = yield* promiseBoundary("resolve-schedule-channel", () =>
      bot.helpers.getChannel(id),
    );
    if (
      channel.id !== id ||
      channel.guildId === undefined ||
      !allowedGuildIds.has(channel.guildId.toString())
    ) {
      return yield* new ScheduleHostError({
        message: "Discord schedule destination is not in an allowed guild",
      });
    }
    return channel;
  }, Effect.mapError(scheduleFailure));

  const scheduleWorkspace = Effect.fn("Discord.scheduleWorkspace")(function* (externalId: string) {
    const [guildId, , channelId] = yield* decodeWorkspaceExternalId(externalId);
    const channel = yield* scheduleChannel(channelId);
    if (channel.guildId?.toString() !== guildId || channel.type !== ChannelTypes.GuildText) {
      return yield* new ScheduleHostError({
        message: "Discord schedule workspace must be its bound text channel",
      });
    }
    return channel;
  }, Effect.mapError(scheduleFailure));

  const scheduleThread = Effect.fn("Discord.scheduleThread")(function* (externalId: string) {
    const thread = yield* scheduleChannel(externalId);
    if (
      !isThread(thread.type) ||
      thread.parentId === undefined ||
      thread.guildId === undefined ||
      thread.archived !== false ||
      thread.locked !== false
    ) {
      return yield* new ScheduleHostError({
        message: "Discord schedule chat must be an open thread",
      });
    }
    const binding = workspaceExternalId(thread.guildId, thread.parentId);
    yield* scheduleWorkspace(binding);
    return { thread, binding };
  });

  const validateTarget: SchedulePlatform["validateTarget"] = Effect.fn(
    "Discord.validateScheduleTarget",
  )(function* (input) {
    if (input.kind === "workspace") {
      yield* scheduleWorkspace(input.workspaceExternalId);
      return;
    }
    const { binding } = yield* scheduleThread(input.chatExternalId);
    if (binding !== input.workspaceExternalId) {
      return yield* new ScheduleHostError({
        message: "Discord schedule thread belongs to another workspace",
      });
    }
  });

  const resolveTarget: SchedulePlatform["resolveTarget"] = Effect.fn(
    "Discord.resolveScheduleTarget",
  )(function* (input) {
    if (input.kind === "external-workspace") {
      const channel = yield* scheduleChannel(input.externalId);
      if (channel.type !== ChannelTypes.GuildText || channel.guildId === undefined) {
        return yield* new ScheduleHostError({
          message: "Discord schedule workspace must be a text channel",
        });
      }
      return {
        kind: "workspace",
        workspaceId: yield* resolveWorkspace(channel.id, channel.guildId, channel.name),
      } satisfies ScheduleTarget;
    }
    const { thread, binding } = yield* scheduleThread(input.externalId);
    const chat = yield* application.findChatByPlatformId("discord", binding, thread.id.toString());
    if (Option.isNone(chat) || chat.value.archivedAt !== null) {
      return yield* new ScheduleHostError({
        message: "Discord schedule thread has no open Pico chat binding",
      });
    }
    return { kind: "chat", chatId: chat.value.id } satisfies ScheduleTarget;
  }, Effect.mapError(scheduleFailure));

  const createThread: SchedulePlatform["createThread"] = Effect.fn("Discord.createScheduleThread")(
    function* (input) {
      const channel = yield* scheduleWorkspace(input.workspaceExternalId);
      const thread = yield* promiseBoundary("create-schedule-thread", () =>
        bot.helpers.startThreadWithoutMessage(channel.id, {
          name: threadName(input.title) || "Scheduled task",
          autoArchiveDuration: 1_440,
          type: ChannelTypes.PublicThread,
        }),
      );
      return thread.id.toString();
    },
    Effect.mapError(scheduleFailure),
  );

  const deleteThread: SchedulePlatform["deleteThread"] = Effect.fn("Discord.deleteScheduleThread")(
    function* (externalId) {
      const id = yield* decodeScheduleId(externalId);
      yield* promiseBoundary("delete-schedule-thread", () => bot.helpers.deleteChannel(id));
    },
    Effect.mapError(scheduleFailure),
  );

  // Effect.fn restores Context on return, so request helpers must stay in the terminal log scope.
  const resolveCommandChannel = Effect.fnUntraced(function* (interaction: Interaction) {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (
      guildId === undefined ||
      channelId === undefined ||
      !allowedGuildIds.has(guildId.toString())
    ) {
      return Option.none();
    }
    yield* Effect.annotateLogsScoped({ phase: "resolve-interaction-channel" });
    const channel = yield* promiseBoundary("resolve-interaction-channel", () =>
      bot.helpers.getChannel(channelId),
    );
    return channel.guildId === guildId && channel.type === ChannelTypes.GuildText
      ? Option.some({ guildId, channel })
      : Option.none();
  });

  const resolveCommandThread = Effect.fnUntraced(function* (interaction: Interaction) {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (
      guildId === undefined ||
      channelId === undefined ||
      !allowedGuildIds.has(guildId.toString())
    ) {
      return Option.none<CommandThread>();
    }

    yield* Effect.annotateLogsScoped({ phase: "resolve-interaction-channel" });
    const channel = yield* promiseBoundary("resolve-interaction-channel", () =>
      bot.helpers.getChannel(channelId),
    );
    if (channel.guildId !== guildId || !isThread(channel.type) || channel.parentId === undefined) {
      return Option.none<CommandThread>();
    }
    inputLock(channel.id).knownThread = true;
    return Option.some({ guildId, parentId: channel.parentId, threadId: channel.id });
  });

  const resolveCommandChatId = Effect.fnUntraced(function* (thread: CommandThread) {
    yield* Effect.annotateLogsScoped({
      phase: "resolve-chat",
      threadId: thread.threadId.toString(),
    });
    const cached = chatIds.get(thread.threadId);
    if (cached !== undefined) {
      yield* Effect.annotateLogsScoped({ chatId: cached });
      return Option.some(cached);
    }

    const chat = yield* application.findChatByPlatformId(
      "discord",
      workspaceExternalId(thread.guildId, thread.parentId),
      thread.threadId.toString(),
    );
    if (Option.isNone(chat)) return Option.none<Chat.ChatId>();
    workspaceIds.set(thread.parentId, chat.value.workspaceId);
    cacheChat(thread.threadId, chat.value.id);
    yield* Effect.annotateLogsScoped({
      chatId: chat.value.id,
      workspaceId: chat.value.workspaceId,
    });
    return Option.some(chat.value.id);
  });

  const resolveModelChatId = Effect.fnUntraced(function* (interaction: Interaction) {
    const thread = yield* resolveCommandThread(interaction);
    if (Option.isNone(thread)) return Option.none<Chat.ChatId>();
    return yield* resolveCommandChatId(thread.value);
  });

  const autocompleteModels = Effect.fnUntraced(function* (interaction: Interaction) {
    const request = yield* Effect.gen(function* () {
      const query = DiscordCommand.parseModelQuery(interaction.data?.options);
      if (query === undefined) return [];
      if (interaction.data?.name === "set-workspace-model") {
        const target = yield* resolveCommandChannel(interaction);
        if (Option.isNone(target)) return [];
        const { guildId, channel } = target.value;
        const models = yield* application.availableWorkspaceModels({
          binding: { platform: "discord", externalId: workspaceExternalId(guildId, channel.id) },
          defaultCwd: config.defaultCwd,
        });
        return yield* DiscordModel.choices(crypto, models, query, { includeOmpDefault: true });
      }
      const chatId = yield* resolveModelChatId(interaction);
      if (Option.isNone(chatId)) return [];
      const models = yield* application.availableModels(chatId.value);
      return yield* DiscordModel.choices(crypto, models, query);
    }).pipe(Effect.forkIn(scope));
    const choices = yield* Fiber.join(request).pipe(
      Effect.timeout("2 seconds"),
      Effect.ensuring(Effect.sync(() => request.interruptUnsafe())),
      Effect.catchTag("TimeoutError", () => Effect.succeed([])),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.succeed([])
          : reportFailure("autocomplete-models", cause).pipe(Effect.as([])),
      ),
    );
    yield* promiseBoundary("autocomplete-models", () => interaction.respond({ choices }));
  });

  const replyMessageFailure = Effect.fnUntraced(function* (
    cause: Cause.Cause<unknown>,
    threadId: bigint,
    content: string,
  ) {
    yield* reportFailure("message-request", cause);
    yield* promiseBoundary("reply-message-failure", () =>
      bot.helpers.sendMessage(threadId, { content, allowedMentions }),
    ).pipe(Effect.catchCause((replyCause) => reportFailure("reply-message-failure", replyCause)));
    return undefined;
  });

  const sendMessageToChat = Effect.fnUntraced(function* (
    chatId: Chat.ChatId,
    prompt: AgentMessage.AgentPrompt,
    channelId: bigint,
  ) {
    yield* Effect.annotateLogsScoped({ phase: "send-prompt", chatId });
    return yield* application.sendMessage(chatId, prompt).pipe(
      Effect.catchTag("ChatClosed", () =>
        promiseBoundary("reply-chat-closed", () =>
          bot.helpers.sendMessage(channelId, { content: closedMessage, allowedMentions }),
        ).pipe(
          Effect.catchCause((cause) => reportFailure("reply-chat-closed", cause)),
          Effect.as(undefined),
        ),
      ),
    );
  });

  const processMessage = Effect.fnUntraced(function* (
    message: Message,
    guildId: bigint,
    knownChannel?: DiscordChannel,
  ) {
    const sourceAttachments = message.attachments ?? [];
    if (message.content.trim().length === 0 && sourceAttachments.length === 0) {
      yield* promiseBoundary("reply-empty-message", () =>
        bot.helpers.sendMessage(message.channelId, {
          content: "Send text or an image to start or continue a chat.",
          allowedMentions,
        }),
      );
      return;
    }

    yield* Effect.annotateLogsScoped({ phase: "project-prompt" });
    const prompt = yield* projectDiscordPrompt(message, httpClient).pipe(
      Effect.catchTag(
        "DiscordAttachmentError",
        Effect.fnUntraced(function* (error) {
          if (error.reason !== "policy") {
            yield* Effect.logError("Discord attachment download failed", Cause.fail(error)).pipe(
              Effect.annotateLogs({
                operation: "download-attachment",
                reason: error.reason,
                status: error.status,
                attachmentIndex: error.attachmentIndex,
                timeoutPhase: error.phase,
              }),
            );
          }
          yield* Effect.annotateLogsScoped({ phase: "reject-attachments" });
          yield* promiseBoundary("reject-attachments", () =>
            bot.helpers.sendMessage(message.channelId, { content: error.reply, allowedMentions }),
          );
          return undefined;
        }),
      ),
    );
    if (prompt === undefined) return;

    const cachedChatId = chatIds.get(message.channelId);
    if (cachedChatId !== undefined) {
      return yield* sendMessageToChat(cachedChatId, prompt, message.channelId);
    }

    yield* Effect.annotateLogsScoped({ phase: "resolve-channel" });
    const channel =
      knownChannel ??
      (yield* promiseBoundary("resolve-channel", () => bot.helpers.getChannel(message.channelId)));

    if (isThread(channel.type)) {
      if (channel.parentId === undefined) return;

      yield* Effect.annotateLogsScoped({ phase: "resolve-chat", threadId: channel.id.toString() });
      const chat = yield* application.findChatByPlatformId(
        "discord",
        workspaceExternalId(guildId, channel.parentId),
        channel.id.toString(),
      );
      if (Option.isNone(chat)) return;

      workspaceIds.set(channel.parentId, chat.value.workspaceId);
      cacheChat(channel.id, chat.value.id);
      yield* Effect.annotateLogsScoped({ workspaceId: chat.value.workspaceId });
      return yield* sendMessageToChat(chat.value.id, prompt, message.channelId);
    }

    if (channel.type !== ChannelTypes.GuildText) return;

    yield* Effect.annotateLogsScoped({ phase: "resolve-workspace" });
    const workspaceId = yield* resolveWorkspace(channel.id, guildId, channel.name);
    yield* Effect.annotateLogsScoped({ phase: "create-thread", workspaceId });
    const thread = yield* promiseBoundary("create-thread", () =>
      bot.helpers.startThreadWithMessage(channel.id, message.id, {
        name:
          threadName(message.content) ||
          threadName(prompt.attachments[0]?.name ?? "") ||
          "Image attachment",
        autoArchiveDuration: 1_440,
      }),
    );
    yield* Effect.annotateLogsScoped({ phase: "create-chat", threadId: thread.id.toString() });
    let failureMessage = "pico could not start a chat in this thread.";
    const delivery = yield* threadLock(thread.id)
      .withPermit(
        Effect.gen(function* () {
          const chat = yield* application.createChat({
            workspaceId,
            externalId: thread.id.toString(),
          });
          cacheChat(thread.id, chat.id);
          failureMessage = "pico could not submit your opening message.";
          return yield* sendMessageToChat(chat.id, prompt, thread.id);
        }),
      )
      .pipe(Effect.catchCause((cause) => replyMessageFailure(cause, thread.id, failureMessage)));
    if (delivery === undefined || delivery.kind === "handled") return delivery;
    return {
      ...delivery,
      completed: delivery.completed.pipe(
        Effect.catchCause((cause) =>
          replyMessageFailure(
            cause,
            thread.id,
            "pico could not finish processing your opening message.",
          ),
        ),
      ),
    };
  });

  const handleMessage = Effect.fnUntraced(function* (message: Message) {
    const guildId = message.guildId;
    if (
      guildId === undefined ||
      !allowedGuildIds.has(guildId.toString()) ||
      message.webhookId !== undefined ||
      message.author.bot === true ||
      message.author.id === bot.id
    ) {
      return;
    }
    if (inputLocks.get(message.channelId)?.knownThread === true || chatIds.has(message.channelId)) {
      return yield* threadLock(message.channelId).withPermit(processMessage(message, guildId));
    }
    const entry = inputLock(message.channelId);
    const result = yield* entry.semaphore.withPermit(
      Effect.gen(function* () {
        yield* Effect.annotateLogsScoped({ phase: "resolve-channel" });
        const channel = yield* promiseBoundary("resolve-channel", () =>
          bot.helpers.getChannel(message.channelId),
        );
        if (isThread(channel.type)) {
          entry.knownThread = true;
          const delivery = yield* processMessage(message, guildId, channel);
          return { kind: "thread", delivery } as const;
        }
        return { kind: "parent", channel } as const;
      }),
    );
    if (result.kind === "thread") return result.delivery;
    return yield* processMessage(message, guildId, result.channel);
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

  const bindResponse = Effect.fnUntraced(function* (
    interaction: Interaction,
    command: DiscordCommand.BindCommand,
  ) {
    const target = yield* resolveCommandChannel(interaction);
    if (Option.isNone(target)) {
      return "This command can only be used in a configured server text channel.";
    }
    const { guildId, channel } = target.value;

    yield* Effect.annotateLogsScoped({ phase: "bind-workspace" });
    switch (command.kind) {
      case "malformedBind":
        return "Use /bind set with cwd, or /bind worktree with repository, branch, and prefix.";
      case "bindDirect": {
        const workspace = yield* application.bindWorkspace({
          binding: {
            platform: "discord",
            externalId: workspaceExternalId(guildId, channel.id),
          },
          workspaceName: channel.name ?? channel.id.toString(),
          configuration: { kind: "direct", cwd: command.cwd },
        });
        workspaceIds.set(channel.id, workspace.id);
        yield* Effect.annotateLogsScoped({ workspaceId: workspace.id });
        return `Workspace binding updated to ${workspace.defaultCwd}. Worktrees are disabled for new chats.`;
      }
      case "bindWorktree": {
        const workspace = yield* application.bindWorkspace({
          binding: {
            platform: "discord",
            externalId: workspaceExternalId(guildId, channel.id),
          },
          workspaceName: channel.name ?? channel.id.toString(),
          configuration: {
            kind: "worktree",
            repository: command.repository,
            settings: { branch: command.branch, prefix: command.prefix },
          },
        });
        workspaceIds.set(channel.id, workspace.id);
        yield* Effect.annotateLogsScoped({ workspaceId: workspace.id });
        return `Workspace worktrees configured from ${workspace.defaultCwd}. This affects new chats only.`;
      }
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  });

  const workspaceModelResponse = Effect.fnUntraced(function* (
    interaction: Interaction,
    command: DiscordCommand.WorkspaceModelCommand,
  ) {
    const target = yield* resolveCommandChannel(interaction);
    if (Option.isNone(target)) {
      return "This command can only be used in a configured server text channel.";
    }
    if (command.kind === "malformedWorkspaceModel") {
      return "Choose a model from the /set-workspace-model suggestions.";
    }
    const { guildId, channel } = target.value;
    const workspaceId = yield* resolveWorkspace(channel.id, guildId, channel.name);
    yield* Effect.annotateLogsScoped({ phase: "set-workspace-model", workspaceId });
    if (command.model === DiscordModel.ompDefault.value) {
      yield* application.setWorkspaceModel(workspaceId, null);
      return "New chats will inherit the OMP default model. Only new chats are affected.";
    }
    const models = yield* application.availableWorkspaceModels({
      binding: { platform: "discord", externalId: workspaceExternalId(guildId, channel.id) },
      defaultCwd: config.defaultCwd,
    });
    const model = yield* DiscordModel.resolve(crypto, models, command.model);
    if (model === undefined) {
      return "That model is unavailable. Choose a model from the suggestions.";
    }
    yield* application.setWorkspaceModel(workspaceId, { provider: model.provider, id: model.id });
    return `Workspace model set to ${DiscordModel.label(model)}. Only new chats are affected.`;
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

  const shakeResponse = Effect.fnUntraced(function* (
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
    yield* Effect.annotateLogsScoped({ phase: "shake-chat" });
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

  const contextResponse = Effect.fnUntraced(function* (interaction: Interaction) {
    const policyCopy = "This command can only be used in a pico-owned Discord thread.";
    const thread = yield* resolveCommandThread(interaction);
    if (Option.isNone(thread)) return policyCopy;

    const chatId = yield* resolveCommandChatId(thread.value);
    if (Option.isNone(chatId)) return policyCopy;
    yield* Effect.annotateLogsScoped({ phase: "context-usage" });
    return formatContextUsage(yield* application.contextUsage(chatId.value));
  });

  const switchResponse = Effect.fnUntraced(function* (
    interaction: Interaction,
    command: DiscordCommand.SwitchCommand,
  ) {
    if (command.kind === "malformedSwitch") return "Choose a model from the /switch suggestions.";
    const policyCopy = "This command can only be used in a pico-owned Discord thread.";
    const chatId = yield* resolveModelChatId(interaction);
    if (Option.isNone(chatId)) return policyCopy;
    const models = yield* application.availableModels(chatId.value);
    const model = yield* DiscordModel.resolve(crypto, models, command.model);
    if (model === undefined)
      return "That model is unavailable. Choose a model from the suggestions.";
    yield* Effect.annotateLogsScoped({ phase: "switch-model" });
    const selected = yield* application.switchModel(chatId.value, {
      provider: model.provider,
      id: model.id,
    });
    const confirmation = `Switched this chat to ${DiscordModel.label(selected.model)}.`;
    switch (selected.kind) {
      case "persisted":
        return confirmation;
      case "persistence-unconfirmed":
        yield* reportFailure(
          "persist-model-selection",
          Cause.fail(
            new ApplicationError({
              reason: "operation",
              message: "Model selection persistence could not be confirmed",
            }),
          ),
          "warning",
        );
        return `${confirmation} Saving this choice could not be confirmed. A restart may lose it.`;
      default: {
        const exhaustive: never = selected.kind;
        return exhaustive;
      }
    }
  });

  const handleBtw = Effect.fn("Discord.handleBtw")(function* (
    interaction: Interaction,
    command: DiscordCommand.BtwCommand,
  ) {
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // Native cancellation may drain slowly; the Discord scope owns it past the reply deadline.
        const request = yield* Effect.gen(function* () {
          if (command.kind === "malformedBtw") return "Provide a non-empty question.";
          const policyCopy = "This command can only be used in a pico-owned Discord thread.";
          const thread = yield* resolveCommandThread(interaction);
          if (Option.isNone(thread) || interaction.user === undefined) return policyCopy;
          const chatId = yield* resolveCommandChatId(thread.value);
          if (Option.isNone(chatId)) return policyCopy;
          yield* Effect.annotateLogsScoped({ phase: "ask-btw" });
          const answer = yield* application.askBtw(chatId.value, command.question);
          return answer.length === 0 ? "pico returned no text for this question." : answer;
        }).pipe(Effect.forkIn(scope));
        const response = yield* restore(
          Fiber.join(request).pipe(Effect.timeout(btwResponseDeadline)),
        ).pipe(
          Effect.ensuring(Effect.sync(() => request.interruptUnsafe())),
          Effect.catchTag("ChatClosed", () => Effect.succeed(closedMessage)),
          Effect.catchTag("TimeoutError", () =>
            Effect.succeed("This /btw request timed out. Try a shorter question."),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.succeed("This /btw request was cancelled.")
              : reportFailure("ask-btw", cause).pipe(
                  Effect.as("pico could not answer this side question."),
                ),
          ),
        );
        const chunks =
          command.kind === "btw" && interaction.user !== undefined
            ? DiscordBtw.format({
                userId: interaction.user.id,
                question: command.question,
                answer: response,
              })
            : DiscordMarkdown.split(response);
        for (const [index, chunk] of chunks.entries()) {
          yield* promiseBoundary("reply-btw", () =>
            index === 0
              ? interaction.edit({ content: chunk.content, allowedMentions })
              : interaction.respond({ content: chunk.content, allowedMentions }),
          );
        }
      }),
    ).pipe(Effect.catchCause((cause) => reportFailure("reply-btw", cause)));
  });

  const abortResponse = Effect.fnUntraced(function* (interaction: Interaction) {
    const policyCopy = "This command can only be used in a pico-owned Discord thread.";
    const thread = yield* resolveCommandThread(interaction);
    if (Option.isNone(thread)) return policyCopy;

    const chatId = yield* resolveCommandChatId(thread.value);
    if (Option.isNone(chatId)) return policyCopy;
    yield* Effect.annotateLogsScoped({ phase: "abort-chat" });
    yield* application.abort(chatId.value);
    return "Stop request processed. Any queued messages may still run.";
  });

  const archiveThread = Effect.fnUntraced(function* (threadId: bigint) {
    const entry = inputLock(threadId);
    entry.acceptingBtw = false;
    yield* Effect.annotateLogsScoped({ phase: "drain-output" });
    yield* drainOutput();
    for (const finished of entry.btwReplies) {
      yield* Deferred.await(finished);
    }
    yield* Effect.annotateLogsScoped({ phase: "archive-thread" });
    yield* promiseBoundary("archive-thread", () =>
      bot.helpers.editChannel(threadId, { archived: true, locked: true }),
    );
  });
  const closeResultResponse = Effect.fnUntraced(function* (
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
      return yield* archiveThread(thread.threadId).pipe(
        Effect.as("Chat closed. The transcript remains available in this archived thread."),
        Effect.catchCause((cause) =>
          reportFailure("archive-thread", cause).pipe(
            Effect.as("Chat closed, but pico could not archive the Discord thread."),
          ),
        ),
        Effect.annotateLogs({ chatId, threadId: thread.threadId.toString() }),
      );
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
        Effect.catchCause((cause) => reportFailure("expire-close-confirmation", cause)),
        Effect.annotateLogs({ chatId, threadId: thread.threadId.toString() }),
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

  const closeResponse = Effect.fnUntraced(function* (interaction: Interaction) {
    const policyCopy = "This command can only be used in a persisted pico chat thread.";
    const requesterId = interaction.user?.id;
    if (requesterId === undefined) return policyCopy;
    const thread = yield* resolveCommandThread(interaction);
    if (Option.isNone(thread)) return policyCopy;
    const chatId = yield* resolveCommandChatId(thread.value);
    if (Option.isNone(chatId)) return policyCopy;

    yield* Effect.annotateLogsScoped({ phase: "close-chat" });
    const result = yield* application.closeChat(chatId.value, { allowDirtyWorktree: false });
    return yield* closeResultResponse(result, thread.value, requesterId, chatId.value);
  });

  const closeConfirmationResponse = Effect.fnUntraced(function* (
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

    yield* Effect.annotateLogsScoped({ chatId: confirmation.chatId });
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

    yield* Effect.annotateLogsScoped({ phase: "close-chat" });
    return yield* application.closeChat(chatId.value, { allowDirtyWorktree: true }).pipe(
      Effect.flatMap((result) =>
        closeResultResponse(result, thread.value, confirmation.requesterId, chatId.value),
      ),
      Effect.map((response) =>
        typeof response === "string"
          ? ({ content: response, components: [] } satisfies ComponentResponse)
          : response,
      ),
    );
  });

  const handleInteraction = Effect.fnUntraced(function* (
    interaction: Interaction,
    command: DiscordCommand.Command,
  ) {
    if (command.kind === "btw" || command.kind === "malformedBtw") {
      return yield* handleBtw(interaction, command);
    }
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
              reportFailure("bind-workspace", cause).pipe(
                Effect.as("pico could not update this workspace."),
              ),
            ),
          );
        case "setWorkspaceModel":
        case "malformedWorkspaceModel":
          return workspaceModelResponse(interaction, command).pipe(
            Effect.catchCause((cause) =>
              reportFailure("set-workspace-model", cause).pipe(
                Effect.as("pico could not update this workspace's model. Please try again."),
              ),
            ),
          );
        case "shake":
        case "malformedShake":
          return shakeResponse(interaction, command).pipe(
            Effect.catchTag("ChatClosed", () => Effect.succeed(closedMessage)),
            Effect.catchCause((cause) =>
              reportFailure("shake-chat", cause).pipe(Effect.as("pico could not shake this chat.")),
            ),
          );
        case "switch":
        case "malformedSwitch":
          return switchResponse(interaction, command).pipe(
            Effect.catchTag("ChatClosed", () => Effect.succeed(closedMessage)),
            Effect.catchCause((cause) =>
              reportFailure("switch-model", cause).pipe(
                Effect.as("pico could not switch this chat's model. Please try again."),
              ),
            ),
          );
        case "context":
          return contextResponse(interaction).pipe(
            Effect.catchTag("ChatClosed", () => Effect.succeed(closedMessage)),
            Effect.catchCause((cause) =>
              reportFailure("context-usage", cause).pipe(
                Effect.as("pico could not read this chat's context."),
              ),
            ),
          );
        case "abort":
          return abortResponse(interaction).pipe(
            Effect.catchCause((cause) =>
              reportFailure("abort-chat", cause).pipe(
                Effect.as("pico could not stop this chat's current run."),
              ),
            ),
          );
        case "close":
          return closeResponse(interaction).pipe(
            Effect.catchCause((cause) =>
              reportFailure("close-chat", cause).pipe(Effect.as("pico could not close this chat.")),
            ),
          );
        default: {
          const exhaustive: never = command;
          return exhaustive;
        }
      }
    })();
    yield* editInteraction(interaction, response);
  });

  const editInteraction = Effect.fnUntraced(function* (
    interaction: Interaction,
    response: string | ComponentResponse,
  ) {
    yield* Effect.annotateLogsScoped({ phase: "edit-interaction" });
    yield* promiseBoundary("edit-interaction", () =>
      interaction.edit(
        typeof response === "string"
          ? { content: response, allowedMentions }
          : { ...response, allowedMentions },
      ),
    ).pipe(Effect.catchCause((cause) => reportFailure("edit-interaction", cause)));
  });

  bot.events.messageCreate = (message) => {
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const delivery: MessageDelivery<ApplicationError> | undefined =
            yield* handleMessage(message);
          if (delivery === undefined || delivery.kind === "handled") return;

          yield* delivery.completed.pipe(
            Effect.catchCause((cause) => reportFailure("message-request", cause)),
            Effect.forkIn(scope),
          );
          if (delivery.kind !== "steered") return;

          yield* Effect.gen(function* () {
            yield* promiseBoundary("add-pending-reaction", () =>
              bot.helpers.addReaction(message.channelId, message.id, "⏳"),
            ).pipe(Effect.catchCause((cause) => reportFailure("add-pending-reaction", cause)));
            const outcome = yield* delivery.consumed;
            yield* promiseBoundary("remove-pending-reaction", () =>
              bot.helpers.deleteOwnReaction(message.channelId, message.id, "⏳"),
            ).pipe(Effect.catchCause((cause) => reportFailure("remove-pending-reaction", cause)));
            if (outcome === "consumed") {
              yield* promiseBoundary("add-consumed-reaction", () =>
                bot.helpers.addReaction(message.channelId, message.id, "↩️"),
              ).pipe(Effect.catchCause((cause) => reportFailure("add-consumed-reaction", cause)));
            }
          }).pipe(Effect.forkIn(scope));
        }).pipe(
          Effect.catchCause((cause) => reportFailure("message-request", cause)),
          Effect.annotateLogs({
            component: "discord",
            eventType: "messageCreate",
            guildId: message.guildId?.toString(),
            channelId: message.channelId.toString(),
            messageId: message.id.toString(),
          }),
        ),
      ),
    );
  };

  bot.events.interactionCreate = (interaction) => {
    if (interaction.guildId === undefined && interaction.data?.name !== "set-workspace-model")
      return;
    const customId = interaction.data?.customId;
    const closeNonce =
      interaction.type === InteractionTypes.MessageComponent &&
      customId?.startsWith(closeConfirmationPrefix) === true
        ? customId.slice(closeConfirmationPrefix.length)
        : undefined;
    const name = interaction.data?.name;
    if (
      interaction.type === InteractionTypes.ApplicationCommandAutocomplete &&
      (name === "switch" || name === "set-workspace-model")
    ) {
      run(
        Effect.scoped(autocompleteModels(interaction)).pipe(
          Effect.catchCause((cause) => reportFailure("autocomplete-models", cause)),
          Effect.annotateLogs({
            component: "discord",
            eventType: "interactionCreate",
            command: name,
            interactionId: interaction.id.toString(),
            guildId: interaction.guildId?.toString(),
            channelId: interaction.channelId?.toString(),
          }),
        ),
      );
      return;
    }
    const isCommand =
      interaction.type === InteractionTypes.ApplicationCommand &&
      DiscordCommand.applicationCommands.some((command) => command.name === name);
    if (closeNonce === undefined && !isCommand) return;

    const response = Effect.scoped(
      Effect.gen(function* () {
        const channelId = interaction.channelId;
        const btwClosed =
          name === "btw" && channelId !== undefined
            ? (yield* Effect.acquireRelease(
                Effect.sync(() => {
                  const entry = inputLock(channelId);
                  if (!entry.acceptingBtw) return undefined;
                  const finished = Deferred.makeUnsafe<void>();
                  entry.btwReplies.add(finished);
                  return { replies: entry.btwReplies, finished };
                }),
                (registration) =>
                  Effect.sync(() => {
                    if (registration === undefined) return;
                    registration.replies.delete(registration.finished);
                    Deferred.doneUnsafe(registration.finished, Effect.void);
                  }),
              )) === undefined
            : false;
        yield* Effect.annotateLogsScoped({ phase: "defer" });
        const acknowledgementIntent: AcknowledgementIntent =
          closeNonce === undefined
            ? {
                kind: "reply",
                visibility: name !== "btw" || btwClosed ? "private" : "public",
              }
            : { kind: "update-source-message" };
        yield* acknowledgeInteraction(interaction, acknowledgementIntent);
        yield* Effect.annotateLogsScoped({ phase: "request" });
        if (btwClosed) return yield* editInteraction(interaction, closedMessage);
        const command =
          closeNonce === undefined
            ? DiscordCommand.parse(name, interaction.data?.options)
            : undefined;
        const effect =
          closeNonce !== undefined
            ? closeConfirmationResponse(interaction, closeNonce).pipe(
                Effect.catchCause((cause) =>
                  reportFailure("close-confirmation", cause).pipe(
                    Effect.as({
                      content: "pico could not close this chat.",
                      components: [],
                    } satisfies ComponentResponse),
                  ),
                ),
                Effect.flatMap((response) => editInteraction(interaction, response)),
              )
            : command === undefined
              ? undefined
              : handleInteraction(interaction, command);
        if (effect === undefined) return;
        if (channelId === undefined || command?.kind === "abort" || name === "btw") {
          yield* effect;
          return;
        }
        if (closeNonce === undefined && (name === "bind" || name === "set-workspace-model")) {
          let semaphore = workspaceLocks.get(channelId);
          if (semaphore === undefined) {
            semaphore = Semaphore.makeUnsafe(1);
            workspaceLocks.set(channelId, semaphore);
          }
          yield* semaphore.withPermit(effect);
          return;
        }
        yield* inputLock(channelId).semaphore.withPermit(effect);
      }).pipe(
        Effect.catchCause((cause) => reportFailure("interaction-request", cause)),
        Effect.annotateLogs({
          component: "discord",
          eventType: "interactionCreate",
          command: closeNonce === undefined ? name : "close-confirmation",
          interactionId: interaction.id.toString(),
          guildId: interaction.guildId?.toString(),
          channelId: interaction.channelId?.toString(),
        }),
      ),
    );
    run(response);
  };

  return {
    resolveThreadId,
    schedule: {
      platform: "discord",
      resolveTarget,
      validateTarget,
      createThread,
      deleteThread,
    } satisfies Omit<SchedulePlatform, "send">,
  };
});
