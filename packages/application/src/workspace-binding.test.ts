import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import { AgentSessionStore, type CreateAgentSession } from "@pico/contract/agent-session-store";
import { Application } from "@pico/contract/application";
import { ChatRepository } from "@pico/contract/chat-repository";
import { WorkspaceBindingInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { GitWorktree } from "@pico/contract/worktree";
import * as Persistence from "@pico/persistence/layer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ApplicationLayer from "./application.ts";
import { unusedSchedulesLayer } from "./test-schedules.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

describe("Workspace binding", () => {
  it.effect("validates and replaces workspace configuration without rewriting existing chats", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-application-bind-",
      });
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
      const firstCwd = AbsolutePath.make(path.join(temporaryDirectory, "first"));
      const secondCwd = AbsolutePath.make(path.join(temporaryDirectory, "second"));
      const worktreeCwd = AbsolutePath.make(path.join(temporaryDirectory, "generated-worktree"));
      const unreadableCwd = path.join(temporaryDirectory, "unreadable");
      const file = path.join(temporaryDirectory, "file");
      yield* fileSystem.makeDirectory(firstCwd);
      yield* fileSystem.makeDirectory(secondCwd);
      yield* fileSystem.makeDirectory(unreadableCwd);
      yield* fileSystem.writeFileString(file, "fixture");
      const applicationFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        access: (candidate, options) =>
          candidate === unreadableCwd
            ? Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "access",
                    pathOrDescriptor: candidate,
                  }),
                ),
              )
            : fileSystem.access(candidate, options),
      });
      const applicationFileSystemLayer = Layer.succeed(
        FileSystem.FileSystem,
        applicationFileSystem,
      );

      const persistenceLayer = Persistence.layer(storeFile);
      const createdSessions: Array<CreateAgentSession> = [];
      const sessionsLayer = Layer.succeed(
        AgentSessionStore,
        AgentSessionStore.of({
          create: (input) =>
            Effect.sync(() => {
              createdSessions.push(input);
            }),
          readTitle: () => Effect.succeed(null),
          remove: () => Effect.void,
        }),
      );
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          history: () => Effect.die("unexpected history read"),
          previewHistory: () => Effect.die("unexpected history preview"),
          navigateHistory: () => Effect.die("unexpected history navigation"),
          availableModels: () => Effect.die("unexpected model catalog read"),
          discoverSkills: () => Effect.die("unexpected workspace skill command discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          events: Stream.empty,
          drain: () => Effect.void,
          transcript: () => Effect.die("unexpected transcript read"),
          resultSummary: () => Effect.die("unexpected chat results read"),
          send: () => Effect.die("unexpected runtime send"),
          sendCaptured: () => Effect.die("unexpected captured runtime send"),
          deliver: () => Effect.die("unexpected scheduled delivery"),
          publish: () => Effect.die("unexpected scheduled publish"),
          abort: () => Effect.die("unexpected runtime abort"),
          contextUsage: () => Effect.die("unexpected runtime context read"),
          shake: () => Effect.die("unexpected runtime shake"),
          close: () => Effect.die("unexpected runtime close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        }),
      );
      const validations: Array<Workspace.WorkspaceConfiguration> = [];
      const gitWorktree: GitWorktree = {
        validate: ({ repositoryCwd, settings }) =>
          Effect.sync(() => {
            validations.push({ defaultCwd: repositoryCwd, worktree: settings });
          }).pipe(
            Effect.andThen(
              settings.branch === "missing"
                ? Effect.fail(
                    new WorkspaceBindingInvalid({
                      issue: { field: "branch", reason: "not-commit" },
                    }),
                  )
                : Effect.void,
            ),
          ),
        create: (_options, use) => use(worktreeCwd),
        inspectChat: () => Effect.succeed({ kind: "not-managed" }),
        renameChatBranch: () => Effect.die("unexpected branch rename"),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      yield* Effect.gen(function* () {
        const application = yield* Application;
        const chats = yield* ChatRepository;
        const binding: Workspace.WorkspaceBinding = {
          platform: "discord",
          externalId: "9007199254740993.10",
        };

        const created = yield* application.bindWorkspace({
          binding,
          workspaceName: "general",
          configuration: { kind: "direct", cwd: `${firstCwd}/.` },
        });
        assert.strictEqual(created.name, "general");
        assert.strictEqual(created.defaultCwd, firstCwd);

        const freshWorktree = yield* application.bindWorkspace({
          binding: { platform: "discord", externalId: "9007199254740993.20" },
          workspaceName: "worktree channel",
          configuration: {
            kind: "worktree",
            repository: `${secondCwd}/.`,
            settings: { branch: "main", prefix: "fresh/" },
          },
        });
        assert.strictEqual(freshWorktree.name, "worktree channel");
        assert.strictEqual(freshWorktree.platform, "discord");
        assert.strictEqual(freshWorktree.externalId, "9007199254740993.20");
        assert.strictEqual(freshWorktree.defaultCwd, secondCwd);
        assert.deepStrictEqual(freshWorktree.worktree, { branch: "main", prefix: "fresh/" });

        const oldChat = yield* application.createChat({
          workspaceId: created.id,
          externalId: "thread-old",
          modelOverride: null,
        });
        const modelOverride = { provider: "native", id: "channel-model" };
        const configured = yield* application.setWorkspaceModel(created.id, modelOverride);
        const repeated = yield* application.bindWorkspace({
          binding,
          workspaceName: "ignored rename",
          configuration: { kind: "direct", cwd: `${firstCwd}/.` },
        });
        assert.deepStrictEqual(repeated, configured);

        const rebound = yield* application.bindWorkspace({
          binding,
          workspaceName: "still ignored",
          configuration: {
            kind: "direct",
            cwd: `${temporaryDirectory}/first/../second`,
          },
        });
        assert.strictEqual(rebound.name, "general");
        assert.strictEqual(rebound.defaultCwd, secondCwd);
        assert.deepStrictEqual(rebound.modelOverride, modelOverride);

        const worktreeBound = yield* application.bindWorkspace({
          binding,
          workspaceName: "ignored worktree rename",
          configuration: {
            kind: "worktree",
            repository: `${secondCwd}/.`,
            settings: { branch: "main", prefix: "chat/" },
          },
        });
        assert.deepStrictEqual(worktreeBound, {
          ...rebound,
          worktree: { branch: "main", prefix: "chat/" },
        });
        assert.deepStrictEqual(validations, [
          { defaultCwd: secondCwd, worktree: { branch: "main", prefix: "fresh/" } },
          { defaultCwd: secondCwd, worktree: { branch: "main", prefix: "chat/" } },
        ]);

        const worktreeChat = yield* application.createChat({
          workspaceId: created.id,
          externalId: "thread-worktree",
          modelOverride: null,
        });
        assert.strictEqual(worktreeChat.cwd, worktreeCwd);

        const repeatedWorktree = yield* application.bindWorkspace({
          binding,
          workspaceName: "ignored again",
          configuration: {
            kind: "worktree",
            repository: secondCwd,
            settings: { branch: "main", prefix: "chat/" },
          },
        });
        assert.deepStrictEqual(repeatedWorktree, worktreeBound);

        const directAgain = yield* application.bindWorkspace({
          binding,
          workspaceName: "ignored direct rename",
          configuration: { kind: "direct", cwd: secondCwd },
        });
        assert.deepStrictEqual(directAgain, { ...rebound, worktree: null });

        const newChat = yield* application.createChat({
          workspaceId: created.id,
          externalId: "thread-new",
          modelOverride: null,
        });
        assert.strictEqual(oldChat.cwd, firstCwd);
        assert.strictEqual(
          Option.getOrThrow(yield* chats.findById(oldChat.id).pipe(Effect.orDie)).cwd,
          firstCwd,
        );
        assert.strictEqual(newChat.cwd, secondCwd);
        assert.deepStrictEqual(
          createdSessions.map(({ cwd }) => cwd),
          [firstCwd, worktreeCwd, secondCwd],
        );

        const invalidBranch = yield* application
          .bindWorkspace({
            binding: { platform: "discord", externalId: "1.30" },
            workspaceName: "invalid branch",
            configuration: {
              kind: "worktree",
              repository: secondCwd,
              settings: { branch: "missing", prefix: "chat/" },
            },
          })
          .pipe(Effect.flip);
        if (!(invalidBranch instanceof WorkspaceBindingInvalid)) {
          return yield* Effect.die(`Unexpected bind failure: ${invalidBranch._tag}`);
        }
        assert.strictEqual(invalidBranch.issue.field, "branch");
        assert.strictEqual(invalidBranch.issue.reason, "not-commit");
        assert.isTrue(
          Option.isNone(yield* application.findWorkspaceByPlatformId("discord", "1.30")),
        );

        const invalidInputs: ReadonlyArray<{
          readonly externalId: string;
          readonly cwd: string;
          readonly reason: Extract<
            WorkspaceBindingInvalid["issue"],
            { readonly field: "cwd" }
          >["reason"];
        }> = [
          { externalId: "1.40", cwd: ` ${firstCwd}`, reason: "surrounding-whitespace" },
          { externalId: "1.41", cwd: "relative/project", reason: "not-absolute" },
          { externalId: "1.42", cwd: "~/project", reason: "not-absolute" },
          {
            externalId: "1.43",
            cwd: path.join(temporaryDirectory, "missing"),
            reason: "not-found",
          },
          { externalId: "1.44", cwd: file, reason: "not-directory" },
        ];
        for (const input of invalidInputs) {
          const error = yield* application
            .bindWorkspace({
              binding: { platform: "discord", externalId: input.externalId },
              workspaceName: input.externalId,
              configuration: { kind: "direct", cwd: input.cwd },
            })
            .pipe(Effect.flip);
          if (!(error instanceof WorkspaceBindingInvalid)) {
            return yield* Effect.die(`Unexpected bind failure: ${error._tag}`);
          }
          assert.strictEqual(error.issue.field, "cwd");
          assert.strictEqual(error.issue.reason, input.reason);
          assert.isTrue(
            Option.isNone(
              yield* application.findWorkspaceByPlatformId("discord", input.externalId),
            ),
          );
        }

        const unreadable = yield* application
          .bindWorkspace({
            binding: { platform: "discord", externalId: "1.45" },
            workspaceName: "unreadable",
            configuration: { kind: "direct", cwd: unreadableCwd },
          })
          .pipe(Effect.flip);
        if (!(unreadable instanceof WorkspaceBindingInvalid)) {
          return yield* Effect.die(`Unexpected bind failure: ${unreadable._tag}`);
        }
        assert.strictEqual(unreadable.issue.field, "cwd");
        assert.strictEqual(unreadable.issue.reason, "unreadable");
        assert.isTrue(
          Option.isNone(yield* application.findWorkspaceByPlatformId("discord", "1.45")),
        );
      }).pipe(
        Effect.provide(
          ApplicationLayer.layer(gitWorktree).pipe(Layer.provide(unusedSchedulesLayer)),
        ),
        Effect.provide(applicationFileSystemLayer),
        Effect.provide(persistenceLayer),
        Effect.provide(sessionsLayer),
        Effect.provide(runtimeLayer),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("message and bind creation races converge on the requested configuration", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-application-binding-race-",
      });
      const defaultCwd = AbsolutePath.make(path.join(temporaryDirectory, "default"));
      const repositoryCwd = AbsolutePath.make(path.join(temporaryDirectory, "repository"));
      const worktreeCwd = AbsolutePath.make(path.join(temporaryDirectory, "worktree"));
      yield* fileSystem.makeDirectory(defaultCwd);
      yield* fileSystem.makeDirectory(repositoryCwd);
      const settings = { branch: "main", prefix: "bound/" };
      const runtimeLayer = Layer.succeed(
        AgentRuntime,
        AgentRuntime.of({
          history: () => Effect.die("unexpected history read"),
          previewHistory: () => Effect.die("unexpected history preview"),
          navigateHistory: () => Effect.die("unexpected history navigation"),
          availableModels: () => Effect.die("unexpected model catalog read"),
          discoverSkills: () => Effect.die("unexpected workspace skill command discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          events: Stream.empty,
          drain: () => Effect.void,
          transcript: () => Effect.die("unexpected transcript read"),
          resultSummary: () => Effect.die("unexpected chat results read"),
          send: () => Effect.die("unexpected runtime send"),
          sendCaptured: () => Effect.die("unexpected captured runtime send"),
          deliver: () => Effect.die("unexpected scheduled delivery"),
          publish: () => Effect.die("unexpected scheduled publish"),
          abort: () => Effect.die("unexpected runtime abort"),
          contextUsage: () => Effect.die("unexpected runtime context read"),
          shake: () => Effect.die("unexpected runtime shake"),
          close: () => Effect.die("unexpected runtime close"),
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        }),
      );
      const sessionsLayer = Layer.succeed(
        AgentSessionStore,
        AgentSessionStore.of({
          create: () => Effect.void,
          readTitle: () => Effect.succeed(null),
          remove: () => Effect.void,
        }),
      );
      const gitWorktree: GitWorktree = {
        validate: () => Effect.void,
        create: (options, use) =>
          Effect.gen(function* () {
            assert.strictEqual(options.repositoryCwd, repositoryCwd);
            assert.deepStrictEqual(options.settings, settings);
            return yield* use(worktreeCwd);
          }),
        inspectChat: () => Effect.succeed({ kind: "not-managed" }),
        renameChatBranch: () => Effect.die("unexpected branch rename"),
        removeChat: () => Effect.die("unexpected worktree removal"),
      };

      for (const winner of ["message", "binding"] as const) {
        const waiting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const blockedName = winner === "message" ? "binding" : "message";
        const storeFile = AbsolutePath.make(path.join(temporaryDirectory, `${winner}.db`));
        const persistenceLayer = Persistence.layer(storeFile);
        const gatedWorkspaces = Layer.effect(
          WorkspaceRepository,
          Effect.gen(function* () {
            const repository = yield* WorkspaceRepository;
            return WorkspaceRepository.of({
              ...repository,
              getOrCreateByBinding: (candidate) =>
                Effect.gen(function* () {
                  if (candidate.name === blockedName) {
                    yield* Deferred.succeed(waiting, undefined);
                    yield* Deferred.await(release);
                  }
                  return yield* repository.getOrCreateByBinding(candidate);
                }),
            });
          }),
        ).pipe(Layer.provide(persistenceLayer));

        yield* Effect.gen(function* () {
          const application = yield* Application;
          const chats = yield* ChatRepository;
          const binding = Workspace.WorkspaceBinding.make({
            platform: "discord",
            externalId: winner === "message" ? "1.10" : "1.20",
          });
          const messageCreation = application.getOrCreateWorkspaceByBinding({
            name: "message",
            ...binding,
            defaultCwd,
            worktree: null,
          });
          const bind = application.bindWorkspace({
            binding,
            workspaceName: "binding",
            configuration: { kind: "worktree", repository: repositoryCwd, settings },
          });
          const blocked = yield* (winner === "message" ? bind : messageCreation).pipe(
            Effect.forkChild,
          );
          yield* Deferred.await(waiting);
          const first = yield* winner === "message" ? messageCreation : bind;
          const initialChat = yield* application.createChat({
            workspaceId: first.id,
            externalId: "before-release",
            modelOverride: null,
          });
          assert.strictEqual(initialChat.cwd, winner === "message" ? defaultCwd : worktreeCwd);

          yield* Deferred.succeed(release, undefined);
          const second = yield* Fiber.join(blocked);
          assert.strictEqual(second.id, first.id);
          assert.deepStrictEqual(second, {
            ...first,
            defaultCwd: repositoryCwd,
            worktree: settings,
          });
          assert.deepStrictEqual(
            Option.getOrThrow(
              yield* application.findWorkspaceByPlatformId("discord", binding.externalId),
            ),
            second,
          );
          const nextChat = yield* application.createChat({
            workspaceId: second.id,
            externalId: "after-release",
            modelOverride: null,
          });
          assert.strictEqual(nextChat.cwd, worktreeCwd);
          assert.strictEqual(
            Option.getOrThrow(yield* chats.findById(initialChat.id)).cwd,
            initialChat.cwd,
          );
        }).pipe(
          Effect.provide(
            ApplicationLayer.layer(gitWorktree).pipe(Layer.provide(unusedSchedulesLayer)),
          ),
          Effect.provide(Layer.merge(persistenceLayer, gatedWorkspaces)),
          Effect.provide(sessionsLayer),
          Effect.provide(runtimeLayer),
          Effect.provide(BunCrypto.layer),
          Effect.scoped,
        );
      }
    }).pipe(Effect.provide(platformLayer)),
  );
});
