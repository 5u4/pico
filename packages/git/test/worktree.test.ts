import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import * as Chat from "@pico/contract/chat-model";
import { GitError, PersistenceError, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import { BRANCH_ID_SUFFIX_LENGTH, make } from "@pico/git/worktree";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const chatId = (value: number) =>
  Chat.ChatId.make(`018f47a0-0000-7000-8000-${value.toString().padStart(12, "0")}`);

const git = Effect.fn("GitWorktreeTest.git")(function* (
  cwd: AbsolutePath,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }));
  const result = yield* Effect.all(
    {
      output: handle.all.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (output, chunk) => output + chunk,
        ),
      ),
      exitCode: handle.exitCode,
    },
    { concurrency: "unbounded" },
  );
  assert.strictEqual(result.exitCode, 0, result.output);
  return result.output;
});

const makeRepository = Effect.fn("GitWorktreeTest.makeRepository")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "pico-git-",
  });
  const canonicalDirectory = yield* fileSystem.realPath(temporaryDirectory);
  const repositoryCwd = AbsolutePath.make(path.join(canonicalDirectory, "repository"));
  const worktreesDir = AbsolutePath.make(path.join(canonicalDirectory, "worktrees"));

  yield* fileSystem.makeDirectory(repositoryCwd);
  yield* git(repositoryCwd, ["init", "--initial-branch=main"]);
  yield* git(repositoryCwd, ["config", "user.email", "pico@example.invalid"]);
  yield* git(repositoryCwd, ["config", "user.name", "pico"]);
  yield* fileSystem.writeFileString(path.join(repositoryCwd, "README.md"), "pico\n");
  yield* git(repositoryCwd, ["add", "--", "README.md"]);
  yield* git(repositoryCwd, ["commit", "-m", "initial"]);

  return { repositoryCwd, worktreesDir };
});

const settings = { branch: "main", prefix: "chat/" };

const options = (id: Chat.ChatId, repositoryCwd: AbsolutePath) => ({
  chatId: id,
  repositoryCwd,
  settings,
});

const renameOptions = (id: Chat.ChatId, cwd: AbsolutePath, topic: string) => ({
  chatId: id,
  cwd,
  prefix: settings.prefix,
  topic,
});

const renamedBranch = (id: Chat.ChatId, topic: string) =>
  `${settings.prefix}${topic}-${id.slice(-BRANCH_ID_SUFFIX_LENGTH)}`;

describe("GitWorktree.create", () => {
  it.effect("retains the worktree after commit succeeds", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const { create } = yield* make(worktreesDir);
      const id = chatId(1);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const committed = {};

      const result = yield* create(options(id, repositoryCwd), (createdCwd) =>
        Effect.gen(function* () {
          assert.strictEqual(createdCwd, cwd);
          assert.isTrue(yield* fileSystem.exists(createdCwd));
          return committed;
        }),
      );

      assert.strictEqual(result, committed);
      assert.isTrue(yield* fileSystem.exists(cwd));
      assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), `chat/${id}`);
      assert.include(
        yield* git(repositoryCwd, ["worktree", "list", "--porcelain"]),
        `worktree ${cwd}`,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rolls back after commit fails without replacing its error", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const { create } = yield* make(worktreesDir);
      const id = chatId(2);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const branch = `chat/${id}`;
      const primary = new PersistenceError({ message: "commit failed" });

      const error = yield* create(options(id, repositoryCwd), (createdCwd) =>
        Effect.gen(function* () {
          assert.isTrue(yield* fileSystem.exists(createdCwd));
          return yield* primary;
        }),
      ).pipe(Effect.flip);

      assert.strictEqual(error, primary);
      assert.isFalse(yield* fileSystem.exists(cwd));
      assert.notInclude(
        yield* git(repositoryCwd, ["worktree", "list", "--porcelain"]),
        `worktree ${cwd}`,
      );
      assert.strictEqual((yield* git(repositoryCwd, ["branch", "--list", branch])).trim(), "");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("does not commit or delete existing state when acquisition fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const { create } = yield* make(worktreesDir);
      const id = chatId(3);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const branch = `chat/${id}`;
      let callbackRan = false;

      yield* git(repositoryCwd, ["branch", branch]);
      const error = yield* create(options(id, repositoryCwd), () =>
        Effect.sync(() => {
          callbackRan = true;
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, GitError);
      assert.isFalse(callbackRan);
      assert.isFalse(yield* fileSystem.exists(cwd));
      assert.strictEqual((yield* git(repositoryCwd, ["branch", "--list", branch])).trim(), branch);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("GitWorktree.validate", () => {
  it.effect("accepts a repository, commit-ish ref, and generated branch shape", () =>
    Effect.gen(function* () {
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const { validate } = yield* make(worktreesDir);

      const branches = yield* git(repositoryCwd, ["branch", "--list"]);
      const worktrees = yield* git(repositoryCwd, ["worktree", "list", "--porcelain"]);
      yield* validate({
        repositoryCwd: AbsolutePath.make(`${repositoryCwd}/.`),
        settings: { branch: "HEAD", prefix: "chat/" },
      });
      assert.strictEqual(yield* git(repositoryCwd, ["branch", "--list"]), branches);
      assert.strictEqual(yield* git(repositoryCwd, ["worktree", "list", "--porcelain"]), worktrees);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports expected repository, branch, and prefix validation failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const notRepository = AbsolutePath.make(path.join(worktreesDir, "not-repository"));
      yield* fileSystem.makeDirectory(notRepository, { recursive: true });
      const { validate } = yield* make(worktreesDir);

      for (const candidate of [
        {
          options: { repositoryCwd, settings: { branch: " main", prefix: "chat/" } },
          field: "branch",
          reason: "surrounding-whitespace",
        },
        {
          options: { repositoryCwd, settings: { branch: "main", prefix: "chat/ " } },
          field: "prefix",
          reason: "surrounding-whitespace",
        },
        {
          options: { repositoryCwd: notRepository, settings },
          field: "repository",
          reason: "not-repository",
        },
        {
          options: { repositoryCwd, settings: { branch: "--help", prefix: "chat/" } },
          field: "branch",
          reason: "not-commit",
        },
        {
          options: { repositoryCwd, settings: { branch: "main", prefix: "bad.." } },
          field: "prefix",
          reason: "invalid-ref",
        },
      ] as const) {
        const error = yield* validate(candidate.options).pipe(Effect.flip);
        assert.instanceOf(error, WorkspaceBindingInvalid);
        if (!(error instanceof WorkspaceBindingInvalid)) continue;
        assert.strictEqual(error.issue.field, candidate.field);
        assert.strictEqual(error.issue.reason, candidate.reason);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("keeps process spawn failure unexpected", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { worktreesDir } = yield* makeRepository();
      const { validate } = yield* make(worktreesDir);
      const missingRepository = AbsolutePath.make(path.join(worktreesDir, "missing"));

      assert.instanceOf(
        yield* validate({ repositoryCwd: missingRepository, settings }).pipe(Effect.flip),
        GitError,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("GitWorktree.renameChatBranch", () => {
  it.effect("renames the local branch once without moving the UUID worktree", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const worktree = yield* make(worktreesDir);
      const id = chatId(30);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const source = `chat/${id}`;
      const target = renamedBranch(id, "fix-parser-flow");
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);

      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(id, cwd, "fix-parser-flow")),
        { kind: "renamed" },
      );
      assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), target);
      assert.strictEqual((yield* git(repositoryCwd, ["branch", "--list", source])).trim(), "");
      yield* git(repositoryCwd, ["show-ref", "--verify", `refs/heads/${target}`]);
      assert.strictEqual((yield* fileSystem.realPath(cwd)).trim(), cwd);
      assert.include(
        yield* git(repositoryCwd, ["worktree", "list", "--porcelain"]),
        `worktree ${cwd}`,
      );

      const fresh = yield* make(worktreesDir);
      assert.deepStrictEqual(
        yield* fresh.renameChatBranch(renameOptions(id, cwd, "fix-parser-flow")),
        { kind: "already-renamed" },
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("renames an unpublished worktree branch created from origin/main", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      yield* git(repositoryCwd, ["remote", "add", "origin", repositoryCwd]);
      yield* git(repositoryCwd, ["fetch", "origin", "main"]);
      yield* git(repositoryCwd, ["config", "branch.autoSetupMerge", "true"]);
      const worktree = yield* make(worktreesDir);
      const id = chatId(33);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      yield* worktree.create(
        {
          chatId: id,
          repositoryCwd,
          settings: { ...settings, branch: "origin/main" },
        },
        () => Effect.void,
      );

      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(id, cwd, "remote-base-topic")),
        { kind: "renamed" },
      );
      assert.strictEqual(
        (yield* git(cwd, ["branch", "--show-current"])).trim(),
        renamedBranch(id, "remote-base-topic"),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("preserves user-renamed and detached worktrees", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const worktree = yield* make(worktreesDir);

      const renamedId = chatId(31);
      const renamedCwd = AbsolutePath.make(path.join(worktreesDir, renamedId));
      yield* worktree.create(options(renamedId, repositoryCwd), () => Effect.void);
      yield* git(renamedCwd, ["branch", "-m", "custom/user-choice"]);
      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(renamedId, renamedCwd, "generated-topic")),
        { kind: "skipped", reason: "branch-changed" },
      );
      assert.strictEqual(
        (yield* git(renamedCwd, ["branch", "--show-current"])).trim(),
        "custom/user-choice",
      );

      const detachedId = chatId(32);
      const detachedCwd = AbsolutePath.make(path.join(worktreesDir, detachedId));
      yield* worktree.create(options(detachedId, repositoryCwd), () => Effect.void);
      yield* git(detachedCwd, ["checkout", "--detach"]);
      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(detachedId, detachedCwd, "generated-topic")),
        { kind: "skipped", reason: "detached" },
      );
      assert.strictEqual((yield* git(detachedCwd, ["branch", "--show-current"])).trim(), "");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("refuses upstream, push, and remote-tracking state", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      for (const [index, state] of [
        "upstream",
        "push",
        "remote-source",
        "remote-target",
      ].entries()) {
        const { repositoryCwd, worktreesDir } = yield* makeRepository();
        const worktree = yield* make(worktreesDir);
        const id = chatId(40 + index);
        const cwd = AbsolutePath.make(path.join(worktreesDir, id));
        const source = `chat/${id}`;
        const target = renamedBranch(id, "known-remote-topic");
        yield* worktree.create(options(id, repositoryCwd), () => Effect.void);

        if (state === "upstream") {
          yield* git(cwd, ["branch", "--set-upstream-to=main", source]);
        } else if (state === "push") {
          yield* git(repositoryCwd, ["remote", "add", "origin", repositoryCwd]);
          yield* git(cwd, ["config", `branch.${source}.pushRemote`, "origin"]);
          yield* git(cwd, ["config", "push.default", "current"]);
        } else {
          const remoteBranch = state === "remote-source" ? source : target;
          yield* git(repositoryCwd, ["update-ref", `refs/remotes/origin/${remoteBranch}`, "HEAD"]);
        }

        assert.deepStrictEqual(
          yield* worktree.renameChatBranch(renameOptions(id, cwd, "known-remote-topic")),
          { kind: "skipped", reason: "remote-state" },
          state,
        );
        assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), source);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("refuses invalid and colliding targets without forcing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const worktree = yield* make(worktreesDir);
      const id = chatId(50);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const source = `chat/${id}`;
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);

      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(id, cwd, "bad..topic")),
        { kind: "skipped", reason: "invalid-target" },
      );
      const existingTarget = renamedBranch(id, "existing-topic");
      yield* git(repositoryCwd, ["branch", existingTarget, "main"]);
      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(id, cwd, "existing-topic")),
        { kind: "skipped", reason: "target-exists" },
      );
      assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), source);
      assert.strictEqual(
        (yield* git(repositoryCwd, ["branch", "--list", existingTarget])).trim(),
        existingTarget,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("converges concurrent same and different topic attempts", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const worktree = yield* make(worktreesDir);

      const sameId = chatId(60);
      const sameCwd = AbsolutePath.make(path.join(worktreesDir, sameId));
      yield* worktree.create(options(sameId, repositoryCwd), () => Effect.void);
      const sameResults = yield* Effect.all(
        [
          worktree.renameChatBranch(renameOptions(sameId, sameCwd, "same-topic")),
          worktree.renameChatBranch(renameOptions(sameId, sameCwd, "same-topic")),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(sameResults.map((result) => result.kind).sort(), [
        "already-renamed",
        "renamed",
      ]);
      assert.strictEqual(
        (yield* git(sameCwd, ["branch", "--show-current"])).trim(),
        renamedBranch(sameId, "same-topic"),
      );

      const differentId = chatId(61);
      const differentCwd = AbsolutePath.make(path.join(worktreesDir, differentId));
      yield* worktree.create(options(differentId, repositoryCwd), () => Effect.void);
      const differentResults = yield* Effect.all(
        [
          worktree.renameChatBranch(renameOptions(differentId, differentCwd, "first-topic")),
          worktree.renameChatBranch(renameOptions(differentId, differentCwd, "second-topic")),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(differentResults.filter((result) => result.kind === "renamed").length, 1);
      assert.strictEqual(
        differentResults.filter(
          (result) => result.kind === "skipped" && result.reason === "branch-changed",
        ).length,
        1,
      );
      assert.include(
        [renamedBranch(differentId, "first-topic"), renamedBranch(differentId, "second-topic")],
        (yield* git(differentCwd, ["branch", "--show-current"])).trim(),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
describe("GitWorktree chat cleanup", () => {
  it.effect("removes a clean managed worktree and preserves its branch", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const worktree = yield* make(worktreesDir);
      const id = chatId(20);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const branch = `chat/${id}`;
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);

      assert.deepStrictEqual(yield* worktree.inspectChat({ chatId: id, cwd }), {
        kind: "managed",
        state: "clean",
      });
      assert.deepStrictEqual(yield* worktree.removeChat({ chatId: id, cwd, force: false }), {
        kind: "removed",
      });
      assert.isFalse(yield* fileSystem.exists(cwd));
      assert.strictEqual((yield* git(repositoryCwd, ["branch", "--list", branch])).trim(), branch);
      assert.deepStrictEqual(yield* worktree.removeChat({ chatId: id, cwd, force: false }), {
        kind: "already-absent",
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("requires force for dirty worktrees and preserves the branch", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const worktree = yield* make(worktreesDir);
      const id = chatId(21);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const branch = `chat/${id}`;
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);
      yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "changed\n");
      yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "local\n");

      assert.deepStrictEqual(yield* worktree.inspectChat({ chatId: id, cwd }), {
        kind: "managed",
        state: "dirty",
      });
      assert.deepStrictEqual(yield* worktree.removeChat({ chatId: id, cwd, force: false }), {
        kind: "force-required",
      });
      assert.isTrue(yield* fileSystem.exists(cwd));
      assert.deepStrictEqual(yield* worktree.removeChat({ chatId: id, cwd, force: true }), {
        kind: "removed",
      });
      assert.isFalse(yield* fileSystem.exists(cwd));
      assert.strictEqual((yield* git(repositoryCwd, ["branch", "--list", branch])).trim(), branch);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("offers a force retry when Git rejects a clean worktree with a submodule", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const submoduleCwd = AbsolutePath.make(path.join(repositoryCwd, "..", "submodule"));
      yield* fileSystem.makeDirectory(submoduleCwd);
      yield* git(submoduleCwd, ["init", "--initial-branch=main"]);
      yield* git(submoduleCwd, ["config", "user.email", "pico@example.invalid"]);
      yield* git(submoduleCwd, ["config", "user.name", "pico"]);
      yield* fileSystem.writeFileString(path.join(submoduleCwd, "README.md"), "nested\n");
      yield* git(submoduleCwd, ["add", "--", "README.md"]);
      yield* git(submoduleCwd, ["commit", "-m", "initial"]);
      yield* git(repositoryCwd, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "--",
        submoduleCwd,
        "nested",
      ]);
      yield* git(repositoryCwd, ["commit", "-am", "add submodule"]);

      const worktree = yield* make(worktreesDir);
      const id = chatId(24);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const branch = `chat/${id}`;
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);
      yield* git(cwd, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "--recursive",
      ]);

      assert.deepStrictEqual(yield* worktree.inspectChat({ chatId: id, cwd }), {
        kind: "managed",
        state: "clean",
      });
      assert.deepStrictEqual(yield* worktree.removeChat({ chatId: id, cwd, force: false }), {
        kind: "force-required",
      });
      assert.isTrue(yield* fileSystem.exists(cwd));
      assert.deepStrictEqual(yield* worktree.removeChat({ chatId: id, cwd, force: true }), {
        kind: "removed",
      });
      assert.isFalse(yield* fileSystem.exists(cwd));
      assert.strictEqual((yield* git(repositoryCwd, ["branch", "--list", branch])).trim(), branch);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects an unregistered exact slot without deleting it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { worktreesDir } = yield* makeRepository();
      const worktree = yield* make(worktreesDir);
      const id = chatId(22);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "keep.txt"), "keep\n");

      assert.instanceOf(
        yield* worktree.inspectChat({ chatId: id, cwd }).pipe(Effect.flip),
        GitError,
      );
      assert.isTrue(yield* fileSystem.exists(path.join(cwd, "keep.txt")));
    }).pipe(Effect.provide(BunServices.layer)),
  );
  it.effect("never follows an exact-slot symlink", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const worktree = yield* make(worktreesDir);
      const id = chatId(23);
      const target = AbsolutePath.make(path.join(worktreesDir, "outside-slot"));
      const slot = AbsolutePath.make(path.join(worktreesDir, id));
      yield* git(repositoryCwd, ["worktree", "add", "-b", `chat/${id}`, "--", target, "main"]);
      yield* fileSystem.symlink(target, slot);

      assert.instanceOf(
        yield* worktree.removeChat({ chatId: id, cwd: slot, force: true }).pipe(Effect.flip),
        GitError,
      );
      assert.isTrue(yield* fileSystem.exists(path.join(target, "README.md")));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
