import type { ChatId } from "@pico/contract/chat-model";
import { GitError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import type { WorktreeSettings } from "@pico/contract/workspace-model";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export interface CreateOptions {
  readonly chatId: ChatId;
  readonly repositoryCwd: AbsolutePath;
  readonly worktreesDir: AbsolutePath;
  readonly settings: WorktreeSettings;
}

interface CreatedWorktree {
  readonly repositoryCwd: AbsolutePath;
  readonly cwd: AbsolutePath;
  readonly branch: string;
}

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

const gitError = (action: string) => new GitError({ message: `Failed to ${action}` });

const runGit = Effect.fn("GitWorktree.runGit")(function* (
  spawner: Spawner,
  repositoryCwd: AbsolutePath,
  action: string,
  args: ReadonlyArray<string>,
) {
  const { exitCode } = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: repositoryCwd }));
      return yield* Effect.all(
        {
          output: Stream.runDrain(handle.all),
          exitCode: handle.exitCode,
        },
        { concurrency: "unbounded" },
      );
    }),
  ).pipe(Effect.mapError(() => gitError(action)));

  if (exitCode !== 0) return yield* gitError(action);
});

const acquire = Effect.fn("GitWorktree.create.acquire")(function* (options: CreateOptions) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = AbsolutePath.make(path.join(options.worktreesDir, options.chatId));
  const worktree: CreatedWorktree = {
    repositoryCwd: options.repositoryCwd,
    cwd,
    branch: options.settings.prefix + options.chatId,
  };

  yield* fileSystem
    .makeDirectory(options.worktreesDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(() => gitError("create worktrees directory")));
  yield* runGit(spawner, worktree.repositoryCwd, "create worktree", [
    "worktree",
    "add",
    "-b",
    worktree.branch,
    "--",
    worktree.cwd,
    options.settings.branch,
  ]);

  return worktree;
});

const ignoreCleanupFailure = <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logError(message, Cause.pretty(cause))),
  );

const rollback = Effect.fn("GitWorktree.create.rollback")(function* (worktree: CreatedWorktree) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  yield* ignoreCleanupFailure(
    "Failed to roll back Git worktree",
    runGit(spawner, worktree.repositoryCwd, "remove worktree", [
      "worktree",
      "remove",
      "--force",
      "--",
      worktree.cwd,
    ]),
  );
  yield* ignoreCleanupFailure(
    "Failed to roll back Git branch",
    runGit(spawner, worktree.repositoryCwd, "delete worktree branch", [
      "branch",
      "-D",
      "--",
      worktree.branch,
    ]),
  );
});

export const create = Effect.fn("GitWorktree.create")(function* <A, E, R>(
  options: CreateOptions,
  commit: (cwd: AbsolutePath) => Effect.Effect<A, E, R>,
): Effect.fn.Return<
  A,
  GitError | E,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | R
> {
  return yield* Effect.uninterruptible(
    Effect.acquireUseRelease(
      acquire(options),
      (worktree) => commit(worktree.cwd),
      (worktree, exit) => (Exit.isFailure(exit) ? rollback(worktree) : Effect.void),
    ),
  );
});
