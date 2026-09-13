import { assert, describe, it } from "@effect/vitest";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AgentError, GitError, PersistenceError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { GitWorktree, RenameChatBranchResult } from "@pico/contract/worktree";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as BranchNaming from "./branch-naming.ts";

const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000098");

describe("BranchNaming", () => {
  it.effect("names only eligible worktree chats and slugifies valid topics", () =>
    Effect.gen(function* () {
      const directWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000010");
      const worktreeWorkspaceId = Workspace.WorkspaceId.make(
        "018f47a0-0000-7000-8000-000000000011",
      );
      const missingNamingWorkspaceId = Workspace.WorkspaceId.make(
        "018f47a0-0000-7000-8000-000000000015",
      );
      const directChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000012");
      const archivedChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000013");
      const eligibleChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000014");
      const orphanedChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000016");
      const directCwd = AbsolutePath.make("/tmp/pico-direct");
      const worktreeCwd = AbsolutePath.make(`/tmp/pico-worktrees/${eligibleChatId}`);
      const workspaces = new Map<Workspace.WorkspaceId, Workspace.Workspace>([
        [
          directWorkspaceId,
          {
            id: directWorkspaceId,
            name: "direct",
            binding: null,
            defaultCwd: directCwd,
            worktree: null,
            createdAt: 1,
          },
        ],
        [
          worktreeWorkspaceId,
          {
            id: worktreeWorkspaceId,
            name: "worktree",
            binding: null,
            defaultCwd: directCwd,
            worktree: { branch: "main", prefix: "chat/" },
            createdAt: 1,
          },
        ],
      ]);
      const chats = new Map<Chat.ChatId, Chat.Chat>([
        [
          directChatId,
          {
            id: directChatId,
            workspaceId: directWorkspaceId,
            cwd: directCwd,
            externalId: null,
            createdAt: 1,
            archivedAt: null,
          },
        ],
        [
          archivedChatId,
          {
            id: archivedChatId,
            workspaceId: worktreeWorkspaceId,
            cwd: worktreeCwd,
            externalId: null,
            createdAt: 1,
            archivedAt: 2,
          },
        ],
        [
          orphanedChatId,
          {
            id: orphanedChatId,
            workspaceId: missingNamingWorkspaceId,
            cwd: directCwd,
            externalId: null,
            createdAt: 1,
            archivedAt: null,
          },
        ],
        [
          eligibleChatId,
          {
            id: eligibleChatId,
            workspaceId: worktreeWorkspaceId,
            cwd: worktreeCwd,
            externalId: null,
            createdAt: 1,
            archivedAt: null,
          },
        ],
      ]);
      const repositories = Layer.merge(
        Layer.succeed(
          ChatRepository,
          ChatRepository.of({
            listOpenByWorkspace: () => Effect.die("unexpected open chat list"),
            create: () => Effect.die("unexpected chat create"),
            archive: () => Effect.die("unexpected chat archive"),
            findById: (id) => Effect.succeed(Option.fromUndefinedOr(chats.get(id))),
            findByExternalId: () => Effect.die("unexpected external chat lookup"),
          }),
        ),
        Layer.succeed(
          WorkspaceRepository,
          WorkspaceRepository.of({
            list: () => Effect.die("unexpected workspace list"),
            create: () => Effect.die("unexpected workspace create"),
            getOrCreateByBinding: () => Effect.die("unexpected bound workspace creation"),
            findById: (id) => Effect.succeed(Option.fromUndefinedOr(workspaces.get(id))),
            findByBinding: () => Effect.die("unexpected workspace binding lookup"),
            replaceConfiguration: () => Effect.die("unexpected workspace replacement"),
          }),
        ),
      );
      const renamed = yield* Deferred.make<void>();
      const renames: Array<{
        readonly chatId: Chat.ChatId;
        readonly cwd: AbsolutePath;
        readonly prefix: string;
        readonly topic: string;
      }> = [];
      const gitWorktree: GitWorktree = {
        validate: () => Effect.die("unexpected validation"),
        create: () => Effect.die("unexpected worktree creation"),
        inspectChat: () => Effect.die("unexpected worktree inspection"),
        renameChatBranch: (input) =>
          Effect.sync(() => {
            renames.push(input);
          }).pipe(
            Effect.andThen(Deferred.succeed(renamed, undefined)),
            Effect.as({ kind: "renamed" } satisfies RenameChatBranchResult),
          ),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const handler = (yield* BranchNaming.make(gitWorktree)).handle;
        let generations = 0;
        const generate = async () => {
          generations += 1;
          return "Fix-GitHub-Flow";
        };
        handler({ chatId: missingChatId, generateTopic: generate });
        handler({ chatId: archivedChatId, generateTopic: generate });
        handler({ chatId: directChatId, generateTopic: generate });
        handler({ chatId: orphanedChatId, generateTopic: generate });
        for (const topic of [
          "single",
          "修复-登录",
          "1fix-widget",
          "one-two-three-four-five-six-seven",
          `${"a".repeat(47)}-b`,
        ]) {
          handler({ chatId: eligibleChatId, generateTopic: async () => topic });
        }
        handler({ chatId: eligibleChatId, generateTopic: async () => null });
        handler({ chatId: eligibleChatId, generateTopic: generate });
        yield* Deferred.await(renamed);

        assert.strictEqual(generations, 1);
        assert.deepStrictEqual(renames, [
          {
            chatId: eligibleChatId,
            cwd: worktreeCwd,
            prefix: "chat/",
            topic: "fix-github-flow",
          },
        ]);
      }).pipe(Effect.provide(repositories), Effect.scoped);
    }),
  );

  it.effect("revalidates archive and worktree configuration after generation", () =>
    Effect.gen(function* () {
      const firstWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000020");
      const firstChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000021");
      const cwd = AbsolutePath.make(`/tmp/pico-worktrees/${firstChatId}`);
      let chat: Chat.Chat = {
        id: firstChatId,
        workspaceId: firstWorkspaceId,
        cwd,
        externalId: null,
        createdAt: 1,
        archivedAt: null,
      };
      let workspace: Workspace.Workspace = {
        id: firstWorkspaceId,
        name: "worktree",
        binding: null,
        defaultCwd: AbsolutePath.make("/tmp/pico-repository"),
        worktree: { branch: "main", prefix: "chat/" },
        createdAt: 1,
      };
      let chatReads = 0;
      let workspaceReads = 0;
      let secondChatRead = Promise.withResolvers<void>();
      let secondWorkspaceRead: PromiseWithResolvers<void> | undefined;
      const repositories = Layer.merge(
        Layer.succeed(
          ChatRepository,
          ChatRepository.of({
            listOpenByWorkspace: () => Effect.die("unexpected open chat list"),
            create: () => Effect.die("unexpected chat create"),
            archive: () => Effect.die("unexpected chat archive"),
            findById: (id) =>
              Effect.sync(() => {
                if (id !== firstChatId) return Option.none<Chat.Chat>();
                chatReads += 1;
                if (chatReads === 2) secondChatRead.resolve();
                return Option.some(chat);
              }),
            findByExternalId: () => Effect.die("unexpected external chat lookup"),
          }),
        ),
        Layer.succeed(
          WorkspaceRepository,
          WorkspaceRepository.of({
            list: () => Effect.die("unexpected workspace list"),
            create: () => Effect.die("unexpected workspace create"),
            getOrCreateByBinding: () => Effect.die("unexpected bound workspace creation"),
            findById: (id) =>
              Effect.sync(() => {
                if (id !== firstWorkspaceId) return Option.none<Workspace.Workspace>();
                workspaceReads += 1;
                if (workspaceReads === 2) secondWorkspaceRead?.resolve();
                return Option.some(workspace);
              }),
            findByBinding: () => Effect.die("unexpected workspace binding lookup"),
            replaceConfiguration: () => Effect.die("unexpected workspace replacement"),
          }),
        ),
      );
      const renames: string[] = [];
      const renamed = yield* Deferred.make<void>();
      const gitWorktree: GitWorktree = {
        validate: () => Effect.die("unexpected validation"),
        create: () => Effect.die("unexpected worktree creation"),
        inspectChat: () => Effect.die("unexpected worktree inspection"),
        renameChatBranch: ({ topic }) =>
          Effect.sync(() => {
            renames.push(topic);
          }).pipe(
            Effect.andThen(Deferred.succeed(renamed, undefined)),
            Effect.as({ kind: "renamed" } satisfies RenameChatBranchResult),
          ),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const handler = (yield* BranchNaming.make(gitWorktree)).handle;

        const archivedGeneration = Promise.withResolvers<string | null>();
        const archivedStarted = Promise.withResolvers<void>();
        handler({
          chatId: firstChatId,
          generateTopic: () => {
            archivedStarted.resolve();
            return archivedGeneration.promise;
          },
        });
        yield* Effect.promise(() => archivedStarted.promise);
        chat = { ...chat, archivedAt: 2 };
        archivedGeneration.resolve("archive-race");
        yield* Effect.promise(() => secondChatRead.promise);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(renames, []);

        chat = { ...chat, archivedAt: null };
        chatReads = 0;
        workspaceReads = 0;
        secondChatRead = Promise.withResolvers<void>();
        const configSecondWorkspaceRead = Promise.withResolvers<void>();
        secondWorkspaceRead = configSecondWorkspaceRead;
        const configGeneration = Promise.withResolvers<string | null>();
        const configStarted = Promise.withResolvers<void>();
        handler({
          chatId: firstChatId,
          generateTopic: () => {
            configStarted.resolve();
            return configGeneration.promise;
          },
        });
        yield* Effect.promise(() => configStarted.promise);
        workspace = {
          ...workspace,
          worktree: { branch: "release", prefix: "renamed/" },
        };
        configGeneration.resolve("config-race");
        yield* Effect.promise(() => configSecondWorkspaceRead.promise);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(renames, []);

        chatReads = 0;
        workspaceReads = 0;
        secondChatRead = Promise.withResolvers<void>();
        const cwdGeneration = Promise.withResolvers<string | null>();
        const cwdStarted = Promise.withResolvers<void>();
        handler({
          chatId: firstChatId,
          generateTopic: () => {
            cwdStarted.resolve();
            return cwdGeneration.promise;
          },
        });
        yield* Effect.promise(() => cwdStarted.promise);
        chat = { ...chat, cwd: AbsolutePath.make("/tmp/pico-worktrees/moved") };
        cwdGeneration.resolve("cwd-race");
        yield* Effect.promise(() => secondChatRead.promise);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(renames, []);

        chatReads = 0;
        workspaceReads = 0;
        handler({ chatId: firstChatId, generateTopic: async () => "valid-final-topic" });
        yield* Deferred.await(renamed);
        assert.deepStrictEqual(renames, ["valid-final-topic"]);
      }).pipe(Effect.provide(repositories), Effect.scoped);
    }),
  );

  it.effect("contains repository, model, and Git failures across background requests", () =>
    Effect.gen(function* () {
      const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000030");
      const namingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000031");
      const cwd = AbsolutePath.make(`/tmp/pico-worktrees/${namingChatId}`);
      const chat: Chat.Chat = {
        id: namingChatId,
        workspaceId,
        cwd,
        externalId: null,
        createdAt: 1,
        archivedAt: null,
      };
      const workspace: Workspace.Workspace = {
        id: workspaceId,
        name: "worktree",
        binding: null,
        defaultCwd: AbsolutePath.make("/tmp/pico-repository"),
        worktree: { branch: "main", prefix: "chat/" },
        createdAt: 1,
      };
      const repositoryFailureObserved = Promise.withResolvers<void>();
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const failuresLogged = Promise.withResolvers<void>();
      const logger = Logger.make((options) => {
        if (options.logLevel !== "Error") return;
        logs.push(Logger.formatStructured.log(options));
        if (logs.length === 4) failuresLogged.resolve();
      });
      let repositoryFails = true;
      const repositories = Layer.merge(
        Layer.succeed(
          ChatRepository,
          ChatRepository.of({
            listOpenByWorkspace: () => Effect.die("unexpected open chat list"),
            create: () => Effect.die("unexpected chat create"),
            archive: () => Effect.die("unexpected chat archive"),
            findById: () =>
              repositoryFails
                ? Effect.sync(() => repositoryFailureObserved.resolve()).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new PersistenceError({
                          message: "chat.findById: ConnectionError, SQLite code 14",
                        }),
                      ),
                    ),
                  )
                : Effect.succeed(Option.some(chat)),
            findByExternalId: () => Effect.die("unexpected external chat lookup"),
          }),
        ),
        Layer.succeed(
          WorkspaceRepository,
          WorkspaceRepository.of({
            list: () => Effect.die("unexpected workspace list"),
            create: () => Effect.die("unexpected workspace create"),
            getOrCreateByBinding: () => Effect.die("unexpected bound workspace creation"),
            findById: () => Effect.succeed(Option.some(workspace)),
            findByBinding: () => Effect.die("unexpected workspace binding lookup"),
            replaceConfiguration: () => Effect.die("unexpected workspace replacement"),
          }),
        ),
      );
      const gitFailureObserved = yield* Deferred.make<void>();
      const renamed = yield* Deferred.make<void>();
      let gitFails = true;
      let renameAttempts = 0;
      const gitWorktree: GitWorktree = {
        validate: () => Effect.die("unexpected validation"),
        create: () => Effect.die("unexpected worktree creation"),
        inspectChat: () => Effect.die("unexpected worktree inspection"),
        renameChatBranch: () =>
          Effect.gen(function* () {
            renameAttempts += 1;
            if (gitFails) {
              yield* Deferred.succeed(gitFailureObserved, undefined);
              return yield* Effect.failCause(
                Cause.combine(
                  Cause.fail(
                    new GitError({
                      message: "Failed to rename chat branch: Git exited with code 128",
                    }),
                  ),
                  Cause.combine(
                    Cause.die(new Error("private defect token=secret")),
                    Cause.interrupt(),
                  ),
                ),
              );
            }
            yield* Deferred.succeed(renamed, undefined);
            return { kind: "renamed" } satisfies RenameChatBranchResult;
          }),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const handler = (yield* BranchNaming.make(gitWorktree)).handle;
        handler({ chatId: namingChatId, generateTopic: async () => "repository-failure" });
        yield* Effect.promise(() => repositoryFailureObserved.promise);
        repositoryFails = false;

        const modelFailureObserved = Promise.withResolvers<void>();
        handler({
          chatId: namingChatId,
          generateTopic: () => {
            modelFailureObserved.resolve();
            return Promise.reject(new Error("private model token=secret"));
          },
        });
        yield* Effect.promise(() => modelFailureObserved.promise);

        handler({
          chatId: namingChatId,
          generateTopic: async () => {
            throw new AgentError({ message: "Generate branch topic: HTTP 429" });
          },
        });

        handler({ chatId: namingChatId, generateTopic: async () => "git-failure" });
        yield* Deferred.await(gitFailureObserved);
        gitFails = false;

        handler({ chatId: namingChatId, generateTopic: async () => "final-success" });
        yield* Deferred.await(renamed);
        assert.strictEqual(renameAttempts, 2);
        yield* Effect.promise(() => failuresLogged.promise);

        const pendingGeneration = Promise.withResolvers<string | null>();
        const generationStarted = Promise.withResolvers<void>();
        handler({
          chatId: namingChatId,
          generateTopic: () => {
            generationStarted.resolve();
            return pendingGeneration.promise;
          },
        });
        yield* Effect.promise(() => generationStarted.promise);
      }).pipe(Effect.provide(repositories), Effect.scoped, Effect.provide(Logger.layer([logger])));
      assert.strictEqual(renameAttempts, 2);
      assert.strictEqual(logs.length, 4);
      assert.deepStrictEqual(logs.map((entry) => entry.annotations.phase).sort(), [
        "eligibility",
        "generation",
        "generation",
        "rename",
      ]);
      for (const entry of logs) {
        assert.deepInclude(entry.annotations, {
          component: "application",
          operation: "branch-naming",
          chatId: namingChatId,
        });
        if (entry.annotations.phase !== "eligibility") {
          assert.strictEqual(entry.annotations.workspaceId, workspaceId);
        }
      }
      const output = JSON.stringify(logs);
      assert.include(output, "chat.findById: ConnectionError, SQLite code 14");
      assert.include(output, "Failed to rename chat branch: Git exited with code 128");
      assert.include(output, "Generate branch topic: HTTP 429");
      assert.notInclude(output, "private model token=secret");
      assert.notInclude(output, "private defect token=secret");
      assert.strictEqual(
        logs.find((entry) => entry.annotations.phase === "rename")?.annotations.reason,
        "defect",
      );
      assert.notInclude(output, "git-failure");
    }),
  );
});
