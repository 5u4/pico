import { Buffer } from "node:buffer";
import * as Bot from "@pico/contract/bot-session";
import { ChatId } from "@pico/contract/chat-model";
import { PersistenceError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import { WorkspaceId } from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { failure } from "./error.ts";

const MAX_HANDOFF_BYTES = 16 * 1024;

const HandoffContent = Schema.String.check(
  Schema.isPattern(/\S/u),
  Schema.makeFilter((content) =>
    Buffer.byteLength(content, "utf8") <= MAX_HANDOFF_BYTES
      ? undefined
      : `a handoff of at most ${MAX_HANDOFF_BYTES} bytes`,
  ),
);
const decodeHandoffContent = Schema.decodeUnknownEffect(HandoffContent);

const NewBotSession = Schema.Struct({
  ...Bot.BotDescriptor.fields,
  chatId: ChatId,
  journal: Bot.SessionJournal,
});

const CompletedBotSession = Schema.Struct({
  ...Bot.BotSession.fields,
  turn: Schema.Struct({ kind: Schema.Literal("completed"), at: Schema.Natural }),
});
const decodeCompletedSource = Schema.decodeUnknownEffect(CompletedBotSession);

const SetTurn = Schema.Struct({
  chatId: ChatId,
  expected: Bot.PhysicalSessionId,
  turn: Bot.BotTurnState,
});

const Rotate = Schema.Struct({
  source: CompletedBotSession,
  journal: Bot.SessionJournal,
  handoff: AbsolutePath,
});

const botSessionRowFields = {
  ...Bot.BotDescriptor.fields,
  chatId: ChatId,
  sessionId: Bot.PhysicalSessionId,
  sessionFile: AbsolutePath,
  handoff: Schema.NullOr(AbsolutePath),
};
const BotSessionRow = Schema.Union([
  Schema.Struct({
    ...botSessionRowFields,
    turnState: Schema.Literals(["fresh", "pending"]),
    completedAt: Schema.Null,
  }),
  Schema.Struct({
    ...botSessionRowFields,
    turnState: Schema.Literal("completed"),
    completedAt: Schema.Natural,
  }),
]);

const make = Effect.fn("BotSessions.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const columns = sql`
    bot_root AS "botRoot",
    chat_id AS "chatId",
    platform,
    session_id AS "sessionId",
    session_file AS "sessionFile",
    handoff,
    turn_state AS "turnState",
    completed_at AS "completedAt"
  `;

  const selectByRoot = SqlSchema.findOneOption({
    Request: AbsolutePath,
    Result: BotSessionRow,
    execute: (root) => sql`SELECT ${columns} FROM bot_sessions WHERE bot_root = ${root}`,
  });

  const selectByChat = SqlSchema.findOneOption({
    Request: ChatId,
    Result: BotSessionRow,
    execute: (chatId) => sql`SELECT ${columns} FROM bot_sessions WHERE chat_id = ${chatId}`,
  });

  const selectByWorkspace = SqlSchema.findOneOption({
    Request: WorkspaceId,
    Result: BotSessionRow,
    execute: (workspaceId) => sql`
      SELECT ${columns} FROM bot_sessions
      WHERE chat_id IN (SELECT id FROM chats WHERE workspace_id = ${workspaceId})
    `,
  });

  const insert = SqlSchema.findOne({
    Request: NewBotSession,
    Result: BotSessionRow,
    execute: (input) => sql`
      INSERT INTO bot_sessions (bot_root, chat_id, platform, session_id, session_file)
      VALUES (
        ${input.botRoot}, ${input.chatId}, ${input.platform},
        ${input.journal.id}, ${input.journal.file}
      )
      RETURNING ${columns}
    `,
  });

  const updateTurn = SqlSchema.findOneOption({
    Request: SetTurn,
    Result: Schema.Struct({ chatId: ChatId }),
    execute: ({ chatId, expected, turn }) => sql`
      UPDATE bot_sessions
      SET turn_state = ${turn.kind}, completed_at = ${turn.kind === "completed" ? turn.at : null}
      WHERE chat_id = ${chatId} AND session_id = ${expected}
      RETURNING chat_id AS "chatId"
    `,
  });

  const selectCompletedSource = SqlSchema.findOneOption({
    Request: CompletedBotSession,
    Result: Schema.Struct({ chatId: ChatId }),
    execute: (source) => sql`
      SELECT chat_id AS "chatId" FROM bot_sessions
      WHERE chat_id = ${source.chatId} AND bot_root = ${source.botRoot}
        AND session_id = ${source.journal.id} AND session_file = ${source.journal.file}
        AND turn_state = 'completed' AND completed_at = ${source.turn.at}
    `,
  });

  const updatePointer = SqlSchema.findOneOption({
    Request: Rotate,
    Result: Schema.Struct({ chatId: ChatId }),
    execute: ({ source, journal, handoff }) => sql`
      UPDATE bot_sessions
      SET session_id = ${journal.id}, session_file = ${journal.file}, handoff = ${handoff},
        turn_state = 'fresh', completed_at = NULL
      WHERE chat_id = ${source.chatId} AND bot_root = ${source.botRoot}
        AND session_id = ${source.journal.id} AND session_file = ${source.journal.file}
        AND turn_state = 'completed' AND completed_at = ${source.turn.at}
      RETURNING chat_id AS "chatId"
    `,
  });

  const findByRoot = Effect.fn("BotSessions.findByRoot")(
    function* (root: AbsolutePath) {
      return Option.map(yield* selectByRoot(root), decodeSession);
    },
    Effect.mapError(failure("botSession.findByRoot")),
  );

  const findByChat = Effect.fn("BotSessions.findByChat")(
    function* (chatId: ChatId) {
      return Option.map(yield* selectByChat(chatId), decodeSession);
    },
    Effect.mapError(failure("botSession.findByChat")),
  );

  const findByWorkspace = Effect.fn("BotSessions.findByWorkspace")(
    function* (workspaceId: WorkspaceId) {
      return Option.map(yield* selectByWorkspace(workspaceId), decodeSession);
    },
    Effect.mapError(failure("botSession.findByWorkspace")),
  );

  const create = Effect.fn("BotSessions.create")(
    function* (input: typeof NewBotSession.Type) {
      return decodeSession(yield* insert(input));
    },
    Effect.mapError(failure("botSession.create")),
  );

  const setTurn = Effect.fn("BotSessions.setTurn")(
    function* (chatId: ChatId, expected: Bot.PhysicalSessionId, turn: Bot.BotTurnState) {
      const updated = yield* updateTurn({ chatId, expected, turn });
      if (Option.isNone(updated)) {
        return yield* new PersistenceError({ message: "source session is no longer active" });
      }
    },
    Effect.mapError(failure("botSession.setTurn")),
  );

  const saveHandoff = Effect.fn("BotSessions.saveHandoff")(
    function* (source: Bot.BotSession, content: string) {
      const completed = yield* decodeCompletedSource(source);
      const handoffContent = yield* decodeHandoffContent(content);
      const current = yield* selectCompletedSource(completed);
      if (Option.isNone(current)) {
        return yield* new PersistenceError({ message: "source session is stale or not completed" });
      }
      const handoff = handoffPath(path, completed);
      yield* fileSystem.makeDirectory(path.dirname(handoff), { recursive: true, mode: 0o700 });
      const temporary = yield* fileSystem.makeTempFileScoped({
        directory: path.dirname(handoff),
        prefix: ".handoff-",
      });
      yield* fileSystem.chmod(temporary, 0o600);
      yield* fileSystem.writeFileString(temporary, handoffContent, { mode: 0o600 });
      yield* fileSystem.rename(temporary, handoff);
      return handoff;
    },
    Effect.scoped,
    sql.withTransaction,
    Effect.mapError(failure("botSession.saveHandoff")),
  );

  const readHandoff = Effect.fn("BotSessions.readHandoff")(
    function* (session: Bot.BotSession) {
      if (session.handoff === null) return "";
      return yield* decodeHandoffContent(yield* fileSystem.readFileString(session.handoff));
    },
    Effect.mapError(failure("botSession.readHandoff")),
  );

  const rotate = Effect.fn("BotSessions.rotate")(
    function* (source: Bot.BotSession, journal: Bot.SessionJournal, handoff: AbsolutePath) {
      const completed = yield* decodeCompletedSource(source);
      if (journal.id === source.journal.id || journal.file === source.journal.file) {
        return yield* new PersistenceError({ message: "rotation requires a new physical journal" });
      }
      if (handoff !== handoffPath(path, completed)) {
        return yield* new PersistenceError({
          message: "handoff does not belong to the source session",
        });
      }
      const nextJournal = yield* fileSystem.stat(journal.file);
      if (nextJournal.type !== "File") {
        return yield* new PersistenceError({ message: "next journal is not a file" });
      }
      yield* decodeHandoffContent(yield* fileSystem.readFileString(handoff));
      const updated = yield* updatePointer({ source: completed, journal, handoff });
      if (Option.isNone(updated)) {
        return yield* new PersistenceError({ message: "source session is stale or not completed" });
      }
    },
    Effect.mapError(failure("botSession.rotate")),
  );

  return Bot.BotSessions.of({
    findByRoot,
    findByChat,
    findByWorkspace,
    create,
    setTurn,
    saveHandoff,
    readHandoff,
    rotate,
  });
});

export const layer = Layer.effect(Bot.BotSessions, make());

const decodeSession = (row: typeof BotSessionRow.Type): Bot.BotSession => ({
  botRoot: row.botRoot,
  platform: row.platform,
  chatId: row.chatId,
  journal: { id: row.sessionId, file: row.sessionFile },
  handoff: row.handoff,
  turn:
    row.turnState === "completed"
      ? { kind: "completed", at: row.completedAt }
      : { kind: row.turnState },
});

const handoffPath = (path: Path.Path, source: Bot.BotSession) =>
  AbsolutePath.make(path.join(source.botRoot, "handoffs", `${source.journal.id}.md`));
