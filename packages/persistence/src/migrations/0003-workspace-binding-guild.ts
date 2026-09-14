import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE workspaces ADD COLUMN guild_id TEXT
    CHECK (guild_id IS NULL OR (platform IS 'discord' AND length(guild_id) > 0))
  `;
});
