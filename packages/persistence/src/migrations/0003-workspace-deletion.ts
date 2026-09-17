import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE workspaces ADD COLUMN deleted_at INTEGER
      CHECK (deleted_at IS NULL OR deleted_at BETWEEN 0 AND 9007199254740991)
  `;
});
