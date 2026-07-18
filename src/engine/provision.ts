import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import {
  type Conversation,
  isWorktreeWorkspace,
  type Workspace,
} from "../store/schema";
import { createConversation, setConversationBranch } from "./registry";
import {
  createWorktree,
  removeWorktree,
  renameBranch,
  slugify,
} from "./worktree";

export function worktreeDest(
  worktreeCwd: string,
  workspaceId: string,
  conversationId: string,
): string {
  return join(worktreeCwd, workspaceId, conversationId);
}

export async function provisionConversation(
  db: Database,
  workspace: Workspace,
  worktreeCwd: string,
  title: string | null,
): Promise<Result<Conversation, string>> {
  const conversation = createConversation(db, {
    workspaceId: workspace.id,
    cwd: workspace.cwd,
    title,
  });
  if (!isWorktreeWorkspace(workspace)) return ok(conversation);

  const dest = worktreeDest(worktreeCwd, workspace.id, conversation.id);
  const branch = `${workspace.branchPrefix}/${conversation.id.slice(-8).toLowerCase()}`;
  const created = await createWorktree({
    baseRepo: workspace.cwd,
    defaultBranch: workspace.defaultBranch,
    dest,
    branch,
  });
  if (created.isErr()) {
    db.query("DELETE FROM conversations WHERE id = $id").run({
      id: conversation.id,
    });
    return err(created.error);
  }
  db.query(
    "UPDATE conversations SET cwd = $cwd, branch = $branch WHERE id = $id",
  ).run({ cwd: dest, branch, id: conversation.id });
  return ok({ ...conversation, cwd: dest, branch });
}
export function deprovisionConversation(
  workspace: Workspace,
  conversation: Conversation,
): Promise<Result<void, string>> {
  if (!isWorktreeWorkspace(workspace)) return Promise.resolve(ok());
  return removeWorktree({ baseRepo: workspace.cwd, dest: conversation.cwd });
}

export async function renameConversationBranch(
  db: Database,
  workspace: Workspace,
  conversation: Conversation,
  title: string,
): Promise<Result<void, string>> {
  if (!isWorktreeWorkspace(workspace) || !conversation.branch) return ok();
  const slug = slugify(title);
  if (!slug) return ok();
  const renamed = await renameBranch({
    baseRepo: workspace.cwd,
    from: conversation.branch,
    to: `${workspace.branchPrefix}/${slug}`,
  });
  if (renamed.isErr()) return err(renamed.error);
  setConversationBranch(db, conversation.id, renamed.value);
  return ok();
}
