import type { TelegramConfig } from "@pico/config/config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  parseChatId,
  splitTelegramText,
  type TelegramAddress,
  type TelegramCommand,
  type TelegramInput,
} from "./telegram-model.ts";

const commandPattern = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/u;

const SafeInt = Schema.Int.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value), { expected: "a safe integer" }),
);
const NonNegativeSafeInt = SafeInt.check(
  Schema.makeFilter((value) => value >= 0, { expected: "a nonnegative safe integer" }),
);
const PositiveSafeInt = SafeInt.check(
  Schema.makeFilter((value) => value > 0, { expected: "a positive safe integer" }),
);

const MessageEntity = Schema.Struct({
  offset: NonNegativeSafeInt,
  length: PositiveSafeInt,
  type: Schema.String,
});

const Message = Schema.Struct({
  chat: Schema.Struct({
    id: SafeInt,
    type: Schema.String,
    is_forum: Schema.optional(Schema.Boolean),
    title: Schema.optional(Schema.String),
  }),
  from: Schema.optional(
    Schema.Struct({
      id: PositiveSafeInt,
      is_bot: Schema.Boolean,
      username: Schema.optional(Schema.String),
    }),
  ),
  sender_chat: Schema.optional(Schema.Unknown),
  text: Schema.optional(Schema.String),
  entities: Schema.optional(Schema.Array(MessageEntity)),
  is_topic_message: Schema.optional(Schema.Boolean),
  message_thread_id: Schema.optional(PositiveSafeInt),
});

const Update = Schema.Struct({
  update_id: NonNegativeSafeInt,
  message: Schema.optional(Message),
  edited_message: Schema.optional(Schema.Unknown),
  channel_post: Schema.optional(Schema.Unknown),
});

type TelegramUpdate = typeof Update.Type;

const ApiFailure = Schema.Struct({
  ok: Schema.Literal(false),
  error_code: Schema.optional(SafeInt),
  parameters: Schema.optional(
    Schema.Struct({
      retry_after: Schema.optional(PositiveSafeInt),
    }),
  ),
});

type ApiFailure = typeof ApiFailure.Type;

type ApiResult<A> = { readonly ok: true; readonly result: A } | ApiFailure;

const GetMeResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.Struct({
      id: PositiveSafeInt,
      username: Schema.optional(Schema.String),
    }),
  }),
  ApiFailure,
]);

const GetWebhookInfoResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.Struct({
      url: Schema.optional(Schema.String),
    }),
  }),
  ApiFailure,
]);

const GetUpdatesResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.Array(Update),
  }),
  ApiFailure,
]);

const SendMessageResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.Struct({
      message_id: PositiveSafeInt,
    }),
  }),
  ApiFailure,
]);

const decodeGetMeResponse = Schema.decodeUnknownEffect(GetMeResponse);
const decodeGetWebhookInfoResponse = Schema.decodeUnknownEffect(GetWebhookInfoResponse);
const decodeGetUpdatesResponse = Schema.decodeUnknownEffect(GetUpdatesResponse);
const decodeSendMessageResponse = Schema.decodeUnknownEffect(SendMessageResponse);

export class TelegramError extends Schema.TaggedError<TelegramError>()("TelegramError", {
  message: Schema.String,
  operation: Schema.String,
  category: Schema.Literals([
    "network",
    "timeout",
    "cancelled",
    "auth",
    "conflict",
    "rate-limit",
    "http",
    "protocol",
    "webhook",
  ]),
  status: Schema.optional(Schema.Int),
  retryAfterSeconds: Schema.optional(PositiveSafeInt),
}) {}

const mapApiFailure = (operation: string, status: number, failure: ApiFailure) => {
  const code = failure.error_code ?? status;
  const retryAfterSeconds = failure.parameters?.retry_after;
  if (code === 429) {
    return new TelegramError({
      message: `Telegram ${operation} failed`,
      operation,
      category: "rate-limit",
      ...(Number.isSafeInteger(status) ? { status } : {}),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  if (code === 401 || code === 403) {
    return new TelegramError({
      message: `Telegram ${operation} failed`,
      operation,
      category: "auth",
      ...(Number.isSafeInteger(status) ? { status } : {}),
    });
  }
  if (code === 409) {
    return new TelegramError({
      message: `Telegram ${operation} failed`,
      operation,
      category: "conflict",
      ...(Number.isSafeInteger(status) ? { status } : {}),
    });
  }
  return new TelegramError({
    message: `Telegram ${operation} failed`,
    operation,
    category: "http",
    ...(Number.isSafeInteger(status) ? { status } : {}),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
};

const unwrapApiResult = <A>(operation: string, status: number, payload: ApiResult<A>) =>
  payload.ok
    ? Effect.succeed(payload.result)
    : Effect.fail(mapApiFailure(operation, status, payload));

const parseLeadingCommand = (
  text: string,
  entities:
    | ReadonlyArray<{ readonly offset: number; readonly length: number; readonly type: string }>
    | undefined,
  botUsername: string | null,
): TelegramCommand | null => {
  const entity = entities?.[0];
  if (entity === undefined || entity.type !== "bot_command" || entity.offset !== 0) return null;
  if (entity.length <= 0 || entity.length > text.length) return null;
  const token = text.slice(0, entity.length);
  const match = commandPattern.exec(token);
  if (match === null) return null;
  const commandName = (match[1] ?? "").toLowerCase();
  const targetUsername = match[2]?.toLowerCase();
  const target: TelegramCommand["target"] =
    targetUsername === undefined
      ? "self"
      : botUsername !== null && targetUsername === botUsername
        ? "self"
        : "other";
  return {
    name: commandName,
    target,
    argument: text.slice(entity.length).replace(/^\s+/u, ""),
  };
};

const decodeInput = (update: TelegramUpdate, botUsername: string | null): TelegramInput => {
  if (update.edited_message !== undefined) {
    return { kind: "unsupported", reason: "edited-message", chatId: null, userId: null };
  }
  if (update.channel_post !== undefined) {
    return { kind: "unsupported", reason: "channel-post", chatId: null, userId: null };
  }
  if (update.message === undefined) {
    return { kind: "unsupported", reason: "unsupported-update", chatId: null, userId: null };
  }

  const message = update.message;
  const chatId = message.chat.id.toString();
  const userId = message.from?.id.toString() ?? null;

  if (message.chat.type === "private") {
    return { kind: "unsupported", reason: "private-chat", chatId, userId };
  }
  if (message.chat.type === "channel") {
    return { kind: "unsupported", reason: "channel-post", chatId, userId };
  }
  if (message.chat.type !== "supergroup") {
    return { kind: "unsupported", reason: "non-supergroup-chat", chatId, userId };
  }
  if (message.chat.is_forum !== true) {
    return { kind: "unsupported", reason: "non-forum-chat", chatId, userId };
  }
  if (message.sender_chat !== undefined) {
    return { kind: "unsupported", reason: "sender-chat", chatId, userId };
  }
  if (message.from === undefined) {
    return { kind: "unsupported", reason: "missing-author", chatId, userId };
  }
  if (message.from.is_bot) {
    return { kind: "unsupported", reason: "bot-author", chatId, userId };
  }

  const text = message.text ?? "";
  const command = parseLeadingCommand(text, message.entities, botUsername);
  if (command?.target === "other") {
    return {
      kind: "unsupported",
      reason: "other-bot-command",
      chatId,
      userId: message.from.id.toString(),
    };
  }

  const chatTitle = message.chat.title?.trim() ?? null;
  if (
    message.is_topic_message === true &&
    message.message_thread_id !== undefined &&
    message.message_thread_id > 1
  ) {
    return {
      kind: "forum-topic",
      chatId,
      userId: message.from.id.toString(),
      text,
      chatTitle,
      command,
      address: {
        chatId,
        topicId: message.message_thread_id,
      },
    };
  }

  return {
    kind: "forum-general",
    chatId,
    userId: message.from.id.toString(),
    text,
    chatTitle,
    command,
  };
};

const isTransientPollingError = (error: TelegramError): boolean =>
  error.category === "network" ||
  error.category === "timeout" ||
  (error.category === "http" && error.status !== undefined && error.status >= 500);

export interface TelegramClient {
  readonly identity: { readonly id: string; readonly username: string | null };
  readonly consume: <R>(
    handle: (input: TelegramInput) => Effect.Effect<void, never, R>,
  ) => Effect.Effect<never, TelegramError, R>;
  readonly sendText: (address: TelegramAddress, text: string) => Effect.Effect<void, TelegramError>;
  readonly sendGeneral: (chatId: string, text: string) => Effect.Effect<void, TelegramError>;
}

export interface TelegramClientOptions {
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly pollTimeoutSeconds?: number;
  readonly requestTimeoutMs?: number;
  readonly maxBackoffMs?: number;
}

export const make = Effect.fn("TelegramClient.make")(function* (
  config: TelegramConfig,
  options: TelegramClientOptions = {},
) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
  const requestTimeoutMs = options.requestTimeoutMs ?? 35_000;
  const maxBackoffMs = options.maxBackoffMs ?? 8_000;
  const apiRoot = `https://api.telegram.org/bot${Redacted.value(config.token)}`;

  const request = <A>(
    operation: string,
    method: string,
    payload: Readonly<Record<string, unknown>>,
    decode: (input: unknown) => Effect.Effect<ApiResult<A>, unknown>,
  ): Effect.Effect<A, TelegramError> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: async (signal) => {
          const deadline = AbortSignal.timeout(requestTimeoutMs);
          const abortSignal = AbortSignal.any([signal, deadline]);
          try {
            const response = await fetcher(`${apiRoot}/${method}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
              signal: abortSignal,
            });
            return { status: response.status, ok: response.ok, source: await response.text() };
          } catch {
            throw new TelegramError({
              message: `Telegram ${operation} failed`,
              operation,
              category: signal.aborted ? "cancelled" : deadline.aborted ? "timeout" : "network",
            });
          }
        },
        catch: (cause) =>
          cause instanceof TelegramError
            ? cause
            : new TelegramError({
                message: `Telegram ${operation} failed`,
                operation,
                category: "network",
              }),
      });
      const decoded = yield* Effect.try(() => JSON.parse(response.source)).pipe(
        Effect.flatMap(decode),
        Effect.mapError(() =>
          response.ok
            ? new TelegramError({
                message: `Telegram ${operation} failed`,
                operation,
                category: "protocol",
                status: response.status,
              })
            : mapApiFailure(operation, response.status, { ok: false }),
        ),
      );
      if (!response.ok && decoded.ok) {
        return yield* mapApiFailure(operation, response.status, { ok: false });
      }
      return yield* unwrapApiResult(operation, response.status, decoded);
    }).pipe(
      Effect.catch((error) =>
        error.category === "cancelled" ? Effect.interrupt : Effect.fail(error),
      ),
    );

  const getMe = () => request("get-me", "getMe", {}, decodeGetMeResponse);
  const getWebhookInfo = () =>
    request("get-webhook-info", "getWebhookInfo", {}, decodeGetWebhookInfoResponse);
  const getUpdates = (offset: number | undefined) =>
    request(
      "get-updates",
      "getUpdates",
      {
        timeout: pollTimeoutSeconds,
        limit: 100,
        allowed_updates: ["message"],
        ...(offset === undefined ? {} : { offset }),
      },
      decodeGetUpdatesResponse,
    );

  const send = (chatId: string, text: string, topicId?: number) =>
    Effect.gen(function* () {
      const telegramChatId = yield* parseChatId(chatId).pipe(
        Effect.mapError(
          () =>
            new TelegramError({
              message: "Telegram send-message failed",
              operation: "send-message",
              category: "protocol",
            }),
        ),
      );
      for (const chunk of splitTelegramText(text)) {
        yield* request(
          "send-message",
          "sendMessage",
          {
            chat_id: telegramChatId,
            ...(topicId === undefined ? {} : { message_thread_id: topicId }),
            text: chunk,
            disable_web_page_preview: true,
          },
          decodeSendMessageResponse,
        );
      }
    });

  const identity = yield* getMe();
  const webhook = yield* getWebhookInfo();
  if ((webhook.url?.trim().length ?? 0) > 0) {
    return yield* new TelegramError({
      message: "A Telegram webhook is already configured. Remove it before starting long polling.",
      operation: "get-webhook-info",
      category: "webhook",
    });
  }

  const consume = Effect.fn("TelegramClient.consume")(function* <R>(
    handle: (input: TelegramInput) => Effect.Effect<void, never, R>,
  ): Effect.fn.Return<never, TelegramError, R> {
    let offset: number | undefined;
    let backoffMs = 500;
    while (true) {
      const updates: ReadonlyArray<TelegramUpdate> | null = yield* getUpdates(offset).pipe(
        Effect.catch((error) => {
          if (error.category === "rate-limit") {
            const seconds = Math.max(error.retryAfterSeconds ?? 1, 1);
            return Effect.sleep(`${seconds} seconds`).pipe(Effect.as(null));
          }
          if (isTransientPollingError(error)) {
            const delay = backoffMs;
            backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
            return Effect.sleep(`${delay} millis`).pipe(Effect.as(null));
          }
          return Effect.fail(error);
        }),
      );
      if (updates === null) continue;
      backoffMs = 500;
      for (const update of updates) {
        const input = decodeInput(update, identity.username?.toLowerCase() ?? null);
        yield* handle(input);
        offset = update.update_id + 1;
      }
    }
  });

  return {
    identity: {
      id: identity.id.toString(),
      username: identity.username?.toLowerCase() ?? null,
    },
    consume,
    sendText: (address, text) => send(address.chatId, text, address.topicId),
    sendGeneral: (chatId, text) => send(chatId, text),
  } satisfies TelegramClient;
});
