import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import {
  type Conversation,
  isWorktreeWorkspace,
  type Workspace,
} from "../store/schema";
import { createConversation } from "./registry";
import {
  createWorktree,
  currentBranch,
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

function initialBranch(
  workspace: Workspace & { branchPrefix: string },
  conversationId: string,
): string {
  return `${workspace.branchPrefix}/${conversationId.slice(-8).toLowerCase()}`;
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
  const branch = initialBranch(workspace, conversation.id);
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
  db.query("UPDATE conversations SET cwd = $cwd WHERE id = $id").run({
    cwd: dest,
    id: conversation.id,
  });
  return ok({ ...conversation, cwd: dest });
}
export function deprovisionConversation(
  workspace: Workspace,
  conversation: Conversation,
): Promise<Result<void, string>> {
  if (!isWorktreeWorkspace(workspace)) return Promise.resolve(ok());
  return removeWorktree({ baseRepo: workspace.cwd, dest: conversation.cwd });
}

export async function renameConversationBranch(
  workspace: Workspace,
  conversation: Conversation,
  title: string,
): Promise<Result<void, string>> {
  if (!isWorktreeWorkspace(workspace)) return ok();
  const slug = slugify(title);
  if (!slug) return ok();
  const live = await currentBranch(conversation.cwd);
  if (live.isErr() || live.value !== initialBranch(workspace, conversation.id))
    return ok();
  const renamed = await renameBranch({
    baseRepo: workspace.cwd,
    from: live.value,
    to: `${workspace.branchPrefix}/${slug}`,
  });
  if (renamed.isErr()) return err(renamed.error);
  return ok();
}
