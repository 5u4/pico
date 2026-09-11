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

export interface ChatWorktreeOptions {
  readonly chatId: ChatId;
  readonly cwd: AbsolutePath;
}

export interface RenameChatBranchOptions extends ChatWorktreeOptions {
  readonly prefix: string;
  readonly topic: string;
}

export type RenameChatBranchResult =
  | { readonly kind: "renamed" }
  | { readonly kind: "already-renamed" }
  | {
      readonly kind: "skipped";
      readonly reason:
        | "not-managed"
        | "already-absent"
        | "invalid-target"
        | "detached"
        | "branch-changed"
        | "remote-state"
        | "target-exists";
    };

export type WorktreeInspection =
  | { readonly kind: "not-managed" }
  | { readonly kind: "managed"; readonly state: "absent" | "clean" | "dirty" };

export interface RemoveChatWorktreeOptions extends ChatWorktreeOptions {
  readonly force: boolean;
}

export type RemoveChatWorktreeResult =
  | { readonly kind: "not-managed" }
  | { readonly kind: "already-absent" }
  | { readonly kind: "removed" }
  | { readonly kind: "force-required" };

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
  readonly inspectChat: (
    options: ChatWorktreeOptions,
  ) => Effect.Effect<WorktreeInspection, GitError>;
  readonly renameChatBranch: (
    options: RenameChatBranchOptions,
  ) => Effect.Effect<RenameChatBranchResult, GitError>;
  readonly removeChat: (
    options: RemoveChatWorktreeOptions,
  ) => Effect.Effect<RemoveChatWorktreeResult, GitError>;
}
