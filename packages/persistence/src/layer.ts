import { SQLiteError } from "bun:sqlite";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import type { ChatRepository } from "@pico/contract/chat-repository";
import type { PersistenceError } from "@pico/contract/errors";
import type { AbsolutePath } from "@pico/contract/path";
import type { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as ChatSql from "./chat-repository.ts";
import { failure } from "./error.ts";
import { loader } from "./migrations.ts";
import * as WorkspaceSql from "./workspace-repository.ts";

const bootstrap = Effect.fn("Persistence.bootstrap")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`.pipe(Effect.mapError(failure("persistence.foreignKeys")));
  const migrations = yield* SqliteMigrator.run({ loader }).pipe(
    Effect.catchCause((cause) =>
      Effect.failCause(
        Cause.fromReasons(
          cause.reasons.map((reason) => {
            if (Cause.isFailReason(reason)) {
              return Cause.makeFailReason(failure("persistence.migrate")(reason.error));
            }
            if (
              Cause.isDieReason(reason) &&
              (reason.defect instanceof Migrator.MigrationError ||
                SqlError.isSqlError(reason.defect))
            ) {
              return Cause.makeFailReason(failure("persistence.migrate")(reason.defect));
            }
            return reason;
          }),
        ),
      ),
    ),
  );
  yield* Effect.logInfo("Persistence ready").pipe(
    Effect.annotateLogs({
      component: "persistence",
      operation: "initialize",
      outcome: "ready",
      appliedMigrationCount: migrations.length,
    }),
  );
});

const readySqlLayer = (storeFile: AbsolutePath) =>
  Layer.effectDiscard(bootstrap()).pipe(
    Layer.provideMerge(
      SqliteClient.layer({ filename: storeFile }).pipe(
        Layer.catchCause((cause: Cause.Cause<never>) =>
          Layer.effectContext(
            Effect.failCause(
              Cause.fromReasons(
                cause.reasons.map((reason) => {
                  if (Cause.isDieReason(reason) && reason.defect instanceof SQLiteError) {
                    return Cause.makeFailReason(
                      failure("persistence.open")(
                        new SqlError.SqlError({
                          reason: SqlError.classifySqliteError(reason.defect),
                        }),
                      ),
                    );
                  }
                  return reason;
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

export const layer = (
  storeFile: AbsolutePath,
): Layer.Layer<WorkspaceRepository | ChatRepository, PersistenceError> =>
  Layer.merge(WorkspaceSql.layer, ChatSql.layer).pipe(Layer.provide(readySqlLayer(storeFile)));
