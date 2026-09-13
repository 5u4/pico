import { GitError, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import type {
  ChatWorktreeOptions,
  CreateWorktree,
  CreateWorktreeOptions,
  GitWorktree,
  RemoveChatWorktreeOptions,
  RemoveChatWorktreeResult,
  RenameChatBranchOptions,
  RenameChatBranchResult,
  ValidateWorktreeOptions,
  WorktreeInspection,
} from "@pico/contract/worktree";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export const BRANCH_ID_SUFFIX_LENGTH = 8;

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

interface RepositoryLock {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
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

const gitError = (action: string, reason: string) =>
  new GitError({ message: `Failed to ${action}: ${reason}` });

const platformFailure = (action: string, phase: string, error: PlatformError.PlatformError) =>
  gitError(action, `${phase} failed (${error.reason._tag})`);

const runGitResult = Effect.fn("GitWorktree.runGitResult")(function* (
  spawner: Spawner,
  repositoryCwd: AbsolutePath,
  action: string,
  args: ReadonlyArray<string>,
  options?: ChildProcess.CommandOptions,
): Effect.fn.Return<GitResult, GitError> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(ChildProcess.make("git", args, { ...options, cwd: repositoryCwd }))
        .pipe(Effect.mapError((error) => platformFailure(action, "spawn", error)));
      return yield* Effect.all(
        {
          output: handle.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (output, chunk) => output + chunk,
            ),
            Effect.mapError((error) => platformFailure(action, "read stdout", error)),
          ),
          errors: Stream.runDrain(handle.stderr).pipe(
            Effect.mapError((error) => platformFailure(action, "drain stderr", error)),
          ),
          exitCode: handle.exitCode.pipe(
            Effect.mapError((error) => platformFailure(action, "wait for exit", error)),
          ),
        },
        { concurrency: "unbounded" },
      );
    }),
  );
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
  const { exitCode } = yield* runGitResult(spawner, repositoryCwd, action, args);
  if (exitCode !== 0) return yield* gitError(action, `Git exited with code ${exitCode}`);
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
  if (
    !(yield* fileSystem
      .exists(slot)
      .pipe(Effect.mapError((error) => platformFailure("inspect worktree path", "exists", error))))
  ) {
    return { kind: "managed", state: "absent" };
  }

  const isSymlink = yield* fileSystem.readLink(slot).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      isNotSymlink(error)
        ? Effect.succeed(false)
        : Effect.fail(platformFailure("inspect worktree path", "read link", error)),
    ),
  );
  if (isSymlink)
    return yield* gitError("inspect worktree path", "unsafe managed path is a symlink");
  const info = yield* fileSystem
    .stat(slot)
    .pipe(Effect.mapError((error) => platformFailure("inspect worktree path", "stat", error)));
  if (info.type !== "Directory") {
    return yield* gitError("inspect worktree path", "unsafe managed path is not a directory");
  }

  const identity = yield* runGitResult(spawner, AbsolutePath.make(slot), "inspect worktree", [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (identity.exitCode !== 0) {
    return yield* gitError("inspect worktree", `Git exited with code ${identity.exitCode}`);
  }
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
    return yield* gitError("inspect worktree", "invalid managed worktree identity");
  }

  const status = yield* runGitResult(spawner, AbsolutePath.make(slot), "inspect worktree changes", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.exitCode !== 0) {
    return yield* gitError("inspect worktree changes", `Git exited with code ${status.exitCode}`);
  }
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

type SymbolicHead =
  | { readonly kind: "branch"; readonly branch: string }
  | { readonly kind: "detached" };

const symbolicHead = Effect.fn("GitWorktree.symbolicHead")(function* (
  spawner: Spawner,
  cwd: AbsolutePath,
): Effect.fn.Return<SymbolicHead, GitError> {
  const result = yield* runGitResult(spawner, cwd, "inspect worktree branch", [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (result.exitCode === 1) return { kind: "detached" };
  const branch = result.output.trim();
  if (result.exitCode !== 0) {
    return yield* gitError("inspect worktree branch", `Git exited with code ${result.exitCode}`);
  }
  if (branch.length === 0) {
    return yield* gitError("inspect worktree branch", "empty symbolic HEAD");
  }
  return { kind: "branch", branch };
});

const localBranchExists = Effect.fn("GitWorktree.localBranchExists")(function* (
  spawner: Spawner,
  cwd: AbsolutePath,
  branch: string,
) {
  const result = yield* runGitResult(spawner, cwd, "inspect local branch", [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  return yield* gitError("inspect local branch", `Git exited with code ${result.exitCode}`);
});

const remoteCommandOptions: ChildProcess.CommandOptions = {
  env: { GIT_TERMINAL_PROMPT: "0" },
  extendEnv: true,
  stdin: "ignore",
  killSignal: "SIGKILL",
};

const hasRemoteState = Effect.fn("GitWorktree.hasRemoteState")(
  function* (spawner: Spawner, cwd: AbsolutePath, source: string, target: string) {
    const remotes = yield* runGitResult(
      spawner,
      cwd,
      "inspect remotes",
      ["remote"],
      remoteCommandOptions,
    );
    if (remotes.exitCode !== 0) {
      return yield* gitError("inspect remotes", `Git exited with code ${remotes.exitCode}`);
    }

    const endpoints = new Set<string>();
    for (const remote of remotes.output.trim().split("\n")) {
      if (remote.length === 0) continue;
      for (const args of [
        ["remote", "get-url", "--all", "--", remote],
        ["remote", "get-url", "--push", "--all", "--", remote],
      ]) {
        const urls = yield* runGitResult(
          spawner,
          cwd,
          "inspect remote endpoints",
          args,
          remoteCommandOptions,
        );
        if (urls.exitCode !== 0) {
          return yield* gitError(
            "inspect remote endpoints",
            `Git exited with code ${urls.exitCode}`,
          );
        }
        for (const url of urls.output.replace(/\n$/, "").split("\n")) {
          if (url.length === 0) {
            return yield* gitError("inspect remote endpoints", "empty remote endpoint");
          }
          endpoints.add(url);
        }
      }
    }

    const sourceRef = `refs/heads/${source}`;
    const targetRef = `refs/heads/${target}`;
    for (const endpoint of endpoints) {
      const result = yield* runGitResult(
        spawner,
        cwd,
        "inspect remote branches",
        ["ls-remote", "--quiet", "--refs", "--exit-code", "--", endpoint, sourceRef, targetRef],
        remoteCommandOptions,
      );
      if (result.exitCode === 2) continue;
      if (result.exitCode !== 0) {
        return yield* gitError(
          "inspect remote branches",
          `Git exited with code ${result.exitCode}`,
        );
      }
      for (const line of result.output.split("\n")) {
        const separator = line.indexOf("\t");
        if (separator === -1) continue;
        const ref = line.slice(separator + 1);
        if (ref === sourceRef || ref === targetRef) return true;
      }
    }
    return false;
  },
  Effect.timeoutOrElse({
    duration: "10 seconds",
    orElse: () =>
      Effect.fail(
        gitError("inspect remote branches", "remote inspection timed out after 10 seconds"),
      ),
  }),
);

const renameChatBranch = Effect.fn("GitWorktree.renameChatBranch")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  spawner: Spawner,
  renameLocks: Map<AbsolutePath, RepositoryLock>,
  worktreesDir: AbsolutePath,
  options: RenameChatBranchOptions,
): Effect.fn.Return<RenameChatBranchResult, GitError> {
  const inspection = yield* inspectManaged(fileSystem, path, spawner, worktreesDir, options);
  if (inspection.kind === "not-managed") {
    return { kind: "skipped", reason: "not-managed" };
  }
  if (inspection.state === "absent") {
    return { kind: "skipped", reason: "already-absent" };
  }
  const commonDir = inspection.commonDir;
  return yield* withRepositoryLock(
    renameLocks,
    commonDir,
    Effect.gen(function* (): Effect.fn.Return<RenameChatBranchResult, GitError> {
      const target = `${options.prefix}${options.topic}-${options.chatId.slice(-BRANCH_ID_SUFFIX_LENGTH)}`;
      const source = `${options.prefix}${options.chatId}`;
      if (
        !(yield* runGitExit(spawner, options.cwd, "validate worktree branch", [
          "check-ref-format",
          "--branch",
          target,
        ]))
      ) {
        return { kind: "skipped", reason: "invalid-target" };
      }

      const head = yield* symbolicHead(spawner, options.cwd);
      if (head.kind === "detached") return { kind: "skipped", reason: "detached" };
      if (head.branch === target) return { kind: "already-renamed" };
      if (head.branch !== source) return { kind: "skipped", reason: "branch-changed" };
      if (yield* hasRemoteState(spawner, options.cwd, source, target)) {
        return { kind: "skipped", reason: "remote-state" };
      }
      const targetExists = yield* localBranchExists(spawner, options.cwd, target);
      const currentHead = yield* symbolicHead(spawner, options.cwd);
      if (currentHead.kind === "detached") return { kind: "skipped", reason: "detached" };
      if (currentHead.branch === target) return { kind: "already-renamed" };
      if (currentHead.branch !== source) return { kind: "skipped", reason: "branch-changed" };
      if (targetExists) {
        return { kind: "skipped", reason: "target-exists" };
      }

      const { exitCode } = yield* runGitResult(spawner, options.cwd, "rename worktree branch", [
        "branch",
        "-m",
        "--",
        source,
        target,
      ]);
      if (exitCode === 0) return { kind: "renamed" };

      const afterFailure = yield* symbolicHead(spawner, options.cwd).pipe(
        Effect.mapError((error) =>
          gitError(
            "rename worktree branch",
            `Git exited with code ${exitCode}; reinspection failed: ${error.message}`,
          ),
        ),
      );
      if (afterFailure.kind === "detached") return { kind: "skipped", reason: "detached" };
      if (afterFailure.branch === target) {
        return { kind: "already-renamed" };
      }
      if (afterFailure.branch !== source) {
        return { kind: "skipped", reason: "branch-changed" };
      }
      return yield* gitError("rename worktree branch", `Git exited with code ${exitCode}`);
    }),
  );
});

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
  const { exitCode } = yield* runGitResult(spawner, worktreesDir, "remove worktree", args);
  if (exitCode === 0) {
    yield* Effect.logDebug("Worktree removed").pipe(
      Effect.annotateLogs({
        component: "git",
        operation: "removeChat",
        chatId: options.chatId,
        force: options.force,
        outcome: "removed",
      }),
    );
    return { kind: "removed" };
  }

  const afterFailure = yield* inspectManaged(fileSystem, path, spawner, worktreesDir, options).pipe(
    Effect.mapError((error) =>
      gitError(
        "remove worktree",
        `Git exited with code ${exitCode}; reinspection failed: ${error.message}`,
      ),
    ),
  );
  if (afterFailure.kind === "managed" && afterFailure.state === "absent") {
    return { kind: "already-absent" };
  }
  if (!options.force && afterFailure.kind === "managed") {
    return { kind: "force-required" };
  }
  return yield* gitError("remove worktree", `Git exited with code ${exitCode}`);
});

const withRepositoryLock = <A, E, R>(
  locks: Map<AbsolutePath, RepositoryLock>,
  commonDir: AbsolutePath,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const existing = locks.get(commonDir);
      if (existing !== undefined) {
        existing.users += 1;
        return existing;
      }
      const created: RepositoryLock = { semaphore: Semaphore.makeUnsafe(1), users: 1 };
      locks.set(commonDir, created);
      return created;
    }),
    (entry) => entry.semaphore.withPermit(effect),
    (entry) =>
      Effect.sync(() => {
        entry.users -= 1;
        if (entry.users === 0 && locks.get(commonDir) === entry) locks.delete(commonDir);
      }),
  );

const matchRefspec = (pattern: string, ref: string): string | undefined => {
  const wildcard = pattern.indexOf("*");
  if (wildcard === -1) return pattern === ref ? "" : undefined;
  const prefix = pattern.slice(0, wildcard);
  const suffix = pattern.slice(wildcard + 1);
  if (
    ref.length < prefix.length + suffix.length ||
    !ref.startsWith(prefix) ||
    !ref.endsWith(suffix)
  ) {
    return undefined;
  }
  return ref.slice(prefix.length, ref.length - suffix.length);
};

const fetchOwnership = (
  refspecs: ReadonlyArray<string>,
  ref: string,
): "owner" | "not-owner" | "unknown" => {
  const exclusions = refspecs
    .filter((refspec) => refspec.startsWith("^"))
    .map((refspec) => (refspec === "^@" ? "HEAD" : refspec.slice(1)));
  let unresolved = false;
  for (const refspec of refspecs) {
    if (refspec.startsWith("^")) continue;
    const separator = refspec.indexOf(":");
    if (separator === -1) continue;
    const destination = refspec.slice(separator + 1);
    const fullDestination =
      !destination.includes("*") && destination.startsWith("remotes/")
        ? `refs/${destination}`
        : destination;
    const matched = matchRefspec(fullDestination, ref);
    if (matched === undefined) continue;
    const configuredSource = refspec
      .slice(refspec.startsWith("+") ? 1 : 0, separator)
      .replace("*", () => matched);
    const source = configuredSource === "" || configuredSource === "@" ? "HEAD" : configuredSource;
    // Abbreviated sources need remote refs to resolve before exclusions can be checked.
    if (exclusions.length > 0 && source !== "HEAD" && !source.startsWith("refs/")) {
      unresolved = true;
      continue;
    }
    if (!exclusions.some((exclusion) => matchRefspec(exclusion, source) !== undefined)) {
      return "owner";
    }
  }
  return unresolved ? "unknown" : "not-owner";
};

const prepareBase = Effect.fn("GitWorktree.create.prepareBase")(function* (
  fileSystem: FileSystem.FileSystem,
  spawner: Spawner,
  fetchLocks: Map<AbsolutePath, RepositoryLock>,
  repositoryCwd: AbsolutePath,
  base: string,
) {
  // Git otherwise omits the resolved ref when a local branch shadows a remote-tracking ref.
  const resolved = yield* runGitResult(spawner, repositoryCwd, "resolve worktree base", [
    "-c",
    "core.warnAmbiguousRefs=false",
    "rev-parse",
    "--verify",
    "--symbolic-full-name",
    "--end-of-options",
    base,
  ]);
  if (resolved.exitCode !== 0) {
    return yield* gitError("resolve worktree base", `Git exited with code ${resolved.exitCode}`);
  }
  const ref = resolved.output.trim();
  if (!ref.startsWith("refs/remotes/")) return ref || base;

  const remotes = yield* runGitResult(spawner, repositoryCwd, "inspect remotes", ["remote"]);
  if (remotes.exitCode !== 0) {
    return yield* gitError("inspect remotes", `Git exited with code ${remotes.exitCode}`);
  }
  let remote: string | undefined;
  for (const name of remotes.output.trim().split("\n")) {
    if (name.length === 0) continue;
    const configured = yield* runGitResult(spawner, repositoryCwd, "inspect fetch refspecs", [
      "config",
      "--null",
      "--get-all",
      `remote.${name}.fetch`,
    ]);
    if (configured.exitCode === 1) continue;
    if (configured.exitCode !== 0) {
      return yield* gitError(
        "inspect fetch refspecs",
        `Git exited with code ${configured.exitCode}`,
      );
    }
    const ownership = fetchOwnership(configured.output.split("\0"), ref);
    if (ownership === "unknown") {
      return yield* gitError("fetch worktree base", "fetch source cannot be resolved locally");
    }
    if (ownership === "not-owner") continue;
    if (remote !== undefined) {
      return yield* gitError(
        "fetch worktree base",
        "remote-tracking branch has multiple fetch remotes",
      );
    }
    remote = name;
  }
  if (remote === undefined) {
    return yield* gitError("fetch worktree base", "remote-tracking branch has no fetch remote");
  }
  const identity = yield* runGitResult(spawner, repositoryCwd, "inspect fetch repository", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (identity.exitCode !== 0) {
    return yield* gitError("inspect fetch repository", `Git exited with code ${identity.exitCode}`);
  }
  const commonDir = AbsolutePath.make(
    yield* fileSystem
      .realPath(identity.output.trim())
      .pipe(
        Effect.mapError((error) => platformFailure("inspect fetch repository", "real path", error)),
      ),
  );
  const fetched = yield* withRepositoryLock(
    fetchLocks,
    commonDir,
    runGitResult(
      spawner,
      repositoryCwd,
      "fetch worktree base",
      ["fetch", "--", remote],
      remoteCommandOptions,
    ),
  );
  if (fetched.exitCode !== 0) {
    return yield* gitError("fetch worktree base", `Git exited with code ${fetched.exitCode}`);
  }
  return ref;
});

const acquire = Effect.fn("GitWorktree.create.acquire")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  spawner: Spawner,
  worktreesDir: AbsolutePath,
  options: CreateWorktreeOptions,
  base: string,
) {
  const cwd = AbsolutePath.make(path.join(worktreesDir, options.chatId));
  const worktree: CreatedWorktree = {
    repositoryCwd: options.repositoryCwd,
    cwd,
    branch: options.settings.prefix + options.chatId,
  };

  yield* fileSystem
    .makeDirectory(worktreesDir, { recursive: true, mode: 0o700 })
    .pipe(
      Effect.mapError((error) => platformFailure("create worktrees directory", "mkdir", error)),
    );
  yield* runGit(spawner, worktree.repositoryCwd, "create worktree", [
    "worktree",
    "add",
    "--no-track",
    "-b",
    worktree.branch,
    "--",
    worktree.cwd,
    base,
  ]);
  yield* Effect.logDebug("Worktree acquired").pipe(
    Effect.annotateLogs({
      component: "git",
      operation: "create",
      chatId: options.chatId,
      phase: "acquire",
      outcome: "acquired",
    }),
  );

  return worktree;
});

const ignoreCleanupFailure = <R>(
  resource: "worktree" | "branch",
  effect: Effect.Effect<void, GitError, R>,
): Effect.Effect<boolean, never, R> =>
  effect.pipe(
    Effect.as(true),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(
          Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
        );
      }
      const safeCause = Cause.fromReasons(
        cause.reasons.map((reason) =>
          Cause.isDieReason(reason)
            ? Cause.makeDieReason(gitError(`roll back ${resource}`, "unexpected cleanup defect"))
            : reason,
        ),
      );
      return Effect.logError("Git rollback failed", safeCause).pipe(
        Effect.annotateLogs({ resource, outcome: "failed" }),
        Effect.as(false),
      );
    }),
  );

const rollback = Effect.fn("GitWorktree.create.rollback")(function* (
  spawner: Spawner,
  worktree: CreatedWorktree,
) {
  yield* Effect.logDebug("Worktree rollback started");
  const worktreeRemoved = yield* ignoreCleanupFailure(
    "worktree",
    runGit(spawner, worktree.repositoryCwd, "roll back worktree", [
      "worktree",
      "remove",
      "--force",
      "--",
      worktree.cwd,
    ]),
  );
  const branchRemoved = yield* ignoreCleanupFailure(
    "branch",
    runGit(spawner, worktree.repositoryCwd, "roll back branch", [
      "branch",
      "-D",
      "--",
      worktree.branch,
    ]),
  );
  if (worktreeRemoved && branchRemoved) {
    yield* Effect.logDebug("Worktree rollback completed").pipe(
      Effect.annotateLogs({ outcome: "rolled-back" }),
    );
  }
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
  // Linked worktrees share branch configuration and Git's temporary rename reflog.
  const renameLocks = new Map<AbsolutePath, RepositoryLock>();
  const fetchLocks = new Map<AbsolutePath, RepositoryLock>();

  const create: CreateWorktree = Effect.fn("GitWorktree.create")(function* <A, E>(
    options: CreateWorktreeOptions,
    use: (cwd: AbsolutePath) => Effect.Effect<A, E>,
  ): Effect.fn.Return<A, GitError | E> {
    const base = yield* prepareBase(
      fileSystem,
      spawner,
      fetchLocks,
      options.repositoryCwd,
      options.settings.branch,
    );
    return yield* Effect.acquireUseRelease(
      acquire(fileSystem, path, spawner, worktreesDir, options, base),
      (worktree) => use(worktree.cwd),
      (worktree, exit) =>
        Exit.isFailure(exit)
          ? rollback(spawner, worktree).pipe(Effect.annotateLogs({ phase: "rollback" }))
          : Effect.logDebug("Worktree retained").pipe(
              Effect.annotateLogs({ phase: "commit", outcome: "retained" }),
            ),
    ).pipe(Effect.annotateLogs({ component: "git", operation: "create", chatId: options.chatId }));
  });

  return {
    validate: (options) => validate(spawner, options),
    create,
    inspectChat: (options) => inspectChat(fileSystem, path, spawner, worktreesDir, options),
    renameChatBranch: (options) =>
      renameChatBranch(fileSystem, path, spawner, renameLocks, worktreesDir, options),
    removeChat: (options) => removeChat(fileSystem, path, spawner, worktreesDir, options),
  };
});
