import type { Database } from "bun:sqlite";
import {
  type Conversation,
  conversationSchema,
  type Workspace,
  workspaceSchema,
} from "../store/schema";
import { newId } from "../util/id";

const WEB_WORKSPACE_LABEL = "web";

export function getOrCreateWebWorkspace(
  db: Database,
  projectsRoot: string,
): Workspace {
  const existing = db
    .query(
      "SELECT * FROM workspaces WHERE platform = 'web' ORDER BY createdAt ASC LIMIT 1",
    )
    .get();
  if (existing) return workspaceSchema.parse(existing);

  const row = {
    id: newId(),
    cwd: projectsRoot,
    platform: "web",
    label: WEB_WORKSPACE_LABEL,
    externalId: null,
    createdAt: Date.now(),
  };
  db.query(
    `INSERT INTO workspaces (id, cwd, platform, label, externalId, createdAt)
     VALUES ($id, $cwd, $platform, $label, $externalId, $createdAt)`,
  ).run(row);
  return workspaceSchema.parse(row);
}

export function listConversations(
  db: Database,
  workspaceId: string,
): Conversation[] {
  const rows = db
    .query(
      `SELECT * FROM conversations
       WHERE workspaceId = $workspaceId AND archivedAt IS NULL
       ORDER BY createdAt DESC`,
    )
    .all({ workspaceId });
  return rows.map((row) => conversationSchema.parse(row));
}

export function getConversation(
  db: Database,
  id: string,
): Conversation | undefined {
  const row = db
    .query("SELECT * FROM conversations WHERE id = $id")
    .get({ id });
  return row ? conversationSchema.parse(row) : undefined;
}

export function createConversation(
  db: Database,
  input: { workspaceId: string; cwd: string; title: string | null },
): Conversation {
  const row = {
    id: newId(),
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    title: input.title,
    externalId: null,
    createdAt: Date.now(),
    archivedAt: null,
  };
  db.query(
    `INSERT INTO conversations
       (id, workspaceId, cwd, title, externalId, createdAt, archivedAt)
     VALUES
       ($id, $workspaceId, $cwd, $title, $externalId, $createdAt, $archivedAt)`,
  ).run(row);
  return conversationSchema.parse(row);
}
