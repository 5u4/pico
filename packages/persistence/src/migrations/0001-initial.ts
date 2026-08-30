import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL CHECK (length(name) > 0),
      platform TEXT,
      external_id TEXT,
      default_cwd TEXT NOT NULL CHECK (length(default_cwd) > 0),
      worktree_branch TEXT,
      worktree_prefix TEXT,
      created_at INTEGER NOT NULL
        CHECK (created_at BETWEEN 0 AND 9007199254740991),

      CONSTRAINT workspaces_platform
        CHECK (platform IS NULL OR platform = 'discord'),
      CONSTRAINT workspaces_binding_pair
        CHECK (
          (platform IS NULL AND external_id IS NULL) OR
          (platform IS NOT NULL AND external_id IS NOT NULL AND length(external_id) > 0)
        ),
      CONSTRAINT workspaces_worktree_pair
        CHECK (
          (worktree_branch IS NULL AND worktree_prefix IS NULL) OR
          (
            worktree_branch IS NOT NULL AND length(worktree_branch) > 0 AND
            worktree_prefix IS NOT NULL AND length(worktree_prefix) > 0
          )
        ),
      CONSTRAINT workspaces_external_identity UNIQUE (platform, external_id)
    ) STRICT
  `;

  yield* sql`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      cwd TEXT NOT NULL CHECK (length(cwd) > 0),
      external_id TEXT CHECK (external_id IS NULL OR length(external_id) > 0),
      created_at INTEGER NOT NULL
        CHECK (created_at BETWEEN 0 AND 9007199254740991),
      archived_at INTEGER
        CHECK (archived_at IS NULL OR archived_at BETWEEN 0 AND 9007199254740991),

      CONSTRAINT chats_workspace
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
      CONSTRAINT chats_external_identity UNIQUE (workspace_id, external_id)
    ) STRICT
  `;

  yield* sql`CREATE INDEX chats_workspace_id ON chats(workspace_id)`;
});
