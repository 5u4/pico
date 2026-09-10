import { GitError, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import type {
  ChatWorktreeOptions,
  CreateWorktree,
  CreateWorktreeOptions,
  GitWorktree,
  RemoveChatWorktreeOptions,
  RemoveChatWorktreeResult,
  ValidateWorktreeOptions,
  WorktreeInspection,
} from "@pico/contract/worktree";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

interface CreatedWorktree {
  readonly repositoryCwd: AbsolutePath;
  readonly cwd: AbsolutePath;
  readonly branch: string;
}

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

interface GitResult {
  readonly exitCode: number;
  readonly output: string;
}

type ManagedWorktreeInspection =
  | { readonly kind: "not-managed" }
  | { readonly kind: "managed"; readonly state: "absent" }
  | {
      readonly kind: "managed";
      readonly state: "clean" | "dirty";
      readonly commonDir: AbsolutePath;
    };

const validationError = (issue: WorkspaceBindingInvalid["issue"]) =>
  new WorkspaceBindingInvalid({ issue });

const gitError = (action: string) => new GitError({ message: `Failed to ${action}` });

const runGitResult = Effect.fn("GitWorktree.runGitResult")(function* (
  spawner: Spawner,
  repositoryCwd: AbsolutePath,
  action: string,
  args: ReadonlyArray<string>,
): Effect.fn.Return<GitResult, GitError> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: repositoryCwd }));
      return yield* Effect.all(
        {
          output: handle.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (output, chunk) => output + chunk,
            ),
          ),
          errors: Stream.runDrain(handle.stderr),
          exitCode: handle.exitCode,
        },
        { concurrency: "unbounded" },
      );
    }),
  ).pipe(Effect.mapError(() => gitError(action)));
});

const runGitExit = Effect.fn("GitWorktree.runGitExit")(function* (
  spawner: Spawner,
  repositoryCwd: AbsolutePath,
  action: string,
  args: ReadonlyArray<string>,
) {
  return (yield* runGitResult(spawner, repositoryCwd, action, args)).exitCode === 0;
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

const isNotSymlink = (error: PlatformError.PlatformError) => {
  const cause = "cause" in error.reason ? error.reason.cause : undefined;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
};

const inspectManaged = Effect.fn("GitWorktree.inspectChat")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  spawner: Spawner,
  worktreesDir: AbsolutePath,
  options: ChatWorktreeOptions,
): Effect.fn.Return<ManagedWorktreeInspection, GitError> {
  const slot = path.normalize(path.join(worktreesDir, options.chatId));
  if (path.normalize(options.cwd) !== slot) return { kind: "not-managed" };
  if (!(yield* fileSystem.exists(slot))) return { kind: "managed", state: "absent" };

  const isSymlink = yield* fileSystem.readLink(slot).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      isNotSymlink(error) ? Effect.succeed(false) : Effect.fail(gitError("inspect worktree path")),
    ),
  );
  if (isSymlink) return yield* gitError("inspect worktree path");
  const info = yield* fileSystem
    .stat(slot)
    .pipe(Effect.mapError(() => gitError("inspect worktree path")));
  if (info.type !== "Directory") return yield* gitError("inspect worktree path");

  const identity = yield* runGitResult(spawner, AbsolutePath.make(slot), "inspect worktree", [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (identity.exitCode !== 0) return yield* gitError("inspect worktree");
  const [topLevel, gitDir, commonDir] = identity.output
    .trim()
    .split("\n")
    .map((line) => path.normalize(line.trim()));
  if (
    topLevel === undefined ||
    gitDir === undefined ||
    commonDir === undefined ||
    topLevel !== slot ||
    gitDir === commonDir
  ) {
    return yield* gitError("inspect worktree");
  }

  const status = yield* runGitResult(spawner, AbsolutePath.make(slot), "inspect worktree changes", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.exitCode !== 0) return yield* gitError("inspect worktree changes");
  return {
    kind: "managed",
    state: status.output.length === 0 ? "clean" : "dirty",
    commonDir: AbsolutePath.make(commonDir),
  };
});

const inspectChat = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  spawner: Spawner,
  worktreesDir: AbsolutePath,
  options: ChatWorktreeOptions,
): Effect.Effect<WorktreeInspection, GitError> =>
  inspectManaged(fileSystem, path, spawner, worktreesDir, options).pipe(
    Effect.map((inspection) =>
      inspection.kind === "not-managed" || inspection.state === "absent"
        ? inspection
        : { kind: "managed", state: inspection.state },
    ),
  );

const removeChat = Effect.fn("GitWorktree.removeChat")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  spawner: Spawner,
  worktreesDir: AbsolutePath,
  options: RemoveChatWorktreeOptions,
): Effect.fn.Return<RemoveChatWorktreeResult, GitError> {
  const inspection = yield* inspectManaged(fileSystem, path, spawner, worktreesDir, options);
  if (inspection.kind === "not-managed") return { kind: "not-managed" };
  if (inspection.state === "absent") return { kind: "already-absent" };
  if (inspection.state === "dirty" && !options.force) {
    return { kind: "force-required" };
  }

  const args = [
    "--git-dir",
    inspection.commonDir,
    "worktree",
    "remove",
    ...(options.force ? ["--force"] : []),
    "--",
    path.normalize(options.cwd),
  ];
  if (yield* runGitExit(spawner, worktreesDir, "remove worktree", args)) {
    return { kind: "removed" };
  }

  const afterFailure = yield* inspectManaged(fileSystem, path, spawner, worktreesDir, options);
  if (afterFailure.kind === "managed" && afterFailure.state === "absent") {
    return { kind: "already-absent" };
  }
  if (!options.force && afterFailure.kind === "managed" && afterFailure.state !== "absent") {
    return { kind: "force-required" };
  }
  return yield* gitError("remove worktree");
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
    inspectChat: (options) => inspectChat(fileSystem, path, spawner, worktreesDir, options),
    removeChat: (options) => removeChat(fileSystem, path, spawner, worktreesDir, options),
  };
});
