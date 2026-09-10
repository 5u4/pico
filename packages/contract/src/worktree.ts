import type * as Effect from "effect/Effect";
import type { ChatId } from "./chat-model.ts";
import type { GitError, WorkspaceBindingInvalid } from "./errors.ts";
import type { AbsolutePath } from "./path.ts";
import type { WorktreeSettings } from "./workspace-model.ts";

export interface CreateWorktreeOptions {
  readonly chatId: ChatId;
  readonly repositoryCwd: AbsolutePath;
  readonly settings: WorktreeSettings;
}

export interface ValidateWorktreeOptions {
  readonly repositoryCwd: AbsolutePath;
  readonly settings: WorktreeSettings;
}

export type ValidateWorktree = (
  options: ValidateWorktreeOptions,
) => Effect.Effect<void, GitError | WorkspaceBindingInvalid>;

export type CreateWorktree = <A, E>(
  options: CreateWorktreeOptions,
  use: (cwd: AbsolutePath) => Effect.Effect<A, E>,
) => Effect.Effect<A, GitError | E>;

export interface GitWorktree {
  readonly validate: ValidateWorktree;
  readonly create: CreateWorktree;
}
