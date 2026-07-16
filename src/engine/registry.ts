import type { Database } from "bun:sqlite";
import {
  type Conversation,
  conversationSchema,
  type Platform,
  type Workspace,
  workspaceSchema,
} from "../store/schema";
import { newId } from "../util/id";
import { log } from "../util/log";

const logger = log(["engine"]);

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
  logger.info("workspace created {workspaceId} (label {label})", {
    workspaceId: row.id,
    label: input.label,
  });
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

export function renameWorkspace(
  db: Database,
  id: string,
  label: string,
): boolean {
  const result = db
    .query("UPDATE workspaces SET label = $label WHERE id = $id")
    .run({ id, label });
  const renamed = result.changes > 0;
  if (renamed) {
    logger.info("workspace renamed {workspaceId} (label {label})", {
      workspaceId: id,
      label,
    });
  }
  return renamed;
}

export function updateWorkspaceCwd(
  db: Database,
  id: string,
  cwd: string,
): boolean {
  const result = db
    .query("UPDATE workspaces SET cwd = $cwd WHERE id = $id")
    .run({ id, cwd });
  return result.changes > 0;
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
    externalId: input.externalId ?? null,
    createdAt: Date.now(),
    archivedAt: null,
  };
  db.query(
    `INSERT INTO conversations
       (id, workspaceId, cwd, title, externalId, createdAt, archivedAt)
     VALUES
       ($id, $workspaceId, $cwd, $title, $externalId, $createdAt, $archivedAt)`,
  ).run(row);
  logger.info(
    "conversation created {conversationId} in workspace {workspaceId}",
    { conversationId: row.id, workspaceId: input.workspaceId },
  );
  return conversationSchema.parse(row);
}

export function setProvisionalTitle(
  db: Database,
  id: string,
  title: string,
): boolean {
  const result = db
    .query(
      "UPDATE conversations SET title = $title WHERE id = $id AND title IS NULL",
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
    .query("UPDATE conversations SET title = $title WHERE id = $id")
    .run({ id, title });
  return result.changes > 0;
}

export function archiveConversation(db: Database, id: string): boolean {
  const result = db
    .query(
      "UPDATE conversations SET archivedAt = $now WHERE id = $id AND archivedAt IS NULL",
    )
    .run({ id, now: Date.now() });
  const archived = result.changes > 0;
  if (archived) {
    logger.info("conversation archived {conversationId}", {
      conversationId: id,
    });
  }
  return archived;
}
