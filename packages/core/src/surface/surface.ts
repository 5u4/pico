import { Effect, Option, type Scope } from "effect";
import type { ChatSession } from "../agents/chat.ts";
import { Chats } from "../agents/chats.ts";
import type {
  InvalidChatId,
  ModelUnavailable,
  SessionInitFailed,
} from "../agents/errors.ts";
import { PicoConfig } from "../config/pico-config.ts";
import type { DbError } from "../store/errors.ts";
import { ChatNotFound, SpaceNotFound } from "../store/errors.ts";
import type { Chat, Platform, Space } from "../store/schema.ts";
import { Store } from "../store/store.ts";
import {
  type CwdNotFound,
  InvalidChatTitle,
  type InvalidCwd,
  InvalidSpaceName,
  type NotADirectory,
  SpaceHasActiveChats,
} from "./errors.ts";
import { validatePath } from "./validate.ts";

type PathError = InvalidCwd | CwdNotFound | NotADirectory;
type OpenError = InvalidChatId | SessionInitFailed | ModelUnavailable;

export interface ChatHandle {
  readonly chat: Chat;
  readonly session: ChatSession;
}

export interface Surface {
  readonly platform: Platform;
  readonly createSpace: (input: {
    readonly name: string;
    readonly cwd?: string;
  }) => Effect.Effect<Space, InvalidSpaceName | PathError | DbError>;
  readonly getSpace: (
    id: string,
  ) => Effect.Effect<Space, SpaceNotFound | DbError>;
  readonly listSpaces: () => Effect.Effect<ReadonlyArray<Space>, DbError>;
  readonly updateSpaceCwd: (
    id: string,
    cwd: string,
  ) => Effect.Effect<Space, SpaceNotFound | PathError | DbError>;
  readonly deleteSpace: (
    id: string,
  ) => Effect.Effect<void, SpaceNotFound | SpaceHasActiveChats | DbError>;
  readonly createChat: (
    spaceId: string,
    title: string,
  ) => Effect.Effect<
    ChatHandle,
    | InvalidChatTitle
    | SpaceNotFound
    | PathError
    | ChatNotFound
    | OpenError
    | DbError,
    Scope.Scope
  >;
  readonly openChat: (
    chatId: string,
  ) => Effect.Effect<
    ChatHandle,
    ChatNotFound | PathError | OpenError | DbError,
    Scope.Scope
  >;
  readonly listChats: (
    spaceId: string,
  ) => Effect.Effect<ReadonlyArray<Chat>, SpaceNotFound | DbError>;
  readonly archiveChat: (
    chatId: string,
  ) => Effect.Effect<void, ChatNotFound | DbError>;
}

export const makeSurface = (
  platform: Platform,
): Effect.Effect<Surface, never, Store | Chats | PicoConfig> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const chats = yield* Chats;
    const config = yield* PicoConfig;
    const writePlatform = platform;
    const readScope: ReadonlyArray<Platform> = [platform];

    const resolveCwd = (space: Space): string => space.defaultCwd;

    const readableSpace = (
      id: string,
    ): Effect.Effect<Space, SpaceNotFound | DbError> =>
      store.spaces.get(id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: (): Effect.Effect<Space, SpaceNotFound> =>
              new SpaceNotFound({ spaceId: id }),
            onSome: (space) =>
              readScope.includes(space.platform)
                ? Effect.succeed(space)
                : new SpaceNotFound({ spaceId: id }),
          }),
        ),
      );

    const writableSpace = (
      id: string,
    ): Effect.Effect<Space, SpaceNotFound | DbError> =>
      store.spaces.get(id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: (): Effect.Effect<Space, SpaceNotFound> =>
              new SpaceNotFound({ spaceId: id }),
            onSome: (space) =>
              space.platform === writePlatform
                ? Effect.succeed(space)
                : new SpaceNotFound({ spaceId: id }),
          }),
        ),
      );

    return {
      platform: writePlatform,

      createSpace: (input) =>
        Effect.gen(function* () {
          const name = input.name.trim();
          if (name.length === 0) return yield* new InvalidSpaceName({});
          const cwd = yield* validatePath(input.cwd ?? config.defaultCwd);
          return yield* store.spaces
            .create({ defaultCwd: cwd, platform: writePlatform, name })
            .pipe(Effect.catchTag("DuplicateExternalId", Effect.die));
        }),

      getSpace: (id) => readableSpace(id),

      listSpaces: () => store.spaces.list(readScope),

      updateSpaceCwd: (id, cwd) =>
        Effect.gen(function* () {
          yield* writableSpace(id);
          const normalized = yield* validatePath(cwd);
          return yield* store.spaces.updateCwd(id, normalized);
        }),

      deleteSpace: (id) =>
        Effect.gen(function* () {
          yield* writableSpace(id);
          const active = yield* store.chats.list(id);
          if (active.length > 0) {
            return yield* new SpaceHasActiveChats({ spaceId: id });
          }
          yield* store.spaces.delete(id);
        }),

      createChat: (spaceId, title) =>
        Effect.gen(function* () {
          const trimmed = title.trim();
          if (trimmed.length === 0) return yield* new InvalidChatTitle({});
          const space = yield* writableSpace(spaceId);
          const cwd = yield* validatePath(resolveCwd(space));
          const chat = yield* store.chats
            .create({ spaceId, cwd, title: trimmed })
            .pipe(Effect.catchTag("DuplicateExternalId", Effect.die));
          const session = yield* chats
            .getOrCreate(chat.id)
            .pipe(
              Effect.onError(() => Effect.ignore(store.chats.delete(chat.id))),
            );
          return { chat, session };
        }),

      openChat: (chatId) =>
        Effect.gen(function* () {
          const found = yield* store.chats.get(chatId);
          if (Option.isNone(found)) return yield* new ChatNotFound({ chatId });
          const chat = found.value;
          const space = yield* store.spaces.get(chat.spaceId);
          if (
            Option.isNone(space) ||
            !readScope.includes(space.value.platform)
          ) {
            return yield* new ChatNotFound({ chatId });
          }
          yield* validatePath(chat.cwd);
          const session = yield* chats.getOrCreate(chatId);
          return { chat, session };
        }),

      listChats: (spaceId) =>
        readableSpace(spaceId).pipe(
          Effect.flatMap(() => store.chats.list(spaceId)),
        ),

      archiveChat: (chatId) =>
        Effect.gen(function* () {
          const found = yield* store.chats.get(chatId);
          if (Option.isNone(found)) return yield* new ChatNotFound({ chatId });
          const space = yield* store.spaces.get(found.value.spaceId);
          if (Option.isNone(space) || space.value.platform !== writePlatform) {
            return yield* new ChatNotFound({ chatId });
          }
          yield* store.chats.archive(chatId);
          yield* chats.invalidate(chatId);
        }),
    };
  });
