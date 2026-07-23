import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { Duration, Effect, Option, RcMap, type Scope } from "effect";
import { PicoConfig } from "../config/pico-config.ts";
import { ChatNotFound, type DbError } from "../store/errors.ts";
import { Store } from "../store/store.ts";
import { Auth } from "./auth.ts";
import { Catalog } from "./catalog.ts";
import { type ChatSession, makeChat } from "./chat.ts";
import {
  InvalidChatId,
  ModelUnavailable,
  SessionInitFailed,
} from "./errors.ts";

const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const isValidChatId = (chatId: string): boolean =>
  CHAT_ID_PATTERN.test(chatId);
const CHAT_IDLE_TTL = Duration.minutes(5);

export class Chats extends Effect.Service<Chats>()("pico/Chats", {
  dependencies: [
    Auth.Default,
    Catalog.Default,
    PicoConfig.Default,
    Store.Default,
  ],
  scoped: Effect.gen(function* () {
    const auth = yield* Auth;
    const catalog = yield* Catalog;
    const config = yield* PicoConfig;
    const store = yield* Store;

    const lookup = (
      chatId: string,
    ): Effect.Effect<
      ChatSession,
      SessionInitFailed | ModelUnavailable | ChatNotFound | DbError,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const found = yield* store.chats.get(chatId);
        if (Option.isNone(found)) return yield* new ChatNotFound({ chatId });
        const row = found.value;
        const settings = yield* Effect.tryPromise({
          try: () => Settings.init({ cwd: row.cwd, agentDir: auth.agentDir }),
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
          cwd: row.cwd,
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
    ): Effect.Effect<
      ChatSession,
      | InvalidChatId
      | SessionInitFailed
      | ModelUnavailable
      | ChatNotFound
      | DbError,
      Scope.Scope
    > =>
      isValidChatId(chatId)
        ? RcMap.get(chats, chatId)
        : Effect.fail(new InvalidChatId({ chatId }));

    const invalidate = (chatId: string): Effect.Effect<void> =>
      RcMap.invalidate(chats, chatId);

    return { getOrCreate, invalidate };
  }),
}) {}

export { InvalidChatId, ModelUnavailable, SessionInitFailed };
