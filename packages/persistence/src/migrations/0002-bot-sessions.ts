import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE bot_sessions (
      bot_root TEXT PRIMARY KEY NOT NULL CHECK (length(bot_root) > 0),
      chat_id TEXT NOT NULL UNIQUE,
      platform TEXT,
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      session_file TEXT NOT NULL CHECK (length(session_file) > 0),
      handoff TEXT CHECK (handoff IS NULL OR length(handoff) > 0),
      turn_state TEXT NOT NULL DEFAULT 'fresh',
      completed_at INTEGER,

      CONSTRAINT bot_sessions_chat
        FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE RESTRICT,
      CONSTRAINT bot_sessions_platform
        CHECK (platform IS NULL OR platform = 'discord'),
      CONSTRAINT bot_sessions_turn
        CHECK (
          (turn_state IN ('fresh', 'pending') AND completed_at IS NULL) OR
          (
            turn_state = 'completed' AND completed_at IS NOT NULL AND
            completed_at BETWEEN 0 AND 9007199254740991
          )
        )
    ) STRICT
  `;
});
