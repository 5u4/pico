import { GitError, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import type {
  CreateWorktree,
  CreateWorktreeOptions,
  GitWorktree,
  ValidateWorktreeOptions,
} from "@pico/contract/worktree";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

interface CreatedWorktree {
  readonly repositoryCwd: AbsolutePath;
  readonly cwd: AbsolutePath;
  readonly branch: string;
}

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

const validationError = (issue: WorkspaceBindingInvalid["issue"]) =>
  new WorkspaceBindingInvalid({ issue });

const gitError = (action: string) => new GitError({ message: `Failed to ${action}` });

const runGitExit = Effect.fn("GitWorktree.runGitExit")(function* (
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

  return exitCode === 0;
});

const runGit = Effect.fn("GitWorktree.runGit")(function* (
  spawner: Spawner,
  repositoryCwd: AbsolutePath,
  action: string,
  args: ReadonlyArray<string>,
) {
  if (!(yield* runGitExit(spawner, repositoryCwd, action, args))) return yield* gitError(action);
});

const validate = Effect.fn("GitWorktree.validate")(function* (
  spawner: Spawner,
  options: ValidateWorktreeOptions,
) {
  if (options.settings.branch.trim() !== options.settings.branch) {
    return yield* validationError({ field: "branch", reason: "surrounding-whitespace" });
  }
  if (options.settings.prefix.trim() !== options.settings.prefix) {
    return yield* validationError({ field: "prefix", reason: "surrounding-whitespace" });
  }

  if (
    !(yield* runGitExit(spawner, options.repositoryCwd, "inspect repository", [
      "rev-parse",
      "--git-dir",
    ]))
  ) {
    return yield* validationError({ field: "repository", reason: "not-repository" });
  }
  if (
    options.settings.branch.length === 0 ||
    !(yield* runGitExit(spawner, options.repositoryCwd, "inspect branch", [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${options.settings.branch}^{commit}`,
    ]))
  ) {
    return yield* validationError({ field: "branch", reason: "not-commit" });
  }
  if (
    options.settings.prefix.length === 0 ||
    !(yield* runGitExit(spawner, options.repositoryCwd, "inspect prefix", [
      "check-ref-format",
      "--branch",
      `${options.settings.prefix}018f47a0-0000-7000-8000-000000000000`,
    ]))
  ) {
    return yield* validationError({ field: "prefix", reason: "invalid-ref" });
  }
});

const acquire = Effect.fn("GitWorktree.create.acquire")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  spawner: Spawner,
  worktreesDir: AbsolutePath,
  options: CreateWorktreeOptions,
) {
  const cwd = AbsolutePath.make(path.join(worktreesDir, options.chatId));
  const worktree: CreatedWorktree = {
    repositoryCwd: options.repositoryCwd,
    cwd,
    branch: options.settings.prefix + options.chatId,
  };

  yield* fileSystem
    .makeDirectory(worktreesDir, { recursive: true, mode: 0o700 })
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

const rollback = Effect.fn("GitWorktree.create.rollback")(function* (
  spawner: Spawner,
  worktree: CreatedWorktree,
) {
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

export const make = Effect.fn("GitWorktree.make")(function* (
  worktreesDir: AbsolutePath,
): Effect.fn.Return<
  GitWorktree,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const create: CreateWorktree = Effect.fn("GitWorktree.create")(function* <A, E>(
    options: CreateWorktreeOptions,
    use: (cwd: AbsolutePath) => Effect.Effect<A, E>,
  ): Effect.fn.Return<A, GitError | E> {
    return yield* Effect.acquireUseRelease(
      acquire(fileSystem, path, spawner, worktreesDir, options),
      (worktree) => use(worktree.cwd),
      (worktree, exit) => (Exit.isFailure(exit) ? rollback(spawner, worktree) : Effect.void),
    );
  });

  return {
    validate: (options) => validate(spawner, options),
    create,
  };
});
