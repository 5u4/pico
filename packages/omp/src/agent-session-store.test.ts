import { rm } from "node:fs/promises";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import * as ApplicationLayer from "@pico/application/layer";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { AgentError, ApplicationError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import * as Persistence from "@pico/persistence/layer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterAll, vi } from "vitest";
import { unusedSchedulesLayer } from "../../application/src/test-schedules.ts";
import { layer } from "./agent-session-store.ts";

const sdkRoot = await vi.hoisted(async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pico-journal-sdk-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("OMP_PROFILE", "default");
  vi.stubEnv("PI_PROFILE", "default");
  return root;
});

afterAll(async () => {
  resetSessionIndexForTests();
  vi.unstubAllEnvs();
  await rm(sdkRoot, { recursive: true, force: true });
});

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001");

describe("AgentSessionStore", () => {
  it.effect(
    "lists renamed journal titles in fresh applications without opening live sessions",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-durable-chat-titles-",
        });
        const sessionsDir = AbsolutePath.make(path.join(directory, "sessions"));
        const cwd = AbsolutePath.make(path.join(directory, "workspace"));
        yield* fileSystem.makeDirectory(cwd);
        const unused = () => Effect.die("Unexpected live session operation");
        const runtime = AgentRuntime.of({
          history: () => Effect.die("unexpected history read"),
          previewHistory: () => Effect.die("unexpected history preview"),
          navigateHistory: () => Effect.die("unexpected history navigation"),
          events: Stream.empty,
          drain: () => Effect.void,
          transcript: unused,
          send: unused,
          askBtw: unused,
          sendCaptured: unused,
          deliver: unused,
          publish: unused,
          close: unused,
          abort: unused,
          contextUsage: unused,
          availableModels: unused,
          discoverSkills: () => Effect.die("unexpected workspace skill command discovery"),
          switchModel: unused,
          shake: unused,
          availableSkills: () => Effect.die("unexpected skill command discovery"),
        });
        const applicationLayer = ApplicationLayer.layer({
          validate: () => Effect.void,
          create: unused,
          inspectChat: unused,
          renameChatBranch: unused,
          removeChat: unused,
        })
          .pipe(Layer.provide(unusedSchedulesLayer))
          .pipe(
            Layer.provide(
              Layer.mergeAll(
                Persistence.layer(AbsolutePath.make(path.join(directory, "store.db"))),
                layer(sessionsDir),
                Layer.succeed(AgentRuntime, runtime),
              ),
            ),
          );
        const saved = yield* Effect.gen(function* () {
          const application = yield* Application;
          const workspace = yield* application.createWorkspace({
            name: "Saved chats",
            platform: "web",
            externalId: null,
            defaultCwd: cwd,
            worktree: null,
          });
          yield* TestClock.setTime(1_000);
          const titled = yield* application.createChat({
            workspaceId: workspace.id,
            externalId: null,
            modelOverride: null,
          });
          yield* TestClock.setTime(2_000);
          const untitled = yield* application.createChat({
            workspaceId: workspace.id,
            externalId: null,
            modelOverride: null,
          });
          yield* TestClock.setTime(3_000);
          const missing = yield* application.createChat({
            workspaceId: workspace.id,
            externalId: null,
            modelOverride: null,
          });
          return { workspace, titled, untitled, missing };
        }).pipe(Effect.provide(applicationLayer), Effect.scoped);
        const journalFile = (id: Chat.ChatId) => path.join(sessionsDir, `${id}.jsonl`);
        yield* fileSystem.remove(journalFile(saved.missing.id));
        const listChats = Effect.gen(function* () {
          return yield* (yield* Application).listChats(saved.workspace.id);
        }).pipe(Effect.provide(applicationLayer), Effect.scoped);
        for (const title of ["Original inventory review", "Renamed inventory review"]) {
          yield* Effect.acquireUseRelease(
            Effect.promise(() =>
              SessionManager.open(journalFile(saved.titled.id), sessionsDir, undefined, {
                suppressBreadcrumb: true,
              }),
            ),
            (manager) =>
              Effect.promise(async () => {
                assert.isTrue(await manager.setSessionName(title, "user"));
                await manager.flush();
              }),
            (manager) => Effect.promise(() => manager.close()),
          );
          const titledJournal = yield* fileSystem.readFile(journalFile(saved.titled.id));
          const untitledJournal = yield* fileSystem.readFile(journalFile(saved.untitled.id));
          assert.deepStrictEqual(yield* listChats, [
            { ...saved.missing, title: null },
            { ...saved.untitled, title: null },
            { ...saved.titled, title },
          ]);
          assert.deepStrictEqual(
            yield* fileSystem.readFile(journalFile(saved.titled.id)),
            titledJournal,
          );
          assert.deepStrictEqual(
            yield* fileSystem.readFile(journalFile(saved.untitled.id)),
            untitledJournal,
          );
          assert.isFalse(yield* fileSystem.exists(journalFile(saved.missing.id)));
        }
        yield* fileSystem.remove(journalFile(saved.titled.id));
        yield* fileSystem.makeDirectory(journalFile(saved.titled.id));
        const error = yield* listChats.pipe(Effect.flip);
        assert.instanceOf(error, ApplicationError);
        assert.strictEqual(error.reason, "operation");
      }).pipe(Effect.provide(Layer.merge(platformLayer, BunCrypto.layer)), Effect.scoped),
  );

  it.effect("reads only usable leading headers and refines journal I/O errors", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-journal-title-headers-",
      });
      const sessionsDir = AbsolutePath.make(path.join(directory, "sessions"));
      const sessionFile = path.join(sessionsDir, `${chatId}.jsonl`);
      const header = {
        type: "session",
        id: chatId,
        cwd: directory,
        timestamp: "2026-09-15T00:00:00.000Z",
        title: "Legacy title",
      };
      const titledHeader = JSON.stringify(header);
      const clearedSlot = serializeTitleSlot({ updatedAt: header.timestamp });
      const cases = [
        { content: "", title: null },
        { content: titledHeader, title: "Legacy title" },
        {
          content: `${JSON.stringify({ ...header, cwd: `/${"x".repeat(1024 * 1024)}` })}\n`,
          title: "Legacy title",
        },
        { content: `${clearedSlot}${titledHeader}\n`, title: null },
        { content: `${clearedSlot}null\n${titledHeader}\n`, title: null },
        { content: `{"broken":\n${titledHeader}\n`, title: null },
        {
          content: `${JSON.stringify({ ...header, type: "message" })}\n${titledHeader}\n`,
          title: null,
        },
      ];
      yield* Effect.gen(function* () {
        const sessions = yield* AgentSessionStore;
        assert.isNull(yield* sessions.readTitle(chatId));
        assert.isFalse(yield* fileSystem.exists(sessionFile));
        for (const fixture of cases) {
          yield* fileSystem.writeFileString(sessionFile, fixture.content);
          assert.strictEqual(yield* sessions.readTitle(chatId), fixture.title);
          assert.strictEqual(yield* fileSystem.readFileString(sessionFile), fixture.content);
        }
        yield* fileSystem.remove(sessionFile);
        yield* fileSystem.makeDirectory(sessionFile);
        assert.instanceOf(yield* sessions.readTitle(chatId).pipe(Effect.flip), AgentError);
      }).pipe(Effect.provide(layer(sessionsDir)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("snapshots workspace models before first use without rewriting unread chats", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-workspace-model-journals-",
      });
      const sessionsDir = AbsolutePath.make(path.join(directory, "sessions"));
      const firstCwd = AbsolutePath.make(path.join(directory, "first"));
      const secondCwd = AbsolutePath.make(path.join(directory, "second"));
      const worktreeCwd = AbsolutePath.make(path.join(directory, "worktree"));
      yield* fileSystem.makeDirectory(firstCwd);
      yield* fileSystem.makeDirectory(secondCwd);
      yield* fileSystem.makeDirectory(worktreeCwd);
      const firstModel = { provider: "native", id: "first", name: "First" };
      const secondModel = { provider: "native", id: "second", name: "Second" };
      const unused = () => Effect.die("Unexpected live session operation");
      const runtime = AgentRuntime.of({
        history: () => Effect.die("unexpected history read"),
        previewHistory: () => Effect.die("unexpected history preview"),
        navigateHistory: () => Effect.die("unexpected history navigation"),
        events: Stream.empty,
        drain: () => Effect.void,
        transcript: unused,
        send: unused,
        askBtw: unused,
        sendCaptured: unused,
        deliver: unused,
        publish: unused,
        close: unused,
        abort: unused,
        contextUsage: unused,
        availableModels: (cwd) => Effect.succeed(cwd === firstCwd ? [firstModel] : [secondModel]),
        discoverSkills: () => Effect.die("unexpected workspace skill command discovery"),
        switchModel: unused,
        shake: unused,
        availableSkills: () => Effect.die("unexpected skill command discovery"),
      });
      const dependencies = Layer.mergeAll(
        Persistence.layer(AbsolutePath.make(path.join(directory, "store.db"))),
        layer(sessionsDir),
        Layer.succeed(AgentRuntime, runtime),
      );
      const applicationLayer = ApplicationLayer.layer({
        validate: () => Effect.void,
        create: (_options, use) => use(worktreeCwd),
        inspectChat: unused,
        renameChatBranch: unused,
        removeChat: unused,
      })
        .pipe(Layer.provide(unusedSchedulesLayer))
        .pipe(Layer.provide(dependencies));
      const journalFile = (id: Chat.ChatId) => path.join(sessionsDir, `${id}.jsonl`);
      const restoredModels = Effect.fn("test.restoredModels")(function* (id: Chat.ChatId) {
        return yield* Effect.acquireUseRelease(
          Effect.promise(() =>
            SessionManager.open(journalFile(id), sessionsDir, undefined, {
              suppressBreadcrumb: true,
            }),
          ),
          (manager) =>
            Effect.sync(() => {
              const context = manager.buildSessionContext();
              assert.deepStrictEqual(context.messages, []);
              return getRestorableSessionModels(context.models, manager.getLastModelChangeRole());
            }),
          (manager) => Effect.promise(() => manager.close()),
        );
      });
      yield* Effect.gen(function* () {
        const application = yield* Application;
        const binding = Workspace.WorkspaceBinding.make({
          platform: "discord",
          externalId: "1.10",
        });
        assert.deepStrictEqual(
          yield* application.availableWorkspaceModels({
            kind: "binding",
            binding,
            defaultCwd: firstCwd,
          }),
          [firstModel],
        );
        assert.deepStrictEqual(yield* application.listWorkspaces(), []);
        assert.deepStrictEqual(yield* fileSystem.readDirectory(sessionsDir), []);
        const workspace = yield* application.getOrCreateWorkspaceByBinding({
          ...binding,
          name: "channel",
          defaultCwd: firstCwd,
          worktree: null,
        });
        const old = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
          modelOverride: null,
        });
        const oldJournal = yield* fileSystem.readFile(journalFile(old.id));
        yield* application.setWorkspaceModel(workspace.id, firstModel);
        const first = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
          modelOverride: null,
        });
        const firstJournal = yield* fileSystem.readFile(journalFile(first.id));
        yield* application.setWorkspaceModel(workspace.id, secondModel);
        const explicit = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
          modelOverride: firstModel,
        });
        assert.deepStrictEqual(yield* restoredModels(explicit.id), ["native/first"]);
        yield* application.bindWorkspace({
          binding,
          workspaceName: "channel",
          configuration: {
            kind: "worktree",
            repository: secondCwd,
            settings: { branch: "main", prefix: "chat/" },
          },
        });
        assert.deepStrictEqual(
          yield* application.availableWorkspaceModels({
            kind: "binding",
            binding,
            defaultCwd: firstCwd,
          }),
          [secondModel],
        );
        assert.deepStrictEqual(yield* application.availableModels(old.id), [firstModel]);
        const journalsBefore = yield* fileSystem.readDirectory(sessionsDir);
        const rejected = yield* application
          .createChat({
            workspaceId: workspace.id,
            externalId: null,
            modelOverride: firstModel,
          })
          .pipe(Effect.flip);
        assert.instanceOf(rejected, ApplicationError);
        assert.strictEqual(rejected.reason, "invalid-state");
        assert.deepStrictEqual(
          (yield* application.listChats(workspace.id)).map((chat) => chat.id).sort(),
          [old.id, first.id, explicit.id].sort(),
        );
        assert.deepStrictEqual(
          (yield* fileSystem.readDirectory(sessionsDir)).sort(),
          journalsBefore.sort(),
        );
        const second = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
          modelOverride: null,
        });
        yield* application.setWorkspaceModel(workspace.id, null);
        const cleared = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
          modelOverride: null,
        });
        assert.deepStrictEqual(yield* fileSystem.readFile(journalFile(old.id)), oldJournal);
        assert.deepStrictEqual(yield* fileSystem.readFile(journalFile(first.id)), firstJournal);
        assert.deepStrictEqual(yield* restoredModels(old.id), []);
        assert.deepStrictEqual(yield* restoredModels(first.id), ["native/first"]);
        assert.deepStrictEqual(yield* restoredModels(second.id), ["native/second"]);
        assert.deepStrictEqual(yield* restoredModels(cleared.id), []);
      }).pipe(Effect.provide(applicationLayer));
    }).pipe(Effect.provide(Layer.merge(platformLayer, BunCrypto.layer)), Effect.scoped),
  );

  it.effect("creates, removes, and preserves an OMP journal on collision", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-omp-session-store-",
      });
      const sessionsDir = AbsolutePath.make(path.join(temporaryDirectory, "sessions"));
      const cwd = AbsolutePath.make(path.join(temporaryDirectory, "workspace"));
      const sessionFile = path.join(sessionsDir, `${chatId}.jsonl`);
      const attachmentsDirectory = path.join(sessionsDir, chatId, "attachments");
      const attachmentFile = path.join(attachmentsDirectory, "original.png");

      yield* Effect.gen(function* () {
        const sessions = yield* AgentSessionStore;
        yield* sessions.create({ chatId, cwd, modelOverride: null });

        const content = yield* fileSystem.readFileString(sessionFile);
        const loaded = parseSessionContent(content);
        assert.isFalse(loaded.invalidHeader);
        const header = loaded.entries[0];
        if (header?.type !== "session") return yield* Effect.die("missing OMP session header");
        assert.strictEqual(header.cwd, cwd);

        yield* fileSystem.makeDirectory(attachmentsDirectory, { recursive: true, mode: 0o700 });
        yield* fileSystem.writeFile(attachmentFile, Uint8Array.from([1, 2, 3]), { mode: 0o600 });
        const beforeCollision = yield* fileSystem.readFile(sessionFile);
        assert.instanceOf(
          yield* sessions.create({ chatId, cwd, modelOverride: null }).pipe(Effect.flip),
          AgentError,
        );
        assert.deepStrictEqual(yield* fileSystem.readFile(sessionFile), beforeCollision);
        assert.deepStrictEqual(
          yield* fileSystem.readFile(attachmentFile),
          Uint8Array.from([1, 2, 3]),
        );
        yield* sessions.remove(chatId);
        assert.isFalse(yield* fileSystem.exists(sessionFile));
        assert.isFalse(yield* fileSystem.exists(path.join(sessionsDir, chatId)));
        yield* sessions.remove(chatId);
      }).pipe(Effect.provide(layer(sessionsDir)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
