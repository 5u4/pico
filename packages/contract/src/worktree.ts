import type * as Effect from "effect/Effect";
import type { ChatId } from "./chat-model.ts";
import type { GitError } from "./errors.ts";
import type { AbsolutePath } from "./path.ts";
import type { WorktreeSettings } from "./workspace-model.ts";

export interface CreateWorktreeOptions {
  readonly chatId: ChatId;
  readonly repositoryCwd: AbsolutePath;
  readonly settings: WorktreeSettings;
}

export type CreateWorktree = <A, E>(
  options: CreateWorktreeOptions,
  use: (cwd: AbsolutePath) => Effect.Effect<A, E>,
) => Effect.Effect<A, GitError | E>;
