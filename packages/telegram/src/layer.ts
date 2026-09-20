import type { TelegramConfig } from "@pico/config/config";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import type * as AgentMessage from "@pico/contract/agent-message";
import { Application } from "@pico/contract/application";
import type * as Chat from "@pico/contract/chat-model";
import { ApplicationError, ChatClosed, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { EventRouter } from "@pico/contract/event-router";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  make as makeClient,
  type TelegramClient,
  type TelegramClientOptions,
  TelegramError,
} from "./client.ts";
import {
  decodeChatExternalId,
  encodeChatExternalId,
  type TelegramAddress,
  TelegramBindingError,
  type TelegramInput,
} from "./telegram-model.ts";

const bindUsage = "Usage. /bind /absolute/path";
const bindRequired = "Run /bind /absolute/path in this group before prompting from a topic.";
const bindSuccess =
  "Workspace binding saved. Existing topic chats keep their current path. New chats follow this binding.";
const bindFailure = "Binding failed. Use a readable absolute directory path.";
const unknownCommand = "Unsupported command. Available commands are /bind and /abort.";
const useTopic = "Use a named topic for prompts. General messages do not create chats.";
const noActiveChat = "No active topic chat is available.";
const abortComplete = "Stopped active work for this topic.";
const failedNotice = "The request failed.";
const abortedNotice = "The request was stopped.";

export interface TelegramLayerOptions {
  readonly client?: TelegramClient;
  readonly clientOptions?: TelegramClientOptions;
}

const isExpectedApplicationError = (error: unknown) =>
  error instanceof WorkspaceBindingInvalid ||
  error instanceof ChatClosed ||
  (error instanceof ApplicationError && error.reason !== "operation");

const logTelegramError = (
  operation: string,
  error: TelegramError,
  level: "error" | "warning" = "error",
) =>
  (level === "warning"
    ? Effect.logWarning("Telegram operation degraded")
    : Effect.logError("Telegram operation failed")
  ).pipe(
    Effect.annotateLogs({
      component: "telegram",
      operation,
      telegramOperation: error.operation,
      category: error.category,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    }),
  );

const reportUnexpectedCause = (operation: string, cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void;
  const failure = cause.reasons.find(
    (reason): reason is Extract<Cause.Reason<unknown>, { readonly _tag: "Fail" }> =>
      reason._tag === "Fail",
  );
  const error = failure?._tag === "Fail" ? failure.error : undefined;
  if (error instanceof TelegramError) return logTelegramError(operation, error);
  if (isExpectedApplicationError(error)) return Effect.void;
  return Effect.logError("Telegram operation failed").pipe(
    Effect.annotateLogs({
      component: "telegram",
      operation,
      category: "unexpected",
    }),
  );
};

const renderSettledText = (
  envelope: AgentEventEnvelope,
): { readonly kind: "text" | "notice"; readonly value: string } | null => {
  if (envelope.event.type !== "message-settled") return null;
  if (envelope.event.message.role !== "assistant") return null;
  const message = envelope.event.message;
  if (message.status === "failed") {
    return {
      kind: "notice",
      value: message.stopReason === "aborted" ? abortedNotice : failedNotice,
    };
  }
  const text = message.content
    .filter((part): part is AgentMessage.AgentText => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (text.length === 0) return null;
  return { kind: "text", value: text };
};

const start = Effect.fn("Telegram.start")(function* (
  config: TelegramConfig,
  options: TelegramLayerOptions = {},
) {
  const application = yield* Application;
  const eventRouter = yield* EventRouter;
  const client = options.client ?? (yield* makeClient(config, options.clientOptions));
  const runtimeScope = yield* Scope.fork(yield* Effect.scope);
  const route = yield* eventRouter
    .open(
      (envelope) =>
        envelope.localOnly !== true &&
        envelope.event.type === "message-settled" &&
        envelope.event.message.role === "assistant",
    )
    .pipe(Scope.provide(runtimeScope));

  const allowedChats = new Set(config.allowedChatIds);
  const allowedUsers = new Set(config.allowedUserIds);
  const operatorsEnabled = allowedChats.size > 0 && allowedUsers.size > 0;

  const reply = (
    input: Extract<TelegramInput, { readonly kind: "forum-topic" | "forum-general" }>,
    message: string,
  ) =>
    input.kind === "forum-topic"
      ? client.sendText(input.address, message)
      : client.sendGeneral(input.chatId, message);

  const findTopicChat = Effect.fn("Telegram.findTopicChat")(function* (
    input: Extract<TelegramInput, { readonly kind: "forum-topic" }>,
  ) {
    const workspace = yield* application.findWorkspaceByPlatformId("telegram", input.chatId);
    if (Option.isNone(workspace)) return Option.none<{ chatId: Chat.ChatId; archived: boolean }>();
    const externalId = encodeChatExternalId(input.address);
    const chat = yield* application.findChatByPlatformId("telegram", input.chatId, externalId);
    if (Option.isNone(chat)) return Option.none<{ chatId: Chat.ChatId; archived: boolean }>();
    return Option.some({ chatId: chat.value.id, archived: chat.value.archivedAt !== null });
  });

  const handleBind = Effect.fn("Telegram.handleBind")(function* (
    input: Extract<TelegramInput, { readonly kind: "forum-topic" | "forum-general" }>,
    cwd: string,
  ) {
    if (cwd.length === 0) {
      yield* reply(input, bindUsage);
      return;
    }
    const bound = yield* application
      .bindWorkspace({
        binding: { platform: "telegram", externalId: input.chatId },
        workspaceName: input.chatTitle ?? `Telegram chat ${input.chatId}`,
        configuration: { kind: "direct", cwd },
      })
      .pipe(
        Effect.match({
          onSuccess: () => ({ ok: true as const }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
      );
    if (!bound.ok) {
      if (
        bound.error instanceof WorkspaceBindingInvalid ||
        isExpectedApplicationError(bound.error)
      ) {
        yield* reply(input, bindFailure);
        return;
      }
      return yield* Effect.fail(bound.error);
    }
    yield* reply(input, bindSuccess);
  });

  const observeCompletion = Effect.fn("Telegram.observeCompletion")(function* (
    completed: Effect.Effect<void, ApplicationError>,
  ) {
    yield* completed.pipe(
      Effect.catchCause((cause) => reportUnexpectedCause("completion", cause)),
      Effect.forkScoped({ startImmediately: true }),
    );
  });

  const handlePrompt = Effect.fn("Telegram.handlePrompt")(function* (
    input: Extract<TelegramInput, { readonly kind: "forum-topic" | "forum-general" }>,
  ) {
    if (input.command !== null) return;
    if (input.text.trim().length === 0) return;
    if (input.kind === "forum-general") {
      yield* reply(input, useTopic);
      return;
    }

    const workspace = yield* application.findWorkspaceByPlatformId("telegram", input.chatId);
    if (Option.isNone(workspace)) {
      yield* reply(input, bindRequired);
      return;
    }

    const externalId = encodeChatExternalId(input.address);
    const chat = yield* application.findChatByPlatformId("telegram", input.chatId, externalId);
    const current = Option.isSome(chat)
      ? chat.value
      : yield* application.createChat({
          workspaceId: workspace.value.id,
          externalId,
        });
    if (current.archivedAt !== null) {
      yield* reply(input, noActiveChat);
      return;
    }
    const delivery = yield* application.sendMessage(current.id, {
      text: input.text,
      attachments: [],
    });
    if (delivery.kind === "started") {
      yield* observeCompletion(delivery.completed);
      return;
    }
    if (delivery.kind === "steered") {
      yield* observeCompletion(delivery.completed);
    }
  });

  const handleAbort = Effect.fn("Telegram.handleAbort")(function* (
    input: Extract<TelegramInput, { readonly kind: "forum-topic" | "forum-general" }>,
  ) {
    if (input.kind !== "forum-topic") {
      yield* reply(input, noActiveChat);
      return;
    }
    const topic = yield* findTopicChat(input);
    if (Option.isNone(topic) || topic.value.archived) {
      yield* reply(input, noActiveChat);
      return;
    }
    const aborted = yield* application.abort(topic.value.chatId).pipe(
      Effect.match({
        onSuccess: () => ({ ok: true as const }),
        onFailure: (error) => ({ ok: false as const, error }),
      }),
    );
    if (!aborted.ok) {
      if (isExpectedApplicationError(aborted.error)) {
        yield* reply(input, noActiveChat);
        return;
      }
      return yield* Effect.fail(aborted.error);
    }
    yield* reply(input, abortComplete);
  });

  const consumeInput = (input: TelegramInput) =>
    Effect.gen(function* () {
      if (input.kind === "unsupported") return;
      if (!operatorsEnabled || !allowedChats.has(input.chatId)) return;
      if (!allowedUsers.has(input.userId)) return;
      if (input.command?.target === "other") return;
      if (input.command !== null) {
        switch (input.command.name) {
          case "bind": {
            yield* handleBind(input, input.command.argument);
            return;
          }
          case "abort": {
            yield* handleAbort(input);
            return;
          }
          default: {
            yield* reply(input, unknownCommand);
            return;
          }
        }
      }
      yield* handlePrompt(input);
    }).pipe(Effect.catchCause((cause) => reportUnexpectedCause("consume-input", cause)));

  const deliverOutput = (envelope: AgentEventEnvelope) =>
    Effect.gen(function* () {
      const rendered = renderSettledText(envelope);
      if (rendered === null) return;

      const binding = yield* application.findChatPlatformBinding(envelope.chatId);
      if (Option.isNone(binding) || binding.value.platform !== "telegram") return;

      const address = yield* decodeChatExternalId(binding.value.externalId).pipe(
        Effect.map((decoded): TelegramAddress | null => decoded),
        Effect.catch((error) => {
          if (error instanceof TelegramBindingError) {
            return Effect.logWarning("Telegram output binding is invalid").pipe(
              Effect.annotateLogs({ component: "telegram", operation: "decode-binding" }),
              Effect.as<TelegramAddress | null>(null),
            );
          }
          return Effect.fail(error);
        }),
      );
      if (address === null) return;
      if (!operatorsEnabled || !allowedChats.has(address.chatId)) return;
      yield* client.sendText(address, rendered.value);
    }).pipe(Effect.catchCause((cause) => reportUnexpectedCause("deliver-output", cause)));
  const inputLoop = client.consume(consumeInput);

  const outputLoop = route.events.pipe(
    Stream.runForEach(deliverOutput),
    Effect.andThen(
      Effect.fail(
        new TelegramError({
          message: "Telegram output route stopped",
          operation: "output-loop",
          category: "protocol",
        }),
      ),
    ),
  );

  const runtime = Effect.all([inputLoop, outputLoop], {
    concurrency: "unbounded",
    discard: true,
  }).pipe(
    Scope.provide(runtimeScope),
    Effect.onExit((exit) => Scope.close(runtimeScope, exit)),
    Effect.catchCause((cause) => reportUnexpectedCause("runtime", cause)),
  );

  yield* runtime.pipe(Effect.forkScoped({ startImmediately: true }));
  yield* Effect.logInfo("Telegram adapter ready").pipe(
    Effect.annotateLogs({
      component: "telegram",
      operation: "start",
      username: client.identity.username ?? "unknown",
      allowedChatCount: config.allowedChatIds.length,
      allowedUserCount: config.allowedUserIds.length,
    }),
  );
});

export { TelegramError };

// Daemon composition enables this layer when Telegram credentials are configured.
export const layer = (config: TelegramConfig, options: TelegramLayerOptions = {}) =>
  Layer.effectDiscard(start(config, options));
