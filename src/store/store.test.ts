import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_SCHEMA_VERSION, openDb } from "./db.ts";
import { conversationSchema, workspaceSchema } from "./schema.ts";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

function insertWorkspace(row: {
  id: string;
  cwd: string;
  platform: string;
  label: string | null;
  externalId: string | null;
  createdAt: number;
}) {
  db.query(
    `INSERT INTO workspaces (id, cwd, platform, label, externalId, createdAt)
     VALUES ($id, $cwd, $platform, $label, $externalId, $createdAt)`,
  ).run(row);
}

function insertConversation(row: {
  id: string;
  workspaceId: string;
  cwd: string;
  title: string | null;
  externalId: string | null;
  createdAt: number;
  archivedAt: number | null;
}) {
  db.query(
    `INSERT INTO conversations
       (id, workspaceId, cwd, title, externalId, createdAt, archivedAt)
     VALUES
       ($id, $workspaceId, $cwd, $title, $externalId, $createdAt, $archivedAt)`,
  ).run(row);
}

describe("schema <-> DDL round-trip", () => {
  test("a persisted workspace row parses against workspaceSchema", () => {
    insertWorkspace({
      id: "w1",
      cwd: "/repo",
      platform: "discord",
      label: "general",
      externalId: "chan1",
      createdAt: 1000,
    });
    const row = db.query("SELECT * FROM workspaces WHERE id = 'w1'").get();
    expect(workspaceSchema.parse(row)).toEqual({
      id: "w1",
      cwd: "/repo",
      platform: "discord",
      label: "general",
      externalId: "chan1",
      createdAt: 1000,
    });
  });

  test("nullable columns survive as null through the schema", () => {
    insertWorkspace({
      id: "w1",
      cwd: "/repo",
      platform: "web",
      label: null,
      externalId: null,
      createdAt: 1000,
    });
    insertConversation({
      id: "c1",
      workspaceId: "w1",
      cwd: "/repo",
      title: null,
      externalId: null,
      createdAt: 2000,
      archivedAt: null,
    });
    const convo = db.query("SELECT * FROM conversations WHERE id = 'c1'").get();
    const parsed = conversationSchema.parse(convo);
    expect(parsed.title).toBeNull();
    expect(parsed.externalId).toBeNull();
    expect(parsed.archivedAt).toBeNull();
  });
});

describe("routing-key constraints", () => {
  test("UNIQUE (platform, externalId) rejects a duplicate discord channel", () => {
    insertWorkspace({
      id: "w1",
      cwd: "/a",
      platform: "discord",
      label: null,
      externalId: "chan1",
      createdAt: 1,
    });
    expect(() =>
      insertWorkspace({
        id: "w2",
        cwd: "/b",
        platform: "discord",
        label: null,
        externalId: "chan1",
        createdAt: 2,
      }),
    ).toThrow();
  });

  test("null externalId is exempt: web workspaces may share a cwd", () => {
    insertWorkspace({
      id: "w1",
      cwd: "/shared",
      platform: "web",
      label: null,
      externalId: null,
      createdAt: 1,
    });
    expect(() =>
      insertWorkspace({
        id: "w2",
        cwd: "/shared",
        platform: "web",
        label: null,
        externalId: null,
        createdAt: 2,
      }),
    ).not.toThrow();
  });

  test("the same externalId under a different platform is allowed", () => {
    insertWorkspace({
      id: "w1",
      cwd: "/a",
      platform: "discord",
      label: null,
      externalId: "chan1",
      createdAt: 1,
    });
    expect(() =>
      insertWorkspace({
        id: "w2",
        cwd: "/b",
        platform: "web",
        label: null,
        externalId: "chan1",
        createdAt: 2,
      }),
    ).not.toThrow();
  });

  test("UNIQUE (workspaceId, externalId) rejects a duplicate thread", () => {
    insertWorkspace({
      id: "w1",
      cwd: "/a",
      platform: "discord",
      label: null,
      externalId: "chan1",
      createdAt: 1,
    });
    insertConversation({
      id: "c1",
      workspaceId: "w1",
      cwd: "/a",
      title: null,
      externalId: "t1",
      createdAt: 2,
      archivedAt: null,
    });
    expect(() =>
      insertConversation({
        id: "c2",
        workspaceId: "w1",
        cwd: "/a",
        title: null,
        externalId: "t1",
        createdAt: 3,
        archivedAt: null,
      }),
    ).toThrow();
  });
});

describe("value CHECK constraints", () => {
  test("empty cwd is rejected", () => {
    expect(() =>
      insertWorkspace({
        id: "w1",
        cwd: "",
        platform: "discord",
        label: null,
        externalId: "chan1",
        createdAt: 1,
      }),
    ).toThrow();
  });

  test("negative createdAt is rejected", () => {
    expect(() =>
      insertWorkspace({
        id: "w1",
        cwd: "/a",
        platform: "discord",
        label: null,
        externalId: "chan1",
        createdAt: -1,
      }),
    ).toThrow();
  });
});

describe("foreign key cascade", () => {
  test("deleting a workspace cascades to its conversations", () => {
    insertWorkspace({
      id: "w1",
      cwd: "/a",
      platform: "discord",
      label: null,
      externalId: "chan1",
      createdAt: 1,
    });
    insertConversation({
      id: "c1",
      workspaceId: "w1",
      cwd: "/a",
      title: null,
      externalId: "t1",
      createdAt: 2,
      archivedAt: null,
    });
    db.query("DELETE FROM workspaces WHERE id = 'w1'").run();
    const row = db.query("SELECT * FROM conversations WHERE id = 'c1'").get();
    expect(row).toBeNull();
  });
});

describe("schema versioning", () => {
  test("a freshly opened database is stamped at the latest migration version", () => {
    const { user_version } = db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(user_version).toBe(LATEST_SCHEMA_VERSION);
  });

  test("reopening an on-disk database is a no-op that preserves rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "pico-store-"));
    const path = join(dir, "state.db");
    try {
      const first = openDb(path);
      first
        .query(
          `INSERT INTO workspaces (id, cwd, platform, label, externalId, createdAt)
           VALUES ('w1', '/repo', 'web', NULL, NULL, 1000)`,
        )
        .run();
      first.close();

      const second = openDb(path);
      const version = second.query("PRAGMA user_version").get() as {
        user_version: number;
      };
      const row = second
        .query("SELECT id FROM workspaces WHERE id = 'w1'")
        .get();
      second.close();

      expect(version.user_version).toBe(LATEST_SCHEMA_VERSION);
      expect(row).toEqual({ id: "w1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
