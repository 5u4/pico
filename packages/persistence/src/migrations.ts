import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import initial from "./migrations/0001-initial.ts";

export const loader = SqliteMigrator.fromRecord({
  "0001_initial": initial,
});
