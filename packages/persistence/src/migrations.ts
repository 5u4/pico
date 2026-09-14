import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import initial from "./migrations/0001-initial.ts";
import botSessions from "./migrations/0002-bot-sessions.ts";
import workspaceBindingGuild from "./migrations/0003-workspace-binding-guild.ts";

export const loader = SqliteMigrator.fromRecord({
  "0001_initial": initial,
  "0002_bot_sessions": botSessions,
  "0003_workspace_binding_guild": workspaceBindingGuild,
});
