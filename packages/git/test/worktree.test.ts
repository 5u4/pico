import { createServer, type Socket } from "node:net";
import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import * as Chat from "@pico/contract/chat-model";
import { GitError, PersistenceError, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import { BRANCH_ID_SUFFIX_LENGTH, make } from "@pico/git/worktree";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
  yield* git(repositoryCwd, ["init", "--initial-branch=main", "--template="]);
  yield* git(repositoryCwd, ["config", "user.email", "pico@example.invalid"]);
  yield* git(repositoryCwd, ["config", "user.name", "pico"]);
  yield* git(repositoryCwd, ["config", "commit.gpgsign", "false"]);
  yield* git(repositoryCwd, ["config", "core.hooksPath", "/dev/null"]);
  yield* git(repositoryCwd, ["config", "protocol.file.allow", "always"]);
  yield* git(repositoryCwd, ["config", "push.autoSetupRemote", "false"]);
  yield* fileSystem.writeFileString(path.join(repositoryCwd, "README.md"), "pico\n");
  yield* git(repositoryCwd, ["add", "--", "README.md"]);
  yield* git(repositoryCwd, ["commit", "-m", "initial"]);

  return { repositoryCwd, worktreesDir };
});

const makeRemote = Effect.fn("GitWorktreeTest.makeRemote")(function* (
  repositoryCwd: AbsolutePath,
  name: string,
) {
  const path = yield* Path.Path;
  const remoteCwd = AbsolutePath.make(path.join(repositoryCwd, "..", `${name}.git`));
  yield* git(repositoryCwd, ["init", "--bare", "--initial-branch=main", "--template=", remoteCwd]);
  yield* git(remoteCwd, ["config", "core.hooksPath", "/dev/null"]);
  yield* git(remoteCwd, [
    "-c",
    "protocol.file.allow=always",
    "fetch",
    "--no-tags",
    repositoryCwd,
    "refs/heads/main:refs/heads/main",
  ]);
  return remoteCwd;
});

const makeHangingTransport = Effect.fn("GitWorktreeTest.makeHangingTransport")(function* (
  identity: AbsolutePath,
) {
  const ready = yield* Deferred.make<number, unknown>();
  const sockets = new Set<Socket>();
  let helperPid: number | undefined;
  const decodeHandshake = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        identity: Schema.Literal(identity),
        pid: Schema.Int.check(Schema.isGreaterThan(1)),
      }),
    ),
  );
  const server = createServer((socket) => {
    if (closing !== undefined) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", (error) => Deferred.doneUnsafe(ready, Effect.fail(error)));
    socket.setEncoding("utf8");
    let message = "";
    const onData = (chunk: string) => {
      message += chunk;
      const newline = message.indexOf("\n");
      if (newline === -1) return;
      socket.off("data", onData);
      try {
        helperPid = decodeHandshake(message.slice(0, newline)).pid;
        Deferred.doneUnsafe(ready, Effect.succeed(helperPid));
      } catch (error) {
        Deferred.doneUnsafe(ready, Effect.fail(error));
      }
    };
    socket.on("data", onData);
  });
  let closing: Promise<void> | undefined;
  const close = Effect.promise(
    () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      })),
  ).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        helperPid === undefined ? Effect.void : awaitHelperExit(helperPid, identity),
      ),
    ),
    Effect.orDie,
  );
  yield* Effect.addFinalizer(() => close);
  yield* Effect.tryPromise(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    return yield* Effect.die(new Error("Transport control listener has no TCP port"));
  }
  const fixture = Bun.fileURLToPath(new URL("./hanging-transport.fixture.ts", import.meta.url));
  const command = [process.execPath, fixture, String(address.port), identity]
    .map((argument) => argument.replaceAll("%", "%%").replaceAll(" ", "% "))
    .join(" ");
  return { endpoint: `ext::${command}`, ready: Deferred.await(ready), close };
});

const helperIsRunning = Effect.fn("GitWorktreeTest.helperIsRunning")(function* (
  pid: number,
  identity: AbsolutePath,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make("ps", ["-ww", "-p", String(pid), "-o", "stat=", "-o", "args="]),
  );
  const output = yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => output + chunk,
    ),
  );
  const exitCode = yield* handle.exitCode;
  if (exitCode === 1 && output.trim() === "") return false;
  assert.strictEqual(exitCode, 0, output);
  return !output.trimStart().startsWith("Z") && output.includes(identity);
}, Effect.scoped);

const awaitHelperExit = (pid: number, identity: AbsolutePath) =>
  helperIsRunning(pid, identity).pipe(
    Effect.repeat({ while: (running) => running, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("2 seconds"),
    TestClock.withLive,
  );

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
  for (const { remote, base, unrelated, refspec } of [
    {
      remote: "origin",
      base: "origin/main",
      unrelated: "backup",
      refspec: "+refs/heads/*:refs/remotes/origin/*",
    },
    {
      remote: "upstream",
      base: "refs/remotes/upstream/main",
      unrelated: "origin",
      refspec: "+refs/heads/*:refs/remotes/upstream/*",
    },
    {
      remote: "team/upstream",
      base: "team/upstream/main",
      unrelated: "origin",
      refspec: "+refs/heads/*:refs/remotes/team/upstream/*",
    },
    {
      remote: "origin",
      base: "refs/remotes/cache/mirror-main",
      unrelated: "backup",
      refspec: "+refs/heads/*:refs/remotes/cache/mirror-*",
    },
    {
      remote: "origin",
      base: "refs/remotes/cache/release",
      unrelated: "backup",
      refspec: "refs/heads/main:remotes/cache/release",
    },
  ]) {
    it.effect(`fetches ${remote} once before creating from stale ${base}`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repositoryCwd, worktreesDir } = yield* makeRepository();
        const remoteCwd = yield* makeRemote(repositoryCwd, "remote");
        yield* git(repositoryCwd, ["remote", "add", remote, remoteCwd]);
        yield* git(repositoryCwd, ["config", `remote.${remote}.fetch`, refspec]);
        yield* git(repositoryCwd, [
          "remote",
          "add",
          unrelated,
          path.join(repositoryCwd, "missing.git"),
        ]);
        yield* git(repositoryCwd, ["config", "--add", `remote.${unrelated}.fetch`, refspec]);
        yield* git(repositoryCwd, [
          "config",
          "--add",
          `remote.${unrelated}.fetch`,
          "^refs/heads/main",
        ]);
        yield* git(repositoryCwd, ["fetch", remote]);
        const ref = base.startsWith("refs/") ? base : `refs/remotes/${base}`;
        const stale = (yield* git(repositoryCwd, ["rev-parse", ref])).trim();
        yield* git(repositoryCwd, ["commit", "--allow-empty", "-m", "remote update"]);
        const latest = (yield* git(repositoryCwd, ["rev-parse", "HEAD"])).trim();
        yield* git(remoteCwd, [
          "-c",
          "protocol.file.allow=always",
          "fetch",
          repositoryCwd,
          "refs/heads/main:refs/heads/main",
        ]);
        assert.notStrictEqual(stale, latest);
        assert.strictEqual((yield* git(repositoryCwd, ["rev-parse", ref])).trim(), stale);
        const uploadPack = path.join(repositoryCwd, "..", "upload-pack");
        yield* fileSystem.writeFileString(
          uploadPack,
          '#!/bin/sh\nprintf "fetch\\n" >> "$0.log"\nexec git-upload-pack "$@"\n',
        );
        yield* fileSystem.chmod(uploadPack, 0o700);
        yield* git(repositoryCwd, ["config", `remote.${remote}.uploadpack`, `"${uploadPack}"`]);
        const { create } = yield* make(worktreesDir);
        const cwd = yield* create(
          { ...options(chatId(6), repositoryCwd), settings: { ...settings, branch: base } },
          Effect.succeed,
        );

        assert.strictEqual((yield* git(cwd, ["rev-parse", "HEAD"])).trim(), latest);
        assert.strictEqual(yield* fileSystem.readFileString(`${uploadPack}.log`), "fetch\n");
      }).pipe(Effect.provide(BunServices.layer)),
    );
  }

  for (const { name, mapping, branch, exclusions, competing } of [
    {
      name: "unmapped",
      mapping: "+refs/heads/*:refs/remotes/cache/*",
      branch: "origin/main",
      exclusions: [],
      competing: false,
    },
    {
      name: "excluded exact source",
      mapping: "+refs/heads/*:refs/remotes/origin/*",
      branch: "origin/main",
      exclusions: ["^refs/heads/main"],
      competing: false,
    },
    {
      name: "excluded HEAD alias",
      mapping: "HEAD:refs/remotes/cache/default",
      branch: "cache/default",
      exclusions: ["^@"],
      competing: false,
    },
    {
      name: "excluded abbreviated source",
      mapping: "main:refs/remotes/origin/main",
      branch: "origin/main",
      exclusions: ["^refs/heads/main"],
      competing: false,
    },
    {
      name: "excluded wildcard source",
      mapping: "+refs/heads/*:refs/remotes/origin/mirror-*",
      branch: "origin/mirror-main",
      exclusions: ["^refs/heads/ma*"],
      competing: false,
    },
    {
      name: "ambiguous fetch ownership",
      mapping: "+refs/heads/*:refs/remotes/origin/*",
      branch: "origin/main",
      exclusions: [],
      competing: true,
    },
  ]) {
    it.effect(`rejects ${name} before fetching or acquiring a worktree`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repositoryCwd, worktreesDir } = yield* makeRepository();
        const remoteCwd = yield* makeRemote(repositoryCwd, "origin");
        yield* git(repositoryCwd, ["remote", "add", "origin", remoteCwd]);
        yield* git(repositoryCwd, ["fetch", "origin"]);
        yield* git(repositoryCwd, ["update-ref", `refs/remotes/${branch}`, "HEAD"]);
        yield* git(repositoryCwd, ["config", "remote.origin.fetch", mapping]);
        for (const exclusion of exclusions) {
          yield* git(repositoryCwd, ["config", "--add", "remote.origin.fetch", exclusion]);
        }
        if (competing) {
          yield* git(repositoryCwd, ["remote", "add", "upstream", remoteCwd]);
          yield* git(repositoryCwd, ["config", "remote.upstream.fetch", mapping]);
        }
        const uploadPack = path.join(repositoryCwd, "..", "upload-pack");
        yield* fileSystem.writeFileString(
          uploadPack,
          '#!/bin/sh\nprintf "fetch\\n" >> "$0.log"\nexec git-upload-pack "$@"\n',
        );
        yield* fileSystem.chmod(uploadPack, 0o700);
        yield* git(repositoryCwd, ["config", "remote.origin.uploadpack", `"${uploadPack}"`]);
        const before = yield* git(repositoryCwd, ["worktree", "list", "--porcelain"]);
        const { create } = yield* make(worktreesDir);
        const id = chatId(9);
        let callbackRan = false;
        const error = yield* create(
          { ...options(id, repositoryCwd), settings: { ...settings, branch } },
          () =>
            Effect.sync(() => {
              callbackRan = true;
            }),
        ).pipe(Effect.flip);

        assert.instanceOf(error, GitError);
        assert.isFalse(callbackRan);
        assert.isFalse(yield* fileSystem.exists(`${uploadPack}.log`));
        assert.isFalse(yield* fileSystem.exists(worktreesDir));
        assert.strictEqual(yield* git(repositoryCwd, ["worktree", "list", "--porcelain"]), before);
        assert.strictEqual(
          (yield* git(repositoryCwd, ["branch", "--list", `chat/${id}`])).trim(),
          "",
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );
  }

  it.effect(
    "serializes shared-repository fetches without blocking local bases or independent repositories",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { repositoryCwd, worktreesDir } = yield* makeRepository();
        const { repositoryCwd: independentRepositoryCwd } = yield* makeRepository();
        for (const cwd of [repositoryCwd, independentRepositoryCwd]) {
          const remoteCwd = yield* makeRemote(cwd, "origin");
          yield* git(cwd, ["remote", "add", "origin", remoteCwd]);
          yield* git(cwd, ["fetch", "origin"]);
          yield* git(cwd, ["commit", "--allow-empty", "-m", "remote update"]);
          yield* git(remoteCwd, [
            "-c",
            "protocol.file.allow=always",
            "fetch",
            cwd,
            "refs/heads/main:refs/heads/main",
          ]);
        }
        const latest = (yield* git(repositoryCwd, ["rev-parse", "HEAD"])).trim();
        const stale = (yield* git(repositoryCwd, ["rev-parse", "origin/main"])).trim();
        const independentLatest = (yield* git(independentRepositoryCwd, [
          "rev-parse",
          "HEAD",
        ])).trim();
        const linkedCwd = AbsolutePath.make(path.join(repositoryCwd, "..", "linked"));
        const aliasCwd = AbsolutePath.make(path.join(repositoryCwd, "..", "linked-alias"));
        yield* git(repositoryCwd, ["worktree", "add", "--detach", linkedCwd, "HEAD"]);
        yield* fileSystem.symlink(linkedCwd, aliasCwd);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const operationFinished = yield* Queue.unbounded<void>();
        let activeOperations = 0;
        const completed = Effect.sync(() => {
          activeOperations -= 1;
          Queue.offerUnsafe(operationFinished, undefined);
        });
        const gatedSpawner = ChildProcessSpawner.make(
          Effect.fn("GitWorktreeTest.gatedFetch")(function* (command: ChildProcess.Command) {
            if (command._tag === "StandardCommand") {
              if (command.options.cwd === repositoryCwd && command.args[0] === "fetch") {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              if (command.options.cwd === aliasCwd) {
                activeOperations += 1;
                yield* Effect.addFinalizer(() => completed);
              }
            }
            return yield* spawner.spawn(command);
          }),
        );
        const trackedFileSystem: FileSystem.FileSystem = {
          ...fileSystem,
          realPath: (path) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                activeOperations += 1;
              }),
              () => fileSystem.realPath(path),
              () => completed,
            ),
        };
        const { create } = yield* make(worktreesDir).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, gatedSpawner),
          Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        );
        const remoteOptions = (id: number, cwd: AbsolutePath) => ({
          ...options(chatId(id), cwd),
          settings: { ...settings, branch: "origin/main" },
        });
        const first = yield* create(remoteOptions(10, repositoryCwd), Effect.succeed).pipe(
          Effect.forkScoped,
        );
        yield* Effect.gen(function* () {
          yield* Deferred.await(entered);
          const second = yield* create(remoteOptions(11, aliasCwd), Effect.succeed).pipe(
            Effect.provideService(Scheduler.PreventSchedulerYield, true),
            Effect.forkScoped,
          );
          do {
            yield* Queue.take(operationFinished);
            second.currentDispatcher.flush();
          } while (activeOperations !== 0);

          assert.isUndefined(second.pollUnsafe());
          assert.isFalse(yield* fileSystem.exists(path.join(worktreesDir, chatId(11))));
          assert.strictEqual(
            (yield* git(repositoryCwd, ["rev-parse", "origin/main"])).trim(),
            stale,
          );
          const localCwd = yield* create(options(chatId(12), aliasCwd), Effect.succeed).pipe(
            Effect.timeout("5 seconds"),
            TestClock.withLive,
          );
          assert.strictEqual((yield* git(localCwd, ["rev-parse", "HEAD"])).trim(), latest);
          const independentCwd = yield* create(
            remoteOptions(13, independentRepositoryCwd),
            Effect.succeed,
          ).pipe(Effect.timeout("5 seconds"), TestClock.withLive);
          assert.strictEqual(
            (yield* git(independentCwd, ["rev-parse", "HEAD"])).trim(),
            independentLatest,
          );

          yield* Deferred.succeed(release, undefined);
          const firstCwd = yield* Fiber.join(first);
          const secondCwd = yield* Fiber.join(second);
          assert.strictEqual((yield* git(firstCwd, ["rev-parse", "HEAD"])).trim(), latest);
          assert.strictEqual((yield* git(secondCwd, ["rev-parse", "HEAD"])).trim(), latest);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      }).pipe(Effect.provide(BunServices.layer)),
  );

  for (const baseKind of ["local branch", "commit", "ambiguous local branch"]) {
    it.effect(`does not fetch when the base resolves to a ${baseKind}`, () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { repositoryCwd, worktreesDir } = yield* makeRepository();
        const remoteCwd = yield* makeRemote(repositoryCwd, "origin");
        yield* git(repositoryCwd, ["remote", "add", "origin", remoteCwd]);
        yield* git(repositoryCwd, ["fetch", "origin"]);
        const commit = (yield* git(repositoryCwd, ["rev-parse", "HEAD"])).trim();
        yield* git(repositoryCwd, ["commit", "--allow-empty", "-m", "local update"]);
        const local = (yield* git(repositoryCwd, ["rev-parse", "HEAD"])).trim();
        yield* git(repositoryCwd, ["branch", "origin/main"]);
        yield* git(repositoryCwd, [
          "remote",
          "set-url",
          "origin",
          path.join(repositoryCwd, "missing.git"),
        ]);
        const branch =
          baseKind === "commit" ? commit : baseKind === "local branch" ? "main" : "origin/main";
        const { create } = yield* make(worktreesDir);
        const cwd = yield* create(
          { ...options(chatId(7), repositoryCwd), settings: { ...settings, branch } },
          Effect.succeed,
        );

        assert.strictEqual(
          (yield* git(cwd, ["rev-parse", "HEAD"])).trim(),
          baseKind === "commit" ? commit : local,
        );
        assert.strictEqual(
          (yield* git(repositoryCwd, ["rev-parse", "refs/remotes/origin/main"])).trim(),
          commit,
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );
  }

  it.effect(
    "stops after one failed fetch without acquiring a worktree or using the stale base",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repositoryCwd, worktreesDir } = yield* makeRepository();
        const remoteCwd = yield* makeRemote(repositoryCwd, "origin");
        yield* git(repositoryCwd, ["remote", "add", "origin", remoteCwd]);
        yield* git(repositoryCwd, ["fetch", "origin"]);
        const uploadPack = path.join(repositoryCwd, "..", "upload-pack");
        yield* fileSystem.writeFileString(
          uploadPack,
          '#!/bin/sh\nprintf "fetch\\n" >> "$0.log"\nexit 1\n',
        );
        yield* fileSystem.chmod(uploadPack, 0o700);
        yield* git(repositoryCwd, ["config", "remote.origin.uploadpack", `"${uploadPack}"`]);
        const worktrees = yield* git(repositoryCwd, ["worktree", "list", "--porcelain"]);
        const { create } = yield* make(worktreesDir);
        const id = chatId(8);
        let callbackRan = false;
        const error = yield* create(
          {
            ...options(id, repositoryCwd),
            settings: { ...settings, branch: "origin/main" },
          },
          () =>
            Effect.sync(() => {
              callbackRan = true;
            }),
        ).pipe(Effect.flip);

        assert.instanceOf(error, GitError);
        assert.isFalse(callbackRan);
        assert.isFalse(yield* fileSystem.exists(worktreesDir));
        assert.strictEqual(yield* fileSystem.readFileString(`${uploadPack}.log`), "fetch\n");
        assert.strictEqual(
          yield* git(repositoryCwd, ["worktree", "list", "--porcelain"]),
          worktrees,
        );
        assert.strictEqual(
          (yield* git(repositoryCwd, ["branch", "--list", `chat/${id}`])).trim(),
          "",
        );
      }).pipe(Effect.provide(BunServices.layer)),
  );

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

  it.effect("reports independent rollback failures without replacing the primary error", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const { create } = yield* make(worktreesDir);
      const id = chatId(4);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const branch = `chat/${id}`;
      const primary = new PersistenceError({ message: "private primary failure" });
      const logs: Array<{
        readonly cause: Cause.Cause<unknown>;
        readonly annotations: Readonly<Record<string, unknown>>;
      }> = [];
      const logger = Logger.make<unknown, void>((entry) => {
        if (entry.logLevel === "Error") {
          logs.push({
            cause: entry.cause,
            annotations: entry.fiber.getRef(References.CurrentLogAnnotations),
          });
        }
      });

      const error = yield* create(options(id, repositoryCwd), (createdCwd) =>
        git(createdCwd, ["worktree", "lock", "--", createdCwd]).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.scoped,
          Effect.andThen(Effect.fail(primary)),
        ),
      ).pipe(Effect.provide(Logger.layer([logger])), Effect.flip);

      assert.strictEqual(error, primary);
      assert.strictEqual(logs.length, 2);
      assert.deepStrictEqual(
        logs.map((entry) => entry.annotations.resource),
        ["worktree", "branch"],
      );
      for (const entry of logs) {
        assert.strictEqual(entry.annotations.chatId, id);
        assert.strictEqual(entry.annotations.phase, "rollback");
        const failures = entry.cause.reasons.filter(Cause.isFailReason);
        assert.strictEqual(failures.length, 1);
        for (const failure of failures) {
          assert.instanceOf(failure.error, GitError);
          if (!(failure.error instanceof GitError)) continue;
          assert.match(failure.error.message, /Git exited with code [1-9]\d*/);
          assert.notInclude(failure.error.message, repositoryCwd);
          assert.notInclude(failure.error.message, branch);
          assert.notInclude(failure.error.message, primary.message);
        }
      }
      assert.isTrue(yield* fileSystem.exists(cwd));
      assert.strictEqual(
        (yield* git(repositoryCwd, [
          "for-each-ref",
          "--format=%(refname)",
          `refs/heads/${branch}`,
        ])).trim(),
        `refs/heads/${branch}`,
      );
      yield* git(repositoryCwd, ["worktree", "unlock", "--", cwd]);
      yield* git(repositoryCwd, ["worktree", "remove", "--force", "--", cwd]);
      yield* git(repositoryCwd, ["branch", "-D", "--", branch]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rolls back interrupted use without reporting an operational failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const { create } = yield* make(worktreesDir);
      const id = chatId(5);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const acquired = yield* Deferred.make<void>();
      const logs: Array<unknown> = [];
      const logger = Logger.make<unknown, void>((entry) => {
        if (entry.logLevel === "Error") logs.push(entry.cause);
      });
      const fiber = yield* create(options(id, repositoryCwd), () =>
        Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.provide(Logger.layer([logger])), Effect.forkChild);

      yield* Deferred.await(acquired);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      assert.deepStrictEqual(logs, []);
      assert.isFalse(yield* fileSystem.exists(cwd));
      assert.strictEqual(
        (yield* git(repositoryCwd, ["branch", "--list", `chat/${id}`])).trim(),
        "",
      );
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
      assert.match(error.message, /Git exited with code [1-9]\d*/);
      assert.notInclude(error.message, repositoryCwd);
      assert.notInclude(error.message, branch);
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

      const error = yield* validate({ repositoryCwd: missingRepository, settings }).pipe(
        Effect.flip,
      );
      assert.instanceOf(error, GitError);
      if (!(error instanceof GitError)) return;
      assert.include(error.message, "spawn");
      assert.include(error.message, "NotFound");
      assert.notInclude(error.message, missingRepository);
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
      const remoteCwd = yield* makeRemote(repositoryCwd, "origin");
      yield* git(repositoryCwd, ["remote", "add", "origin", remoteCwd]);
      yield* git(repositoryCwd, ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"]);
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
      const remoteRefs = yield* git(remoteCwd, ["show-ref"]);
      assert.strictEqual(
        (yield* git(cwd, ["for-each-ref", "--format=%(upstream)", `refs/heads/chat/${id}`])).trim(),
        "",
      );

      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(id, cwd, "remote-base-topic")),
        { kind: "renamed" },
      );
      assert.strictEqual(
        (yield* git(cwd, ["branch", "--show-current"])).trim(),
        renamedBranch(id, "remote-base-topic"),
      );
      assert.strictEqual(yield* git(remoteCwd, ["show-ref"]), remoteRefs);
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

  it.effect("renames with a base upstream and configured unpublished push destination", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const remoteCwd = yield* makeRemote(repositoryCwd, "origin");
      yield* git(repositoryCwd, ["remote", "add", "origin", remoteCwd]);
      yield* git(repositoryCwd, ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"]);
      const worktree = yield* make(worktreesDir);
      const id = chatId(40);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const source = `chat/${id}`;
      const target = renamedBranch(id, "unpublished-topic");
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);
      yield* git(cwd, ["branch", "--set-upstream-to=origin/main", source]);
      yield* git(cwd, ["config", `branch.${source}.pushRemote`, "origin"]);
      yield* git(cwd, ["config", "push.default", "current"]);
      const remoteRefs = yield* git(remoteCwd, ["show-ref"]);

      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(id, cwd, "unpublished-topic")),
        { kind: "renamed" },
      );
      assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), target);
      assert.strictEqual(yield* git(remoteCwd, ["show-ref"]), remoteRefs);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("preserves a published source without any cached remote refs", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const remoteCwd = yield* makeRemote(repositoryCwd, "publisher");
      yield* git(repositoryCwd, ["remote", "add", "publisher", remoteCwd]);
      const worktree = yield* make(worktreesDir);
      const id = chatId(41);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const source = `chat/${id}`;
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);
      yield* git(cwd, ["push", remoteCwd, `HEAD:refs/heads/${source}`]);
      yield* git(repositoryCwd, ["update-ref", "-d", `refs/remotes/publisher/${source}`]);
      assert.strictEqual(yield* git(cwd, ["for-each-ref", "refs/remotes/"]), "");
      const remoteRefs = yield* git(remoteCwd, ["show-ref"]);

      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(id, cwd, "published-topic")),
        { kind: "skipped", reason: "remote-state" },
      );
      assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), source);
      assert.strictEqual(yield* git(remoteCwd, ["show-ref"]), remoteRefs);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("preserves the source when the generated target exists only on the remote", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const remoteCwd = yield* makeRemote(repositoryCwd, "origin");
      yield* git(repositoryCwd, ["remote", "add", "origin", remoteCwd]);
      const worktree = yield* make(worktreesDir);
      const id = chatId(42);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const source = `chat/${id}`;
      const target = renamedBranch(id, "published-target");
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);
      yield* git(cwd, ["push", remoteCwd, `HEAD:refs/heads/${target}`]);
      yield* git(repositoryCwd, ["update-ref", "-d", `refs/remotes/origin/${target}`]);
      const remoteRefs = yield* git(remoteCwd, ["show-ref"]);

      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(id, cwd, "published-target")),
        { kind: "skipped", reason: "remote-state" },
      );
      assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), source);
      assert.strictEqual((yield* git(cwd, ["branch", "--list", target])).trim(), "");
      assert.strictEqual(yield* git(remoteCwd, ["show-ref"]), remoteRefs);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("ignores stale cached refs and remote refs that only share a name suffix", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const remoteCwd = yield* makeRemote(repositoryCwd, "origin");
      yield* git(repositoryCwd, ["remote", "add", "origin", remoteCwd]);
      const worktree = yield* make(worktreesDir);
      const id = chatId(43);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const source = `chat/${id}`;
      const target = renamedBranch(id, "local-topic");
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);
      yield* git(repositoryCwd, ["update-ref", `refs/remotes/origin/${source}`, "HEAD"]);
      yield* git(repositoryCwd, ["update-ref", `refs/remotes/origin/${target}`, "HEAD"]);
      yield* git(remoteCwd, ["update-ref", `refs/heads/archive/refs/heads/${source}`, "HEAD"]);
      yield* git(remoteCwd, ["update-ref", `refs/tags/refs/heads/${target}`, "HEAD"]);
      const remoteRefs = yield* git(remoteCwd, ["show-ref"]);
      const cachedRefs = yield* git(repositoryCwd, ["for-each-ref", "refs/remotes/"]);

      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(id, cwd, "local-topic")),
        { kind: "renamed" },
      );
      assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), target);
      assert.strictEqual(yield* git(remoteCwd, ["show-ref"]), remoteRefs);
      assert.strictEqual(yield* git(repositoryCwd, ["for-each-ref", "refs/remotes/"]), cachedRefs);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("checks the fetch endpoint even when the push URL is different", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const fetchCwd = yield* makeRemote(repositoryCwd, "fetch");
      const pushCwd = yield* makeRemote(repositoryCwd, "push");
      yield* git(repositoryCwd, ["remote", "add", "origin", fetchCwd]);
      yield* git(repositoryCwd, ["remote", "set-url", "--push", "origin", pushCwd]);
      const worktree = yield* make(worktreesDir);
      const id = chatId(44);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const source = `chat/${id}`;
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);
      yield* git(cwd, ["push", fetchCwd, `HEAD:refs/heads/${source}`]);
      yield* git(repositoryCwd, ["update-ref", "-d", `refs/remotes/origin/${source}`]);
      const fetchRefs = yield* git(fetchCwd, ["show-ref"]);
      const pushRefs = yield* git(pushCwd, ["show-ref"]);

      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(id, cwd, "fetch-published-topic")),
        { kind: "skipped", reason: "remote-state" },
      );
      assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), source);
      assert.strictEqual(yield* git(fetchCwd, ["show-ref"]), fetchRefs);
      assert.strictEqual(yield* git(pushCwd, ["show-ref"]), pushRefs);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("checks a second push endpoint when fetch and the first push are unpublished", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const fetchCwd = yield* makeRemote(repositoryCwd, "fetch");
      const pushCwd = yield* makeRemote(repositoryCwd, "push");
      const backupCwd = yield* makeRemote(repositoryCwd, "backup");
      yield* git(repositoryCwd, ["remote", "add", "origin", fetchCwd]);
      yield* git(repositoryCwd, ["remote", "set-url", "--add", "--push", "origin", pushCwd]);
      yield* git(repositoryCwd, ["remote", "set-url", "--add", "--push", "origin", backupCwd]);
      const worktree = yield* make(worktreesDir);
      const id = chatId(45);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const source = `chat/${id}`;
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);
      yield* git(cwd, ["push", backupCwd, `HEAD:refs/heads/${source}`]);
      yield* git(repositoryCwd, ["update-ref", "-d", `refs/remotes/origin/${source}`]);
      assert.strictEqual(yield* git(cwd, ["for-each-ref", "refs/remotes/"]), "");
      const fetchRefs = yield* git(fetchCwd, ["show-ref"]);
      const pushRefs = yield* git(pushCwd, ["show-ref"]);
      const backupRefs = yield* git(backupCwd, ["show-ref"]);

      assert.deepStrictEqual(
        yield* worktree.renameChatBranch(renameOptions(id, cwd, "backup-published-topic")),
        { kind: "skipped", reason: "remote-state" },
      );
      assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), source);
      assert.strictEqual(yield* git(fetchCwd, ["show-ref"]), fetchRefs);
      assert.strictEqual(yield* git(pushCwd, ["show-ref"]), pushRefs);
      assert.strictEqual(yield* git(backupCwd, ["show-ref"]), backupRefs);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("returns GitError and keeps HEAD when a configured endpoint is inaccessible", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const remoteCwd = yield* makeRemote(repositoryCwd, "origin");
      const missingCwd = path.join(repositoryCwd, "..", "missing.git");
      yield* git(repositoryCwd, ["remote", "add", "origin", remoteCwd]);
      yield* git(repositoryCwd, ["remote", "add", "unavailable", missingCwd]);
      const worktree = yield* make(worktreesDir);
      const id = chatId(46);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const source = `chat/${id}`;
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);
      const head = yield* git(cwd, ["rev-parse", "HEAD"]);
      const remoteRefs = yield* git(remoteCwd, ["show-ref"]);
      const logs: Array<unknown> = [];
      const logger = Logger.make<unknown, void>((entry) => {
        if (entry.logLevel === "Error") logs.push(entry.cause);
      });

      const error = yield* worktree
        .renameChatBranch(renameOptions(id, cwd, "inaccessible-topic"))
        .pipe(Effect.provide(Logger.layer([logger])), Effect.flip);
      assert.instanceOf(error, GitError);
      assert.match(error.message, /Git exited with code [1-9]\d*/);
      assert.notInclude(error.message, missingCwd);
      assert.notInclude(error.message, source);
      assert.deepStrictEqual(logs, []);
      assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), source);
      assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), head);
      assert.strictEqual(yield* git(remoteCwd, ["show-ref"]), remoteRefs);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("times out a hanging remote and kills its TERM-resistant transport helper", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const worktree = yield* make(worktreesDir);
      const id = chatId(47);
      const cwd = AbsolutePath.make(path.join(worktreesDir, id));
      const source = `chat/${id}`;
      yield* worktree.create(options(id, repositoryCwd), () => Effect.void);
      const head = yield* git(cwd, ["rev-parse", "HEAD"]);
      const transport = yield* makeHangingTransport(repositoryCwd);
      yield* git(repositoryCwd, ["config", "protocol.ext.allow", "always"]);
      yield* git(repositoryCwd, ["remote", "add", "hanging", transport.endpoint]);
      const rename = yield* worktree
        .renameChatBranch(renameOptions(id, cwd, "timeout-topic"))
        .pipe(Effect.flip, Effect.forkScoped);

      yield* Effect.gen(function* () {
        const pid = yield* transport.ready.pipe(Effect.timeout("5 seconds"), TestClock.withLive);
        assert.isTrue(yield* helperIsRunning(pid, repositoryCwd));

        yield* TestClock.adjust("10 seconds");
        assert.instanceOf(
          yield* Fiber.join(rename).pipe(Effect.timeout("2 seconds"), TestClock.withLive),
          GitError,
        );
        yield* awaitHelperExit(pid, repositoryCwd);
        assert.strictEqual((yield* git(cwd, ["branch", "--show-current"])).trim(), source);
        assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), head);
      }).pipe(Effect.ensuring(transport.close));
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
      const commit = (yield* git(repositoryCwd, ["rev-parse", "main^{commit}"])).trim();

      const sameId = chatId(60);
      const sameCwd = AbsolutePath.make(path.join(worktreesDir, sameId));
      yield* worktree.create(options(sameId, repositoryCwd), () => Effect.void);
      yield* Effect.all(
        [
          worktree.renameChatBranch(renameOptions(sameId, sameCwd, "same-topic")),
          worktree.renameChatBranch(renameOptions(sameId, sameCwd, "same-topic")),
        ],
        { concurrency: "unbounded", discard: true },
      );
      assert.strictEqual(
        (yield* git(sameCwd, ["branch", "--show-current"])).trim(),
        renamedBranch(sameId, "same-topic"),
      );
      assert.strictEqual((yield* git(sameCwd, ["rev-parse", "HEAD^{commit}"])).trim(), commit);
      assert.strictEqual(
        (yield* git(repositoryCwd, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          `refs/heads/chat/${sameId}`,
          `refs/heads/${renamedBranch(sameId, "same-topic")}`,
        ])).trim(),
        `refs/heads/${renamedBranch(sameId, "same-topic")} ${commit}`,
      );

      const differentId = chatId(61);
      const differentCwd = AbsolutePath.make(path.join(worktreesDir, differentId));
      yield* worktree.create(options(differentId, repositoryCwd), () => Effect.void);
      yield* Effect.all(
        [
          worktree.renameChatBranch(renameOptions(differentId, differentCwd, "first-topic")),
          worktree.renameChatBranch(renameOptions(differentId, differentCwd, "second-topic")),
        ],
        { concurrency: "unbounded", discard: true },
      );
      const finalBranch = (yield* git(differentCwd, ["branch", "--show-current"])).trim();
      assert.include(
        [renamedBranch(differentId, "first-topic"), renamedBranch(differentId, "second-topic")],
        finalBranch,
      );
      assert.strictEqual((yield* git(differentCwd, ["rev-parse", "HEAD^{commit}"])).trim(), commit);
      assert.strictEqual(
        (yield* git(repositoryCwd, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          `refs/heads/chat/${differentId}`,
          `refs/heads/${renamedBranch(differentId, "first-topic")}`,
          `refs/heads/${renamedBranch(differentId, "second-topic")}`,
        ])).trim(),
        `refs/heads/${finalBranch} ${commit}`,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("serializes repository renames without blocking an independent repository", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { repositoryCwd, worktreesDir } = yield* makeRepository();
      const { repositoryCwd: independentRepositoryCwd } = yield* makeRepository();
      const setup = yield* make(worktreesDir);
      const firstId = chatId(62);
      const secondId = chatId(63);
      const independentId = chatId(64);
      const firstCwd = AbsolutePath.make(path.join(worktreesDir, firstId));
      const secondCwd = AbsolutePath.make(path.join(worktreesDir, secondId));
      const independentCwd = AbsolutePath.make(path.join(worktreesDir, independentId));
      yield* setup.create(options(firstId, repositoryCwd), () => Effect.void);
      yield* setup.create(options(secondId, repositoryCwd), () => Effect.void);
      yield* setup.create(options(independentId, independentRepositoryCwd), () => Effect.void);
      const commit = (yield* git(repositoryCwd, ["rev-parse", "main^{commit}"])).trim();
      const independentCommit = (yield* git(independentRepositoryCwd, [
        "rev-parse",
        "main^{commit}",
      ])).trim();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const commandFinished = yield* Queue.unbounded<void>();
      let activeCommands = 0;
      const gatedSpawner = ChildProcessSpawner.make(
        Effect.fn("GitWorktreeTest.gatedSpawn")(function* (command: ChildProcess.Command) {
          if (command._tag === "StandardCommand") {
            if (
              command.options.cwd === firstCwd &&
              command.args[0] === "branch" &&
              command.args[1] === "-m"
            ) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            if (command.options.cwd === secondCwd) {
              activeCommands += 1;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  activeCommands -= 1;
                  Queue.offerUnsafe(commandFinished, undefined);
                }),
              );
            }
          }
          return yield* spawner.spawn(command);
        }),
      );
      const worktree = yield* make(worktreesDir).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, gatedSpawner),
      );
      const first = yield* worktree
        .renameChatBranch(renameOptions(firstId, firstCwd, "first-topic"))
        .pipe(Effect.forkScoped);

      yield* Effect.gen(function* () {
        yield* Deferred.await(entered);
        const second = yield* worktree
          .renameChatBranch(renameOptions(secondId, secondCwd, "second-topic"))
          .pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true), Effect.forkScoped);
        do {
          yield* Queue.take(commandFinished);
          second.currentDispatcher.flush();
        } while (activeCommands !== 0);

        assert.strictEqual(
          (yield* git(repositoryCwd, [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads/chat/",
          ])).trim(),
          [`refs/heads/chat/${firstId} ${commit}`, `refs/heads/chat/${secondId} ${commit}`].join(
            "\n",
          ),
        );
        assert.isUndefined(second.pollUnsafe());
        assert.deepStrictEqual(
          yield* worktree
            .renameChatBranch(renameOptions(independentId, independentCwd, "independent-topic"))
            .pipe(Effect.timeout("5 seconds"), TestClock.withLive),
          { kind: "renamed" },
        );
        assert.strictEqual(
          (yield* git(independentRepositoryCwd, [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads/chat/",
          ])).trim(),
          `refs/heads/${renamedBranch(independentId, "independent-topic")} ${independentCommit}`,
        );
        assert.strictEqual(
          (yield* git(firstCwd, ["branch", "--show-current"])).trim(),
          `chat/${firstId}`,
        );
        assert.strictEqual(
          (yield* git(secondCwd, ["branch", "--show-current"])).trim(),
          `chat/${secondId}`,
        );

        yield* Deferred.succeed(release, undefined);
        assert.deepStrictEqual(yield* Fiber.join(first), { kind: "renamed" });
        assert.deepStrictEqual(yield* Fiber.join(second), { kind: "renamed" });
        assert.strictEqual(
          (yield* git(repositoryCwd, [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads/chat/",
          ])).trim(),
          [
            `refs/heads/${renamedBranch(firstId, "first-topic")} ${commit}`,
            `refs/heads/${renamedBranch(secondId, "second-topic")} ${commit}`,
          ].join("\n"),
        );
        for (const { id, cwd, topic, expectedCommit } of [
          { id: firstId, cwd: firstCwd, topic: "first-topic", expectedCommit: commit },
          { id: secondId, cwd: secondCwd, topic: "second-topic", expectedCommit: commit },
          {
            id: independentId,
            cwd: independentCwd,
            topic: "independent-topic",
            expectedCommit: independentCommit,
          },
        ]) {
          assert.strictEqual(
            (yield* git(cwd, ["branch", "--show-current"])).trim(),
            renamedBranch(id, topic),
          );
          assert.strictEqual(
            (yield* git(cwd, ["rev-parse", "HEAD^{commit}"])).trim(),
            expectedCommit,
          );
        }
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
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
