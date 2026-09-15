import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE workspaces ADD COLUMN model_provider TEXT`;
  yield* sql`
    ALTER TABLE workspaces ADD COLUMN model_id TEXT
      CONSTRAINT workspaces_model_pair CHECK (
        (model_provider IS NULL AND model_id IS NULL) OR
        (
          model_provider IS NOT NULL AND length(model_provider) > 0 AND
          model_id IS NOT NULL AND length(model_id) > 0
        )
      )
  `;
});
