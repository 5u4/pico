import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import initial from "./migrations/0001-initial.ts";
import workspaceModel from "./migrations/0002-workspace-model.ts";
import workspaceDeletion from "./migrations/0003-workspace-deletion.ts";

export const loader = SqliteMigrator.fromRecord({
  "0001_initial": initial,
  "0002_workspace_model": workspaceModel,
  "0003_workspace_deletion": workspaceDeletion,
});
