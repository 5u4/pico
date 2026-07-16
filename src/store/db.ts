import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Result } from "neverthrow";
import { log } from "../util/log.ts";

const dbLog = log(["db"]);

export function defaultDbPath(): string {
  return join(homedir(), ".pico", "state.db");
}

export function openDb(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return traceDb(db);
}

const STATEMENT_EXECUTORS = new Set(["run", "get", "all", "values", "iterate"]);

function traced<T>(
  sql: string,
  params: readonly unknown[],
  execute: () => T,
): T {
  const startedAt = performance.now();
  const outcome = Result.fromThrowable(execute)();
  const ms = Math.round((performance.now() - startedAt) * 100) / 100;
  dbLog.debug("{sql} {params} ({ms}ms)", { sql, params, ms });
  return outcome.match(
    (value) => value,
    (error) => {
      throw error;
    },
  );
}

function traceStatement<T extends Statement>(stmt: T, sql: string): T {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const method = value.bind(target);
      if (typeof prop === "string" && STATEMENT_EXECUTORS.has(prop)) {
        return (...params: unknown[]) =>
          traced(sql, params, () => method(...params));
      }
      return method;
    },
  });
}

function traceDb(db: Database): Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const method = value.bind(target);
      if (prop === "query" || prop === "prepare") {
        return (...args: unknown[]) =>
          traceStatement(method(...args), String(args[0]));
      }
      if (prop === "run") {
        return (sql: string, ...params: unknown[]) =>
          traced(sql, params, () => method(sql, ...params));
      }
      return method;
    },
  });
}

function migrate(db: Database): void {
  db.run(`
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
      externalId  TEXT,
      createdAt   INTEGER NOT NULL CHECK (createdAt >= 0),
      archivedAt  INTEGER CHECK (archivedAt IS NULL OR archivedAt >= 0)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS conversations_workspace_external
      ON conversations (workspaceId, externalId)
      WHERE externalId IS NOT NULL;
  `);
}
