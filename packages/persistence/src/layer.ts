import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import type { ChatRepository } from "@pico/contract/chat-repository";
import { PersistenceError } from "@pico/contract/errors";
import type { AbsolutePath } from "@pico/contract/path";
import type { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ChatSql from "./chat-repository.ts";
import { loader } from "./migrations.ts";
import * as WorkspaceSql from "./workspace-repository.ts";

const bootstrap = Effect.fn("Persistence.bootstrap")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* SqliteMigrator.run({ loader });
  },
  Effect.mapError(() => new PersistenceError({ message: "Failed to initialize persistence" })),
);

const readySqlLayer = (storeFile: AbsolutePath) =>
  Layer.effectDiscard(bootstrap()).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: storeFile })),
  );

export const layer = (
  storeFile: AbsolutePath,
): Layer.Layer<WorkspaceRepository | ChatRepository, PersistenceError> =>
  Layer.merge(WorkspaceSql.layer, ChatSql.layer).pipe(Layer.provide(readySqlLayer(storeFile)));
