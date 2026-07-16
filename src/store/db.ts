import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function defaultDbPath(): string {
  return join(homedir(), ".pico", "state.db");
}

export function openDb(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY CHECK (length(id) > 0),
      cwd        TEXT NOT NULL CHECK (length(cwd) > 0),
      platform   TEXT NOT NULL,
      label      TEXT,
      externalId TEXT,
      createdAt  INTEGER NOT NULL CHECK (createdAt >= 0)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS workspaces_platform_external
      ON workspaces (platform, externalId)
      WHERE externalId IS NOT NULL;

    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY CHECK (length(id) > 0),
      workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      cwd         TEXT NOT NULL CHECK (length(cwd) > 0),
      title       TEXT,
      titleSource TEXT,
      externalId  TEXT,
      createdAt   INTEGER NOT NULL CHECK (createdAt >= 0),
      archivedAt  INTEGER CHECK (archivedAt IS NULL OR archivedAt >= 0)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS conversations_workspace_external
      ON conversations (workspaceId, externalId)
      WHERE externalId IS NOT NULL;
  `);
}
