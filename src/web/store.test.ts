import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../store/db.ts";
import {
  createConversation,
  getConversation,
  getOrCreateWebWorkspace,
  listConversations,
} from "./store.ts";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("getOrCreateWebWorkspace", () => {
  test("creates a web workspace with null externalId", () => {
    const ws = getOrCreateWebWorkspace(db, "/projects");
    expect(ws.platform).toBe("web");
    expect(ws.externalId).toBeNull();
    expect(ws.cwd).toBe("/projects");
  });

  test("returns the same workspace on repeated calls", () => {
    const first = getOrCreateWebWorkspace(db, "/projects");
    const second = getOrCreateWebWorkspace(db, "/other");
    expect(second.id).toBe(first.id);
    expect(second.cwd).toBe("/projects");
  });
});

describe("conversations", () => {
  test("create then get round-trips", () => {
    const ws = getOrCreateWebWorkspace(db, "/projects");
    const created = createConversation(db, {
      workspaceId: ws.id,
      cwd: "/projects",
      title: "first",
    });
    expect(getConversation(db, created.id)).toEqual(created);
  });

  test("lists newest first and excludes archived", () => {
    const ws = getOrCreateWebWorkspace(db, "/projects");
    const a = createConversation(db, {
      workspaceId: ws.id,
      cwd: "/projects",
      title: "a",
    });
    const b = createConversation(db, {
      workspaceId: ws.id,
      cwd: "/projects",
      title: "b",
    });
    db.query("UPDATE conversations SET archivedAt = 1 WHERE id = $id").run({
      id: a.id,
    });
    const listed = listConversations(db, ws.id);
    expect(listed.map((c) => c.id)).toEqual([b.id]);
  });

  test("returns undefined for an unknown conversation", () => {
    expect(getConversation(db, "missing")).toBeUndefined();
  });
});
