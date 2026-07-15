import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../store/db.ts";
import {
  archiveConversation,
  createConversation,
  createWorkspace,
  getConversation,
  getOrCreateDefaultWorkspace,
  listConversations,
  listWorkspaces,
  setConversationTitle,
} from "./registry.ts";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("workspaces", () => {
  test("createWorkspace stores a platform workspace", () => {
    const ws = createWorkspace(db, {
      cwd: "/projects",
      platform: "web",
      label: "alpha",
    });
    expect(ws.platform).toBe("web");
    expect(ws.externalId).toBeNull();
    expect(ws.cwd).toBe("/projects");
    expect(ws.label).toBe("alpha");
  });

  test("listWorkspaces filters by platform, oldest first", () => {
    const a = createWorkspace(db, { cwd: "/a", platform: "web", label: "a" });
    const b = createWorkspace(db, { cwd: "/b", platform: "web", label: "b" });
    createWorkspace(db, { cwd: "/c", platform: "discord", label: "c" });
    expect(listWorkspaces(db, "web").map((w) => w.id)).toEqual([a.id, b.id]);
  });

  test("getOrCreateDefaultWorkspace bootstraps once then reuses", () => {
    const first = getOrCreateDefaultWorkspace(db, "web", "/projects", "web");
    const second = getOrCreateDefaultWorkspace(db, "web", "/other", "web");
    expect(second.id).toBe(first.id);
    expect(second.cwd).toBe("/projects");
    expect(listWorkspaces(db, "web")).toHaveLength(1);
  });
});

describe("conversations", () => {
  test("create then get round-trips", () => {
    const ws = createWorkspace(db, {
      cwd: "/projects",
      platform: "web",
      label: "w",
    });
    const created = createConversation(db, {
      workspaceId: ws.id,
      cwd: "/projects",
      title: "first",
    });
    expect(getConversation(db, created.id)).toEqual(created);
  });

  test("lists newest first and excludes archived", () => {
    const ws = createWorkspace(db, {
      cwd: "/projects",
      platform: "web",
      label: "w",
    });
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

  test("setConversationTitle names an untitled conversation once", () => {
    const ws = createWorkspace(db, {
      cwd: "/projects",
      platform: "web",
      label: "w",
    });
    const c = createConversation(db, {
      workspaceId: ws.id,
      cwd: "/projects",
      title: null,
    });
    expect(setConversationTitle(db, c.id, "generated")).toBe(true);
    expect(getConversation(db, c.id)?.title).toBe("generated");
  });

  test("setConversationTitle refuses to overwrite an existing title", () => {
    const ws = createWorkspace(db, {
      cwd: "/projects",
      platform: "web",
      label: "w",
    });
    const c = createConversation(db, {
      workspaceId: ws.id,
      cwd: "/projects",
      title: "kept",
    });
    expect(setConversationTitle(db, c.id, "other")).toBe(false);
    expect(getConversation(db, c.id)?.title).toBe("kept");
  });

  test("setConversationTitle reports no change for an unknown id", () => {
    expect(setConversationTitle(db, "missing", "x")).toBe(false);
  });

  test("archiveConversation hides it from the workspace list", () => {
    const ws = createWorkspace(db, {
      cwd: "/projects",
      platform: "web",
      label: "w",
    });
    const c = createConversation(db, {
      workspaceId: ws.id,
      cwd: "/projects",
      title: "gone",
    });
    expect(archiveConversation(db, c.id)).toBe(true);
    expect(listConversations(db, ws.id)).toHaveLength(0);
    expect(getConversation(db, c.id)?.archivedAt).toBeGreaterThan(0);
  });

  test("archiveConversation is idempotent and reports no change when already archived", () => {
    const ws = createWorkspace(db, {
      cwd: "/projects",
      platform: "web",
      label: "w",
    });
    const c = createConversation(db, {
      workspaceId: ws.id,
      cwd: "/projects",
      title: "once",
    });
    expect(archiveConversation(db, c.id)).toBe(true);
    expect(archiveConversation(db, c.id)).toBe(false);
  });

  test("archiveConversation reports no change for an unknown id", () => {
    expect(archiveConversation(db, "missing")).toBe(false);
  });
});
