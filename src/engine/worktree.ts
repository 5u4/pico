import { $ } from "bun";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { log } from "../util/log";
import { errMessage } from "../util/result";

const logger = log(["worktree"]);

const SLUG_MAX = 48;
const RENAME_COLLISION_LIMIT = 50;
async function git(
  baseRepo: string,
  args: string[],
): Promise<Result<string, string>> {
  const spawned = await ResultAsync.fromPromise(
    $`git -C ${baseRepo} ${args}`.quiet().nothrow(),
    errMessage,
  );
  if (spawned.isErr()) return err(spawned.error);
  const output = spawned.value;
  if (output.exitCode !== 0) {
    const stderr = output.stderr.toString().trim();
    return err(`git ${args.join(" ")} failed: ${stderr || "unknown error"}`);
  }
  return ok(output.stdout.toString().trim());
}
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug;
}

export function sanitizeRefSegment(prefix: string): Result<string, string> {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return err("branch prefix must not be empty");
  const parts = trimmed.split("/").map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) {
    return err("branch prefix must not contain empty segments");
  }
  for (const part of parts) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)) {
      return err(`invalid branch prefix segment: ${part}`);
    }
    if (part.includes("..") || part.endsWith(".lock")) {
      return err(`invalid branch prefix segment: ${part}`);
    }
  }
  return ok(parts.join("/"));
}

export async function createWorktree(input: {
  baseRepo: string;
  defaultBranch: string;
  dest: string;
  branch: string;
}): Promise<Result<void, string>> {
  const { baseRepo, defaultBranch, dest, branch } = input;
  const base = await git(baseRepo, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${defaultBranch}^{commit}`,
  ]);
  if (base.isErr()) return err(base.error);
  const added = await git(baseRepo, [
    "worktree",
    "add",
    "-b",
    branch,
    "--",
    dest,
    defaultBranch,
  ]);
  if (added.isErr()) return err(added.error);
  logger.info("worktree created {dest} on {branch}", { dest, branch });
  return ok();
}

export async function removeWorktree(input: {
  baseRepo: string;
  dest: string;
}): Promise<Result<void, string>> {
  const removed = await git(input.baseRepo, [
    "worktree",
    "remove",
    "--force",
    input.dest,
  ]);
  if (removed.isErr()) return err(removed.error);
  logger.info("worktree removed {dest}", { dest: input.dest });
  return ok();
}

async function branchExists(baseRepo: string, name: string): Promise<boolean> {
  const result = await git(baseRepo, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${name}`,
  ]);
  return result.isOk();
}

export async function renameBranch(input: {
  baseRepo: string;
  from: string;
  to: string;
}): Promise<Result<string, string>> {
  const { baseRepo, from } = input;
  let target = input.to;
  for (let n = 2; n <= RENAME_COLLISION_LIMIT; n++) {
    if (target === from) return ok(from);
    if (!(await branchExists(baseRepo, target))) break;
    target = `${input.to}-${n}`;
  }
  const renamed = await git(baseRepo, ["branch", "-m", from, target]);
  if (renamed.isErr()) return err(renamed.error);
  logger.info("branch renamed {from} -> {to}", { from, to: target });
  return ok(target);
}
