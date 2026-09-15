import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import initial from "./migrations/0001-initial.ts";
import workspaceModel from "./migrations/0002-workspace-model.ts";

export const loader = SqliteMigrator.fromRecord({
  "0001_initial": initial,
  "0002_workspace_model": workspaceModel,
});
