import type { DiscordConfig } from "@pico/config/config";
import * as AgentMessage from "@pico/contract/agent-message";
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
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
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
  readonly attachments?: ReadonlyArray<{
    readonly filename: string;
    readonly contentType?: string;
    readonly size: number;
    readonly url: string;
  }>;
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

const maximumAttachmentCount = AgentMessage.MAX_AGENT_IMAGE_ATTACHMENTS;
const maximumAttachmentBytes = AgentMessage.MAX_AGENT_IMAGE_ATTACHMENT_BYTES;
const maximumMessageAttachmentBytes = AgentMessage.MAX_AGENT_IMAGE_BYTES;
const attachmentPolicyMessage =
  "Attach up to 10 PNG, JPEG, GIF, or WebP images. Each image must be 20 MiB or smaller, with 40 MiB total.";
const attachmentDownloadMessage =
  "I couldn't read every image attachment. Try sending the message again.";

class DiscordAttachmentError extends Schema.TaggedError<DiscordAttachmentError>()(
  "DiscordAttachmentError",
  { reply: Schema.String },
) {}

const attachmentError = (reply: string) => new DiscordAttachmentError({ reply });

const sanitizeAttachmentName = (name: string, index: number) => {
  const safeCharacters = Array.from(name, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return " ";
    }
    return character === "/" || character === "\\" ? "_" : character;
  }).join("");
  const normalized = safeCharacters.trim().replace(/\s+/g, " ");
  const sanitized = Array.from(normalized).slice(0, 100).join("");
  return sanitized.length === 0 ? `image-${index + 1}` : sanitized;
};

const hasBytes = (bytes: Uint8Array, expected: ReadonlyArray<number>) =>
  bytes.length >= expected.length && expected.every((byte, index) => bytes[index] === byte);

const sniffImageMimeType = (bytes: Uint8Array): AgentMessage.AgentImageMimeType | undefined => {
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return "image/gif";
  if (hasBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (
    hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
};
const maximumImageEdge = AgentMessage.MAX_AGENT_IMAGE_EDGE;
const maximumImagePixels = AgentMessage.MAX_AGENT_IMAGE_PIXELS;

const validateDecodedImage = Effect.fn("Discord.validateDecodedImage")(function* (
  bytes: Uint8Array,
) {
  const metadata = yield* Effect.tryPromise({
    try: () => new Bun.Image(bytes).metadata(),
    catch: () => attachmentError(attachmentPolicyMessage),
  });
  if (
    metadata.width < 1 ||
    metadata.height < 1 ||
    metadata.width > maximumImageEdge ||
    metadata.height > maximumImageEdge ||
    metadata.width * metadata.height > maximumImagePixels
  ) {
    return yield* Effect.fail(attachmentError(attachmentPolicyMessage));
  }
});

const attachmentUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "cdn.discordapp.com" ||
        url.port.length > 0 ||
        url.username.length > 0 ||
        url.password.length > 0
      ) {
        throw new Error("Invalid attachment URL");
      }
      return url;
    },
    catch: () => attachmentError(attachmentDownloadMessage),
  });

interface AttachmentBodyState {
  readonly chunks: Uint8Array[];
  readonly length: number;
}

const emptyAttachmentBody = (): AttachmentBodyState => ({ chunks: [], length: 0 });

const readBoundedBody = Effect.fn("Discord.readBoundedAttachment")(function* (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
) {
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(attachmentError(attachmentDownloadMessage));
  }
  const contentLength = response.headers["content-length"];
  if (contentLength !== undefined) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > limit) {
      return yield* Effect.fail(attachmentError(attachmentPolicyMessage));
    }
  }

  const state = yield* response.stream.pipe(
    Stream.runFoldEffect(emptyAttachmentBody, (current, chunk) => {
      const length = current.length + chunk.byteLength;
      if (length > limit) return Effect.fail(attachmentError(attachmentPolicyMessage));
      current.chunks.push(chunk);
      return Effect.succeed({ chunks: current.chunks, length });
    }),
    Effect.mapError((error) =>
      error instanceof DiscordAttachmentError ? error : attachmentError(attachmentDownloadMessage),
    ),
  );
  const bytes = new Uint8Array(state.length);
  let offset = 0;
  for (const chunk of state.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});

const projectDiscordPrompt = Effect.fn("Discord.projectPrompt")(function* (
  message: DiscordMessage,
  httpClient: HttpClient.HttpClient | undefined,
) {
  const source = message.attachments ?? [];
  if (source.length > maximumAttachmentCount) {
    return yield* Effect.fail(attachmentError(attachmentPolicyMessage));
  }
  let declaredTotal = 0;
  for (const attachment of source) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      return yield* Effect.fail(attachmentError(attachmentPolicyMessage));
    }
    declaredTotal += attachment.size;
    if (attachment.size > maximumAttachmentBytes || declaredTotal > maximumMessageAttachmentBytes) {
      return yield* Effect.fail(attachmentError(attachmentPolicyMessage));
    }
  }
  if (source.length > 0 && httpClient === undefined) {
    return yield* Effect.fail(attachmentError(attachmentDownloadMessage));
  }

  const attachments: AgentMessage.AgentImageAttachment[] = [];
  let actualTotal = 0;
  for (const [index, attachment] of source.entries()) {
    if (httpClient === undefined) {
      return yield* Effect.fail(attachmentError(attachmentDownloadMessage));
    }
    const url = yield* attachmentUrl(attachment.url);
    const remaining = maximumMessageAttachmentBytes - actualTotal;
    const bytes = yield* httpClient.get(url).pipe(
      Effect.mapError(() => attachmentError(attachmentDownloadMessage)),
      Effect.flatMap((response) =>
        readBoundedBody(response, Math.min(maximumAttachmentBytes, remaining)),
      ),
      Effect.timeout("15 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(attachmentError(attachmentDownloadMessage)),
      ),
    );
    const mimeType = sniffImageMimeType(bytes);
    if (mimeType === undefined) {
      return yield* Effect.fail(attachmentError(attachmentPolicyMessage));
    }
    yield* validateDecodedImage(bytes);
    actualTotal += bytes.byteLength;
    attachments.push({
      type: "image",
      name: sanitizeAttachmentName(attachment.filename, index),
      data: Buffer.from(bytes).toString("base64"),
      mimeType,
    });
  }
  return AgentMessage.AgentPrompt.make({ text: message.content, attachments });
});

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
const decodeThreadId = Schema.decodeUnknownEffect(Schema.BigIntFromString);

export const install = Effect.fn("DiscordInput.install")(function* <
  Message extends DiscordMessage,
  Interaction extends DiscordInteraction,
>(
  bot: DiscordInputBot<Message, Interaction>,
  config: DiscordConfig,
  drainOutput: () => Effect.Effect<void> = () => Effect.void,
  httpClient?: HttpClient.HttpClient,
) {
  const application = yield* Application;
  const crypto = yield* Crypto.Crypto;
  const run = yield* FiberSet.makeRuntime();
  const allowedGuildIds = new Set(config.allowedGuildIds);
  const workspaceIds = new Map<bigint, Workspace.WorkspaceId>();
  const chatIds = new Map<bigint, Chat.ChatId>();
  const threadIds = new Map<Chat.ChatId, bigint>();
  const inputLocks = new Map<
    bigint,
    { readonly semaphore: Semaphore.Semaphore; knownThread: boolean }
  >();
  const closeConfirmations = new Map<string, CloseConfirmation>();
  const allowedMentions = { parse: [], repliedUser: false } satisfies {
    parse: [];
    repliedUser: false;
  };
  const formatNumber = new Intl.NumberFormat("en-US").format;

  const inputLock = (channelId: bigint) => {
    const existing = inputLocks.get(channelId);
    if (existing !== undefined) return existing;
    const entry = { semaphore: Semaphore.makeUnsafe(1), knownThread: false };
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
      Effect.mapError(() => discordError("Invalid Discord thread binding", undefined)),
    );
    cacheChat(threadId, chatId);
    return Option.some(threadId);
  });

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
    inputLock(channel.id).knownThread = true;
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
    cacheChat(thread.threadId, chat.value.id);
    return Option.some(chat.value.id);
  });

  const sendMessageToChat = Effect.fn("Discord.sendMessageToChat")(function* (
    chatId: Chat.ChatId,
    prompt: AgentMessage.AgentPrompt,
    channelId: bigint,
  ) {
    yield* application
      .sendMessage(chatId, prompt)
      .pipe(
        Effect.catchTag("ChatClosed", () =>
          promiseBoundary("Failed to report closed Discord chat", () =>
            bot.helpers.sendMessage(channelId, { content: closedMessage, allowedMentions }),
          ).pipe(Effect.asVoid),
        ),
      );
  });

  const processMessage = Effect.fn("Discord.processMessage")(function* (
    message: Message,
    knownChannel?: DiscordChannel,
  ) {
    const sourceAttachments = message.attachments ?? [];
    if (message.content.trim().length === 0 && sourceAttachments.length === 0) {
      yield* promiseBoundary("Failed to reject empty Discord message", () =>
        bot.helpers.sendMessage(message.channelId, {
          content: "Send text or an image to start or continue a chat.",
          allowedMentions,
        }),
      );
      return;
    }

    const prompt = yield* projectDiscordPrompt(message, httpClient).pipe(
      Effect.timeout("30 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(attachmentError(attachmentDownloadMessage)),
      ),
      Effect.catchTag("DiscordAttachmentError", (error) =>
        promiseBoundary("Failed to reject Discord attachments", () =>
          bot.helpers.sendMessage(message.channelId, { content: error.reply, allowedMentions }),
        ).pipe(Effect.as(undefined)),
      ),
    );
    if (prompt === undefined) return;

    const cachedChatId = chatIds.get(message.channelId);
    if (cachedChatId !== undefined) {
      yield* sendMessageToChat(cachedChatId, prompt, message.channelId);
      return;
    }

    const channel =
      knownChannel ??
      (yield* promiseBoundary("Failed to resolve Discord channel", () =>
        bot.helpers.getChannel(message.channelId),
      ));

    if (isThread(channel.type)) {
      if (channel.parentId === undefined) return;

      const chat = yield* application.findChatByPlatformId(
        "discord",
        channel.parentId.toString(),
        channel.id.toString(),
      );
      if (Option.isNone(chat)) return;

      workspaceIds.set(channel.parentId, chat.value.workspaceId);
      cacheChat(channel.id, chat.value.id);
      yield* sendMessageToChat(chat.value.id, prompt, message.channelId);
      return;
    }

    if (channel.type !== ChannelTypes.GuildText) return;

    const maybeWorkspaceId = yield* findWorkspace(channel.id);
    let workspaceId: Workspace.WorkspaceId;
    if (Option.isSome(maybeWorkspaceId)) {
      workspaceId = maybeWorkspaceId.value;
    } else {
      const workspace = yield* application.getOrCreateWorkspaceByBinding({
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
        name:
          threadName(message.content) ||
          threadName(prompt.attachments[0]?.name ?? "") ||
          "Image attachment",
        autoArchiveDuration: 1_440,
      }),
    );
    yield* threadLock(thread.id).withPermit(
      Effect.gen(function* () {
        const chat = yield* application.createChat({
          workspaceId,
          externalId: thread.id.toString(),
        });
        cacheChat(thread.id, chat.id);
        yield* sendMessageToChat(chat.id, prompt, message.channelId);
      }),
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
    if (inputLocks.get(message.channelId)?.knownThread === true || chatIds.has(message.channelId)) {
      yield* threadLock(message.channelId).withPermit(processMessage(message));
      return;
    }
    const entry = inputLock(message.channelId);
    const parentChannel = yield* entry.semaphore.withPermit(
      Effect.gen(function* () {
        const channel = yield* promiseBoundary("Failed to resolve Discord channel", () =>
          bot.helpers.getChannel(message.channelId),
        );
        if (isThread(channel.type)) {
          entry.knownThread = true;
          yield* processMessage(message, channel);
          return undefined;
        }
        return channel;
      }),
    );
    if (parentChannel !== undefined) {
      yield* processMessage(message, parentChannel);
    }
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
    run(
      handleMessage(message).pipe(
        Effect.catchCause((cause) => Effect.logError("Discord input failed", Cause.pretty(cause))),
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
        if (channelId === undefined || (closeNonce === undefined && name === "bind")) {
          run(effect);
          return;
        }
        run(inputLock(channelId).semaphore.withPermit(effect));
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

  return resolveThreadId;
});
