import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as ApplicationLayer from "@pico/application/layer";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import * as Persistence from "@pico/persistence/layer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { layer } from "./agent-session-store.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001");

describe("AgentSessionStore", () => {
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
        switchModel: unused,
        shake: unused,
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
      }).pipe(Layer.provide(dependencies));
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
          yield* application.availableWorkspaceModels({ binding, defaultCwd: firstCwd }),
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
        const old = yield* application.createChat({ workspaceId: workspace.id, externalId: null });
        const oldJournal = yield* fileSystem.readFile(journalFile(old.id));
        yield* application.setWorkspaceModel(workspace.id, firstModel);
        const first = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
        });
        const firstJournal = yield* fileSystem.readFile(journalFile(first.id));
        yield* application.setWorkspaceModel(workspace.id, secondModel);
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
          yield* application.availableWorkspaceModels({ binding, defaultCwd: firstCwd }),
          [secondModel],
        );
        assert.deepStrictEqual(yield* application.availableModels(old.id), [firstModel]);
        const second = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
        });
        yield* application.setWorkspaceModel(workspace.id, null);
        const cleared = yield* application.createChat({
          workspaceId: workspace.id,
          externalId: null,
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
