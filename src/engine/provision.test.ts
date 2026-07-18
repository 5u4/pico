import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { openDb } from "../store/db";
import {
  deprovisionConversation,
  provisionConversation,
  renameConversationBranch,
} from "./provision";
import { createWorkspace, getConversation } from "./registry";

let db: Database;
let dir: string;
let repo: string;
let worktreeCwd: string;

beforeEach(async () => {
  db = openDb(":memory:");
  dir = mkdtempSync(join(tmpdir(), "pico-prov-"));
  repo = join(dir, "repo");
  worktreeCwd = join(dir, "worktrees");
  await $`git init -b main ${repo}`.quiet();
  await $`git -C ${repo} config user.email t@t.dev`.quiet();
  await $`git -C ${repo} config user.name test`.quiet();
  await Bun.write(join(repo, "README.md"), "hi");
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -m init`.quiet();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("provisionConversation", () => {
  test("a regular workspace reuses the workspace cwd and forks nothing", async () => {
    const workspace = createWorkspace(db, {
      cwd: repo,
      platform: "web",
      label: null,
    });
    const result = await provisionConversation(
      db,
      workspace,
      worktreeCwd,
      null,
    );
    const conversation = result._unsafeUnwrap();
    expect(conversation.cwd).toBe(repo);
    expect(conversation.branch).toBeNull();
  });

  test("a worktree workspace forks an isolated worktree with a temp branch", async () => {
    const workspace = createWorkspace(db, {
      cwd: repo,
      platform: "web",
      label: null,
      defaultBranch: "main",
      branchPrefix: "feat",
    });
    const result = await provisionConversation(
      db,
      workspace,
      worktreeCwd,
      null,
    );
    const conversation = result._unsafeUnwrap();
    expect(conversation.cwd).toBe(
      join(worktreeCwd, workspace.id, conversation.id),
    );
    expect(conversation.branch).toStartWith("feat/");
    expect(existsSync(conversation.cwd)).toBe(true);
    const persisted = getConversation(db, conversation.id);
    expect(persisted?.cwd).toBe(conversation.cwd);
    expect(persisted?.branch).toBe(conversation.branch);
  });

  test("a bad default branch rolls back the conversation row", async () => {
    const workspace = createWorkspace(db, {
      cwd: repo,
      platform: "web",
      label: null,
      defaultBranch: "nope",
      branchPrefix: "feat",
    });
    const result = await provisionConversation(
      db,
      workspace,
      worktreeCwd,
      null,
    );
    expect(result.isErr()).toBe(true);
    const rows = db.query("SELECT COUNT(*) AS n FROM conversations").get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });
});

describe("renameConversationBranch", () => {
  test("renames the temp branch to a title slug", async () => {
    const workspace = createWorkspace(db, {
      cwd: repo,
      platform: "web",
      label: null,
      defaultBranch: "main",
      branchPrefix: "feat",
    });
    const conversation = (
      await provisionConversation(db, workspace, worktreeCwd, null)
    )._unsafeUnwrap();
    const renamed = await renameConversationBranch(
      db,
      workspace,
      conversation,
      "Add OAuth Login",
    );
    expect(renamed.isOk()).toBe(true);
    expect(getConversation(db, conversation.id)?.branch).toBe(
      "feat/add-oauth-login",
    );
    const fmt = "--format=%(refname:short)";
    const branches = await $`git -C ${repo} branch ${fmt}`.quiet().text();
    expect(branches).toContain("feat/add-oauth-login");
  });

  test("is a no-op for a regular workspace", async () => {
    const workspace = createWorkspace(db, {
      cwd: repo,
      platform: "web",
      label: null,
    });
    const conversation = (
      await provisionConversation(db, workspace, worktreeCwd, null)
    )._unsafeUnwrap();
    const renamed = await renameConversationBranch(
      db,
      workspace,
      conversation,
      "anything",
    );
    expect(renamed.isOk()).toBe(true);
    expect(getConversation(db, conversation.id)?.branch).toBeNull();
  });
});

describe("deprovisionConversation", () => {
  test("removes the worktree directory and unregisters it", async () => {
    const workspace = createWorkspace(db, {
      cwd: repo,
      platform: "web",
      label: null,
      defaultBranch: "main",
      branchPrefix: "feat",
    });
    const conversation = (
      await provisionConversation(db, workspace, worktreeCwd, null)
    )._unsafeUnwrap();
    const removed = await deprovisionConversation(workspace, conversation);
    expect(removed.isOk()).toBe(true);
    expect(existsSync(conversation.cwd)).toBe(false);
    const list = await $`git -C ${repo} worktree list`.quiet().text();
    expect(list).not.toContain(conversation.cwd);
  });
});
