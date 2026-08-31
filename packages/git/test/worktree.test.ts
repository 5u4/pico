import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import * as Chat from "@pico/contract/chat-model";
import { GitError, PersistenceError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import { create } from "@pico/git/worktree";
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

const options = (id: Chat.ChatId, repositoryCwd: AbsolutePath, worktreesDir: AbsolutePath) => ({
  chatId: id,
  repositoryCwd,
  worktreesDir,
  settings,
});

describe("GitWorktree.create", () => {
  it.effect("retains the worktree after commit succeeds", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const id = chatId(1);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const committed = {};

      const result = yield* create(options(id, repositoryCwd, worktreesDir), (createdCwd) =>
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
      const id = chatId(2);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const branch = `chat/${id}`;
      const primary = new PersistenceError({ message: "commit failed" });

      const error = yield* create(options(id, repositoryCwd, worktreesDir), (createdCwd) =>
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
      const id = chatId(3);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const branch = `chat/${id}`;
      let callbackRan = false;

      yield* git(repositoryCwd, ["branch", branch]);
      const error = yield* create(options(id, repositoryCwd, worktreesDir), () =>
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
