import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { Duration, Effect, RcMap, type Scope } from "effect";
import { Auth } from "./auth.ts";
import { Catalog } from "./catalog.ts";
import { type Chat, makeChat } from "./chat.ts";
import { ChatsConfig } from "./config.ts";
import {
  ChatBusy,
  InvalidChatId,
  ModelUnavailable,
  SessionInitFailed,
} from "./errors.ts";

const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const isValidChatId = (chatId: string): boolean =>
  CHAT_ID_PATTERN.test(chatId);
const CHAT_IDLE_TTL = Duration.minutes(5);

export interface GetOrCreateOptions {
  readonly cwd: string;
}

export class Chats extends Effect.Service<Chats>()("pico/Chats", {
  dependencies: [Auth.Default, Catalog.Default, ChatsConfig.Default],
  scoped: Effect.gen(function* () {
    const auth = yield* Auth;
    const catalog = yield* Catalog;
    const config = yield* ChatsConfig;
    const cwdByChat = new Map<string, string>();

    const lookup = (
      chatId: string,
    ): Effect.Effect<Chat, SessionInitFailed | ModelUnavailable, Scope.Scope> =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => cwdByChat.delete(chatId)),
        );
        const cwd = cwdByChat.get(chatId) ?? process.cwd();
        const settings = yield* Effect.tryPromise({
          try: () => Settings.init({ cwd, agentDir: auth.agentDir }),
          catch: (cause) => new SessionInitFailed({ chatId, cause }),
        });
        const model = yield* catalog.resolveDefaultModel(settings);
        const sessionDir = join(config.sessionsRoot, chatId);
        yield* Effect.try({
          try: () => mkdirSync(sessionDir, { recursive: true }),
          catch: (cause) => new SessionInitFailed({ chatId, cause }),
        });
        return yield* makeChat({
          chatId,
          cwd,
          sessionDir,
          model,
          agentDir: auth.agentDir,
          settings,
          authStorage: auth.storage,
          modelRegistry: catalog.registry,
        });
      });

    const chats = yield* RcMap.make({
      lookup,
      idleTimeToLive: CHAT_IDLE_TTL,
    });

    const getOrCreate = (
      chatId: string,
      options: GetOrCreateOptions,
    ): Effect.Effect<
      Chat,
      InvalidChatId | SessionInitFailed | ModelUnavailable,
      Scope.Scope
    > =>
      isValidChatId(chatId)
        ? Effect.sync(() => {
            if (!cwdByChat.has(chatId)) cwdByChat.set(chatId, options.cwd);
          }).pipe(Effect.andThen(RcMap.get(chats, chatId)))
        : Effect.fail(new InvalidChatId({ chatId }));

    return { getOrCreate };
  }),
}) {}

export { ChatBusy, InvalidChatId, ModelUnavailable, SessionInitFailed };
