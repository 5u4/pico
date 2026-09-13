import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Chat, ChatId, type NewChat } from "./chat-model.ts";
import type { PersistenceError } from "./errors.ts";
import { AbsolutePath } from "./path.ts";
import { type WorkspaceId, WorkspacePlatform } from "./workspace-model.ts";

export const PhysicalSessionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)).pipe(
  Schema.brand("PhysicalSessionId"),
);
export type PhysicalSessionId = typeof PhysicalSessionId.Type;

export const SessionJournal = Schema.Struct({ id: PhysicalSessionId, file: AbsolutePath });
export type SessionJournal = typeof SessionJournal.Type;

export const BotDescriptor = Schema.Struct({
  botRoot: AbsolutePath,
  platform: Schema.NullOr(WorkspacePlatform),
});
export type BotDescriptor = typeof BotDescriptor.Type;

export const BotTurnState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("fresh") }),
  Schema.Struct({ kind: Schema.Literal("pending") }),
  Schema.Struct({ kind: Schema.Literal("completed"), at: Schema.Natural }),
]);
export type BotTurnState = typeof BotTurnState.Type;

export const BotSession = Schema.Struct({
  ...BotDescriptor.fields,
  chatId: ChatId,
  journal: SessionJournal,
  handoff: Schema.NullOr(AbsolutePath),
  turn: BotTurnState,
});
export type BotSession = typeof BotSession.Type;

export class BotSessions extends Context.Service<
  BotSessions,
  {
    // Application resolves one logical chat per stable adapter-provided bot root.
    readonly findByRoot: (
      root: AbsolutePath,
    ) => Effect.Effect<Option.Option<BotSession>, PersistenceError>;
    // OMP resolves the active journal whenever it opens or reads a logical chat.
    readonly findByChat: (
      chatId: ChatId,
    ) => Effect.Effect<Option.Option<BotSession>, PersistenceError>;
    // Application keeps workspace-targeted schedules inside their owning bot conversation.
    readonly findByWorkspace: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<Option.Option<BotSession>, PersistenceError>;
    // Application publishes the workspace, chat, and initial pointer while it owns the journal.
    readonly createConversation: (
      input: Omit<BotSession, "handoff" | "turn"> &
        Pick<NewChat, "workspaceId" | "cwd" | "createdAt">,
    ) => Effect.Effect<Chat, PersistenceError>;
    // Application records admission before sending and completion only after a successful whole turn.
    readonly setTurn: (
      chatId: ChatId,
      expected: PhysicalSessionId,
      turn: BotTurnState,
    ) => Effect.Effect<void, PersistenceError>;
    // Application saves a semantic handoff before publishing a new physical journal.
    readonly saveHandoff: (
      source: BotSession,
      content: string,
    ) => Effect.Effect<AbsolutePath, PersistenceError>;
    // OMP loads only the handoff referenced by the active physical session.
    readonly readHandoff: (session: BotSession) => Effect.Effect<string, PersistenceError>;
    // Application atomically advances the pointer after the handoff and next journal exist.
    readonly rotate: (
      source: BotSession,
      journal: SessionJournal,
      handoff: AbsolutePath,
    ) => Effect.Effect<void, PersistenceError>;
  }
>()("@pico/contract/bot/BotSessions") {}
