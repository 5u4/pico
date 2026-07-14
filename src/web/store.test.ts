import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../store/db.ts";
import {
  createConversation,
  createWorkspace,
  getConversation,
  getOrCreateDefaultWorkspace,
  listConversations,
  listWorkspaces,
} from "./store.ts";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("workspaces", () => {
  test("createWorkspace stores a web workspace", () => {
    const ws = createWorkspace(db, { cwd: "/projects", label: "alpha" });
    expect(ws.platform).toBe("web");
    expect(ws.externalId).toBeNull();
    expect(ws.cwd).toBe("/projects");
    expect(ws.label).toBe("alpha");
  });

  test("listWorkspaces returns all web workspaces oldest first", () => {
    const a = createWorkspace(db, { cwd: "/a", label: "a" });
    const b = createWorkspace(db, { cwd: "/b", label: "b" });
    expect(listWorkspaces(db).map((w) => w.id)).toEqual([a.id, b.id]);
  });

  test("getOrCreateDefaultWorkspace bootstraps once then reuses", () => {
    const first = getOrCreateDefaultWorkspace(db, "/projects");
    const second = getOrCreateDefaultWorkspace(db, "/other");
    expect(second.id).toBe(first.id);
    expect(second.cwd).toBe("/projects");
    expect(listWorkspaces(db)).toHaveLength(1);
  });
});

describe("conversations", () => {
  test("create then get round-trips", () => {
    const ws = createWorkspace(db, { cwd: "/projects", label: "w" });
    const created = createConversation(db, {
      workspaceId: ws.id,
      cwd: "/projects",
      title: "first",
    });
    expect(getConversation(db, created.id)).toEqual(created);
  });

  test("lists newest first and excludes archived", () => {
    const ws = createWorkspace(db, { cwd: "/projects", label: "w" });
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
