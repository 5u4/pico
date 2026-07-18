import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  createWorktree,
  removeWorktree,
  renameBranch,
  sanitizeRefSegment,
  slugify,
} from "./worktree.ts";

describe("slugify", () => {
  test("lowercases and hyphenates", () => {
    expect(slugify("Add OAuth Login!")).toBe("add-oauth-login");
  });

  test("trims leading/trailing separators", () => {
    expect(slugify("  --Hello, World--  ")).toBe("hello-world");
  });

  test("truncates without a trailing hyphen", () => {
    const long = `${"a".repeat(40)} ${"b".repeat(40)}`;
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("collapses non-ascii to empty", () => {
    expect(slugify("你好")).toBe("");
  });
});

describe("sanitizeRefSegment", () => {
  test("accepts a single segment", () => {
    expect(sanitizeRefSegment("feat")._unsafeUnwrap()).toBe("feat");
  });

  test("accepts multiple slash segments", () => {
    expect(sanitizeRefSegment("team/feat")._unsafeUnwrap()).toBe("team/feat");
  });

  test("rejects empty", () => {
    expect(sanitizeRefSegment("   ").isErr()).toBe(true);
  });

  test("rejects empty segment", () => {
    expect(sanitizeRefSegment("team//feat").isErr()).toBe(true);
  });

  test("rejects spaces", () => {
    expect(sanitizeRefSegment("my feat").isErr()).toBe(true);
  });

  test("rejects leading dash", () => {
    expect(sanitizeRefSegment("-feat").isErr()).toBe(true);
  });

  test("rejects double dots", () => {
    expect(sanitizeRefSegment("fe..at").isErr()).toBe(true);
  });
});

describe("worktree lifecycle against a real repo", () => {
  let dir: string;
  let repo: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pico-wt-"));
    repo = join(dir, "repo");
    await $`git init -b main ${repo}`.quiet();
    await $`git -C ${repo} config user.email t@t.dev`.quiet();
    await $`git -C ${repo} config user.name test`.quiet();
    await Bun.write(join(repo, "README.md"), "hi");
    await $`git -C ${repo} add -A`.quiet();
    await $`git -C ${repo} commit -m init`.quiet();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("create forks a branch and worktree dir", async () => {
    const dest = join(dir, "wt", "c1");
    const created = await createWorktree({
      baseRepo: repo,
      defaultBranch: "main",
      dest,
      branch: "feat/temp",
    });
    expect(created.isOk()).toBe(true);
    const head = await $`git -C ${dest} rev-parse --abbrev-ref HEAD`
      .quiet()
      .text();
    expect(head.trim()).toBe("feat/temp");
  });

  test("create rejects an unknown base branch", async () => {
    const created = await createWorktree({
      baseRepo: repo,
      defaultBranch: "nope",
      dest: join(dir, "wt", "c1"),
      branch: "feat/temp",
    });
    expect(created.isErr()).toBe(true);
  });

  test("remove deletes the worktree and unregisters it", async () => {
    const dest = join(dir, "wt", "c1");
    await createWorktree({
      baseRepo: repo,
      defaultBranch: "main",
      dest,
      branch: "feat/temp",
    });
    const removed = await removeWorktree({ baseRepo: repo, dest });
    expect(removed.isOk()).toBe(true);
    const list = await $`git -C ${repo} worktree list`.quiet().text();
    expect(list).not.toContain(dest);
  });

  test("rename moves the branch and dedupes collisions", async () => {
    const dest = join(dir, "wt", "c1");
    await createWorktree({
      baseRepo: repo,
      defaultBranch: "main",
      dest,
      branch: "feat/temp",
    });
    await $`git -C ${repo} branch feat/add-login main`.quiet();
    const renamed = await renameBranch({
      baseRepo: repo,
      from: "feat/temp",
      to: "feat/add-login",
    });
    expect(renamed._unsafeUnwrap()).toBe("feat/add-login-2");
  });

  test("rename is a no-op when from equals to", async () => {
    const dest = join(dir, "wt", "c1");
    await createWorktree({
      baseRepo: repo,
      defaultBranch: "main",
      dest,
      branch: "feat/temp",
    });
    const renamed = await renameBranch({
      baseRepo: repo,
      from: "feat/temp",
      to: "feat/temp",
    });
    expect(renamed._unsafeUnwrap()).toBe("feat/temp");
  });
});
