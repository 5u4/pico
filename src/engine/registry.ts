import type { Database } from "bun:sqlite";
import {
  type Conversation,
  conversationSchema,
  type Platform,
  type Workspace,
  workspaceSchema,
} from "../store/schema";
import { newId } from "../util/id";

export function listWorkspaces(db: Database, platform: Platform): Workspace[] {
  const rows = db
    .query(
      "SELECT * FROM workspaces WHERE platform = $platform ORDER BY createdAt ASC",
    )
    .all({ platform });
  return rows.map((row) => workspaceSchema.parse(row));
}

export function createWorkspace(
  db: Database,
  input: {
    cwd: string;
    platform: Platform;
    label: string | null;
    externalId?: string | null;
  },
): Workspace {
  const row = {
    id: newId(),
    cwd: input.cwd,
    platform: input.platform,
    label: input.label,
    externalId: input.externalId ?? null,
    createdAt: Date.now(),
  };
  db.query(
    `INSERT INTO workspaces (id, cwd, platform, label, externalId, createdAt)
     VALUES ($id, $cwd, $platform, $label, $externalId, $createdAt)`,
  ).run(row);
  return workspaceSchema.parse(row);
}

export function getOrCreateDefaultWorkspace(
  db: Database,
  platform: Platform,
  cwd: string,
  label: string,
): Workspace {
  const existing = db
    .query(
      "SELECT * FROM workspaces WHERE platform = $platform ORDER BY createdAt ASC LIMIT 1",
    )
    .get({ platform });
  if (existing) return workspaceSchema.parse(existing);
  return createWorkspace(db, { cwd, platform, label });
}

export function getWorkspace(db: Database, id: string): Workspace | undefined {
  const row = db.query("SELECT * FROM workspaces WHERE id = $id").get({ id });
  return row ? workspaceSchema.parse(row) : undefined;
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
  input: {
    workspaceId: string;
    cwd: string;
    title: string | null;
    externalId?: string | null;
  },
): Conversation {
  const row = {
    id: newId(),
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    title: input.title,
    titleSource: input.title == null ? null : "final",
    externalId: input.externalId ?? null,
    createdAt: Date.now(),
    archivedAt: null,
  };
  db.query(
    `INSERT INTO conversations
       (id, workspaceId, cwd, title, titleSource, externalId, createdAt, archivedAt)
     VALUES
       ($id, $workspaceId, $cwd, $title, $titleSource, $externalId, $createdAt, $archivedAt)`,
  ).run(row);
  return conversationSchema.parse(row);
}

export function setProvisionalTitle(
  db: Database,
  id: string,
  title: string,
): boolean {
  const result = db
    .query(
      "UPDATE conversations SET title = $title, titleSource = 'provisional' WHERE id = $id AND title IS NULL",
    )
    .run({ id, title });
  return result.changes > 0;
}

export function setConversationTitle(
  db: Database,
  id: string,
  title: string,
): boolean {
  const result = db
    .query(
      "UPDATE conversations SET title = $title, titleSource = 'final' WHERE id = $id AND (titleSource IS NULL OR titleSource = 'provisional')",
    )
    .run({ id, title });
  return result.changes > 0;
}

export function archiveConversation(db: Database, id: string): boolean {
  const result = db
    .query(
      "UPDATE conversations SET archivedAt = $now WHERE id = $id AND archivedAt IS NULL",
    )
    .run({ id, now: Date.now() });
  return result.changes > 0;
}
