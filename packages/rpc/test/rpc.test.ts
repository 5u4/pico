import { Database } from "bun:sqlite";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import type * as AgentEvent from "@pico/contract/agent-event";
import { Publication } from "@pico/contract/agent-event";
import { HistoryRevision } from "@pico/contract/agent-history";
import * as AgentMessage from "@pico/contract/agent-message";
import type { ContextUsage, ShakeResult } from "@pico/contract/agent-runtime";
import type { TranscriptSnapshot } from "@pico/contract/agent-snapshot";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ApplicationError, ChatClosed } from "@pico/contract/errors";
import { type EventRoute, EventRouter } from "@pico/contract/event-router";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as RpcClient from "@pico/rpc/client";
import * as RpcServer from "@pico/rpc/server";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as Persistence from "../../persistence/src/layer.ts";
import * as ScheduleLayer from "../../schedule/src/schedule.ts";

const firstChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001");
const secondChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const foreignChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000003");
const newChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000004");
const missingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000099");
const workspaceId = (value: number) =>
  Workspace.WorkspaceId.make(`018f47a0-0000-7000-8000-${value.toString().padStart(12, "0")}`);
const webWorkspace: Workspace.Workspace = {
  id: workspaceId(1),
  name: "Web",
  defaultCwd: AbsolutePath.make("/tmp/pico-rpc"),
  worktree: null,
  modelOverride: null,
  platform: "web",
  externalId: null,
  createdAt: 1,
};
const discordWorkspace: Workspace.Workspace = {
  ...webWorkspace,
  id: workspaceId(20),
  platform: "discord",
  externalId: "1.2",
  createdAt: 20,
};

const ownershipFixture = Effect.fnUntraced(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-rpc-" });
  const storeFile = AbsolutePath.make(`${directory}/store.db`);
  const context = yield* Layer.build(Persistence.layer(storeFile));
  const workspaces = Context.get(context, WorkspaceRepository);
  const chats = Context.get(context, ChatRepository);
  yield* workspaces.create(webWorkspace);
  for (const id of [firstChatId, secondChatId]) {
    yield* chats.create({
      id,
      workspaceId: webWorkspace.id,
      cwd: webWorkspace.defaultCwd,
      externalId: null,
      createdAt: 1,
    });
  }
  const schedules = yield* ScheduleLayer.open(
    AbsolutePath.make(`${directory}/schedules`),
    (target) =>
      target.kind === "chat" || target.kind === "workspace"
        ? Effect.succeed(target)
        : Effect.fail(new Schedule.ScheduleHostError({ message: "Unexpected external target" })),
  ).pipe(Effect.provide(Layer.merge(BunCrypto.layer, BunPath.layer)));
  return {
    workspaces,
    chats,
    storeFile,
    schedules,
    fileSystem,
    directory,
    layer: Layer.merge(Layer.succeedContext(context), Layer.succeed(Schedule.Schedules, schedules)),
  };
}, Effect.provide(BunFileSystem.layer));
const transcript: TranscriptSnapshot = {
  messages: [
    {
      role: "assistant",
      id: AgentMessage.AgentMessageId.make("transcript-ready"),
      status: "completed",
      stopReason: "stop",
      content: [{ type: "text", text: "ready" }],
      model: "integration-test",
      timestamp: 1,
    },
  ],
  contextUsage: { kind: "unavailable" },
  historyRevision: HistoryRevision.make("test-history"),
  todo: { kind: "ready", phases: [] },
  runtime: { publication: Publication.make(0), run: { kind: "idle" }, assistant: [], tools: [] },
  currentModel: null,
};
const contextSnapshot: ContextUsage = {
  kind: "available",
  contextWindow: 200_000,
  usedTokens: 12_345,
  systemPromptTokens: 1_000,
  systemToolsTokens: 2_000,
  systemContextTokens: 3_000,
  skillsTokens: 4_000,
  messagesTokens: 2_345,
};
const firstEvent: AgentEvent.AgentEventEnvelope = {
  chatId: firstChatId,
  publication: Publication.make(1),
  origin: "session",
  event: { type: "notice", level: "info", message: "first" },
};
const secondEvent: AgentEvent.AgentEventEnvelope = {
  chatId: secondChatId,
  publication: Publication.make(2),
  origin: "session",
  event: { type: "title-changed", title: "Ship exchange titles" },
};

const unusedApplication = Application.of({
  history: () => Effect.die("unexpected history read"),
  previewHistory: () => Effect.die("unexpected history preview"),
  navigateHistory: () => Effect.die("unexpected history navigation"),
  deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
  updateWorkspace: () => Effect.die("unexpected workspace update"),
  listWorkspaces: () => Effect.die("unexpected workspace list"),
  askBtw: () => Effect.die("unexpected side question"),
  createWorkspace: () => Effect.die("unexpected workspace creation"),
  getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
  bindWorkspace: () => Effect.die("unexpected workspace binding"),
  listChats: () => Effect.die("unexpected chat list"),
  createChat: () => Effect.die("unexpected chat creation"),
  findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
  findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
  findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
  transcript: () => Effect.die("unexpected transcript read"),
  sendMessage: () => Effect.die("unexpected message send"),
  abort: () => Effect.die("unexpected abort"),
  contextUsage: () => Effect.die("unexpected context read"),
  availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
  setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
  availableModels: () => Effect.die("unexpected model discovery"),
  availableSkills: () => Effect.die("unexpected skill command discovery"),
  switchModel: () => Effect.die("unexpected model switch"),
  shake: () => Effect.die("unexpected chat shake"),
  closeChat: () => Effect.die("unexpected chat close"),
});

describe("RPC", () => {
  it.live("lists all schedule owners without granting access to foreign chats", () =>
    Effect.gen(function* () {
      const ownership = yield* ownershipFixture();
      const missingOwnerId = workspaceId(99);
      yield* ownership.workspaces.create(discordWorkspace);
      yield* ownership.chats.create({
        id: foreignChatId,
        workspaceId: discordWorkspace.id,
        cwd: discordWorkspace.defaultCwd,
        externalId: "foreign-thread",
        createdAt: 1,
      });
      const sourceDirectory = AbsolutePath.make(`${ownership.directory}/source`);
      yield* ownership.fileSystem.makeDirectory(sourceDirectory);
      yield* ownership.fileSystem.writeFileString(
        `${sourceDirectory}/prompt.md`,
        "Keep these instructions unchanged.",
      );
      const created = yield* ownership.schedules.create(
        { workspaceId: webWorkspace.id, chatId: firstChatId },
        {
          name: "Foreign destination",
          enabled: false,
          sourceDirectory,
          target: { kind: "workspace", workspaceId: discordWorkspace.id },
          trigger: { kind: "cron", expression: "0 9 * * *", timeZone: "Asia/Taipei" },
        },
      );
      const discord = yield* ownership.schedules.create(
        { workspaceId: discordWorkspace.id, chatId: foreignChatId },
        {
          name: "Discord schedule",
          enabled: true,
          sourceDirectory,
          target: { kind: "chat", chatId: foreignChatId },
          trigger: { kind: "cron", expression: "0 9 * * *", timeZone: "Asia/Taipei" },
        },
      );
      const missingOwner = yield* ownership.schedules.create(
        { workspaceId: missingOwnerId, chatId: missingChatId },
        {
          name: "Missing owner",
          enabled: false,
          sourceDirectory,
          target: { kind: "chat", chatId: missingChatId },
          trigger: { kind: "once", at: 1_000 },
        },
      );
      const unknownId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000088");
      const unknownDirectory = `${ownership.directory}/schedules/enabled/${unknownId}`;
      yield* ownership.fileSystem.makeDirectory(unknownDirectory);
      yield* ownership.fileSystem.writeFileString(
        `${unknownDirectory}/meta.json`,
        JSON.stringify({ version: 2, ownerWorkspaceId: "not-a-workspace-id" }),
      );
      const router = EventRouter.of({
        drain: () => Effect.void,
        open: () => Effect.die("unexpected events"),
      });
      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag === "UnixAddress") return yield* Effect.die("Expected TCP server");
        const host = server.address.hostname === "0.0.0.0" ? "127.0.0.1" : server.address.hostname;
        const client = yield* RpcClient.make(`ws://${host}:${server.address.port}/rpc`);
        const snapshot = yield* client.ListSchedules();
        const byId = new Map(snapshot.entries.map((entry) => [entry.view.id, entry]));
        assert.deepStrictEqual(
          [...byId.keys()].sort(),
          [created.id, discord.id, missingOwner.id, unknownId].sort(),
        );
        assert.deepStrictEqual(byId.get(created.id)?.owner, {
          id: webWorkspace.id,
          name: webWorkspace.name,
          platform: "web",
        });
        assert.deepStrictEqual(byId.get(discord.id)?.owner, {
          id: discordWorkspace.id,
          name: discordWorkspace.name,
          platform: "discord",
        });
        assert.strictEqual(byId.get(discord.id)?.nextTrigger.kind, "scheduled");
        assert.strictEqual(byId.get(missingOwner.id)?.ownerWorkspaceId, missingOwnerId);
        assert.isNull(byId.get(missingOwner.id)?.owner);
        assert.strictEqual(byId.get(unknownId)?.view.kind, "invalid");
        assert.isNull(byId.get(unknownId)?.ownerWorkspaceId);
        assert.isNull(byId.get(unknownId)?.owner);
        assert.deepStrictEqual(byId.get(unknownId)?.nextTrigger, {
          kind: "none",
          reason: "invalid",
        });
        assert.isFalse(JSON.stringify(snapshot).includes("Keep these instructions unchanged."));
        assert.instanceOf(
          yield* client.Transcript({ chatId: foreignChatId }).pipe(Effect.flip),
          ApplicationError,
        );
        assert.instanceOf(
          yield* client.ListChats({ workspaceId: discordWorkspace.id }).pipe(Effect.flip),
          ApplicationError,
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(HttpRouter.serve(RpcServer.routes)),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Application, unusedApplication),
            Layer.succeed(EventRouter, router),
            ownership.layer,
          ),
        ),
        Effect.provide(NodeHttpServer.layerTest),
      );
    }).pipe(Effect.scoped),
  );
  it.live("reports corrupt schedule history once without logging persisted payloads", () =>
    Effect.gen(function* () {
      const ownership = yield* ownershipFixture();
      const sourceDirectory = AbsolutePath.make(`${ownership.directory}/source`);
      yield* ownership.fileSystem.makeDirectory(sourceDirectory);
      yield* ownership.fileSystem.writeFileString(`${sourceDirectory}/prompt.md`, "Run the check.");
      const created = yield* ownership.schedules.create(
        { workspaceId: webWorkspace.id, chatId: firstChatId },
        {
          name: "Corrupt history",
          enabled: false,
          sourceDirectory,
          target: { kind: "chat", chatId: firstChatId },
          trigger: { kind: "once", at: 1_000 },
        },
      );
      if (created.kind !== "ready") return yield* Effect.die("Expected valid definition");
      const runDirectory = `${ownership.directory}/schedules/runs/${created.id}/scheduled-1000-${created.definition.revision}`;
      yield* ownership.fileSystem.makeDirectory(runDirectory, { recursive: true });
      yield* ownership.fileSystem.writeFileString(
        `${runDirectory}/run.json`,
        JSON.stringify({ private: "private-schedule-output" }),
      );
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const logger = Logger.layer([
        Logger.make((options) => {
          logs.push(Logger.formatStructured.log(options));
        }),
      ]);
      const router = EventRouter.of({
        drain: () => Effect.void,
        open: () => Effect.die("unexpected events"),
      });
      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag === "UnixAddress") return yield* Effect.die("Expected TCP server");
        const host = server.address.hostname === "0.0.0.0" ? "127.0.0.1" : server.address.hostname;
        const client = yield* RpcClient.make(`ws://${host}:${server.address.port}/rpc`);
        const error = yield* client.ListSchedules().pipe(Effect.flip);
        assert.instanceOf(error, Schedule.ScheduleError);
        assert.strictEqual(error.kind, "corrupt");
      }).pipe(
        Effect.scoped,
        Effect.provide(HttpRouter.serve(RpcServer.routes)),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Application, unusedApplication),
            Layer.succeed(EventRouter, router),
            ownership.layer,
          ),
        ),
        Effect.provide(NodeHttpServer.layerTest),
        Effect.provide(logger),
      );
      const failures = logs.filter((entry) => entry.level === "ERROR");
      assert.strictEqual(failures.length, 1);
      assert.deepInclude(failures[0]?.annotations, {
        component: "rpc",
        procedure: "ListSchedules",
      });
      assert.isString(failures[0]?.annotations.requestId);
      assert.notInclude(JSON.stringify(failures), "private-schedule-output");
    }).pipe(Effect.scoped),
  );

  it.live("reports unconfirmed model persistence while returning the selected model", () =>
    Effect.gen(function* () {
      const ownership = yield* ownershipFixture();
      const model = { provider: "pico-fixture", id: "selected", name: "Selected" };
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const logger = Logger.layer([
        Logger.make((options) => {
          logs.push(Logger.formatStructured.log(options));
        }),
      ]);
      const router = EventRouter.of({
        drain: () => Effect.void,
        open: () => Effect.die("unexpected events"),
      });
      const application = Application.of({
        ...unusedApplication,
        switchModel: () => Effect.succeed({ kind: "persistence-unconfirmed", model }),
      });
      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag === "UnixAddress") return yield* Effect.die("Expected TCP server");
        const host = server.address.hostname === "0.0.0.0" ? "127.0.0.1" : server.address.hostname;
        const client = yield* RpcClient.make(`ws://${host}:${server.address.port}/rpc`);
        assert.deepStrictEqual(yield* client.SwitchModel({ chatId: firstChatId, model }), {
          kind: "persistence-unconfirmed",
          model,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(HttpRouter.serve(RpcServer.routes)),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Application, application),
            Layer.succeed(EventRouter, router),
            ownership.layer,
          ),
        ),
        Effect.provide(NodeHttpServer.layerTest),
        Effect.provide(logger),
      );
      const warnings = logs.filter((entry) => entry.level === "WARN");
      assert.strictEqual(warnings.length, 1);
      assert.deepInclude(warnings[0]?.annotations, {
        component: "rpc",
        procedure: "SwitchModel",
        operation: "persist-model-selection",
        outcome: "failure",
      });
      assert.isString(warnings[0]?.annotations.requestId);
    }).pipe(Effect.scoped),
  );

  it.live("isolates web reads, mutations and live events through one scoped client", () =>
    Effect.gen(function* () {
      const ownership = yield* ownershipFixture();
      const newerWebWorkspace = { ...webWorkspace, id: workspaceId(2), createdAt: 2 };
      yield* ownership.workspaces.create(newerWebWorkspace);
      yield* ownership.workspaces.create(discordWorkspace);
      for (const [index, platform] of (["desktop", "mobile"] as const).entries()) {
        yield* ownership.workspaces.create({
          ...webWorkspace,
          id: workspaceId(index + 10),
          platform,
          createdAt: index + 10,
        });
      }
      for (const [index, platform] of (["telegram", "slack", "teams"] as const).entries()) {
        yield* ownership.workspaces.create({
          ...discordWorkspace,
          id: workspaceId(index + 21),
          platform,
          createdAt: index + 21,
        });
      }
      const foreignChat = yield* ownership.chats.create({
        id: foreignChatId,
        workspaceId: discordWorkspace.id,
        cwd: discordWorkspace.defaultCwd,
        externalId: "foreign-thread",
        createdAt: 1,
      });
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const logger = Logger.layer([
        Logger.make((options) => {
          logs.push(Logger.formatStructured.log(options));
        }),
      ]);
      const failures = () => logs.filter((entry) => entry.level === "ERROR");
      const sent = yield* Deferred.make<void>();
      const releaseSend = yield* Deferred.make<void>();
      const sendReturned = yield* Deferred.make<void>();
      const aborted = yield* Deferred.make<void>();
      const routeOpened = yield* Deferred.make<void>();
      const receivedEvents = yield* Queue.unbounded<AgentEvent.AgentEventEnvelope>();
      const routeFinalized = yield* Deferred.make<void>();
      const eventQueue = yield* Queue.unbounded<AgentEvent.AgentEventEnvelope>();
      const transcriptInputs: Array<Chat.ChatId> = [];
      const sendInputs: Array<{
        readonly chatId: Chat.ChatId;
        readonly prompt: AgentMessage.AgentPrompt;
      }> = [];
      const abortInputs: Array<Chat.ChatId> = [];
      const contextInputs: Array<Chat.ChatId> = [];

      const application = Application.of({
        ...unusedApplication,
        updateWorkspace: ({ workspaceId, configuration }) =>
          ownership.workspaces
            .replaceConfiguration(
              workspaceId,
              configuration.kind === "direct"
                ? { defaultCwd: AbsolutePath.make(configuration.cwd), worktree: null }
                : {
                    defaultCwd: AbsolutePath.make(configuration.repository),
                    worktree: configuration.settings,
                  },
            )
            .pipe(Effect.orDie),
        listWorkspaces: () => ownership.workspaces.list().pipe(Effect.orDie),
        listChats: (workspaceId) =>
          ownership.chats.listOpenByWorkspace(workspaceId).pipe(
            Effect.map((chats) =>
              chats.map((chat) => ({
                ...chat,
                title: chat.id === firstChatId ? "Persisted inventory review" : null,
              })),
            ),
            Effect.orDie,
          ),
        createChat: ({ workspaceId, externalId }) =>
          ownership.chats
            .create({
              id: newChatId,
              workspaceId,
              cwd: webWorkspace.defaultCwd,
              externalId,
              createdAt: 2,
            })
            .pipe(Effect.orDie),
        transcript: (chatId) =>
          chatId === secondChatId
            ? Effect.fail(
                new ApplicationError({
                  reason: "operation",
                  message: "Transcript storage unavailable",
                }),
              )
            : Effect.sync(() => {
                transcriptInputs.push(chatId);
                return transcript;
              }),
        contextUsage: (chatId) =>
          chatId === secondChatId
            ? Effect.fail(new ChatClosed())
            : Effect.sync(() => {
                contextInputs.push(chatId);
                return contextSnapshot;
              }),
        sendMessage: (chatId, prompt) =>
          chatId === secondChatId
            ? Effect.fail(new ChatClosed())
            : Effect.gen(function* () {
                sendInputs.push({ chatId, prompt });
                yield* Deferred.succeed(sent, undefined);
                return { kind: "started", completed: Deferred.await(releaseSend) } as const;
              }),
        abort: (chatId) =>
          chatId === firstChatId
            ? Effect.fail(new ApplicationError({ reason: "not-found", message: "Chat not found" }))
            : Effect.gen(function* () {
                abortInputs.push(chatId);
                yield* Deferred.succeed(aborted, undefined);
              }),
        shake: (chatId, mode) =>
          Effect.gen(function* () {
            if (chatId === secondChatId) return yield* new ChatClosed();
            if (mode !== "images") {
              return yield* new ApplicationError({
                reason: "operation",
                message: "Shake storage unavailable",
              });
            }
            return { mode, imagesDropped: 2, tokensFreed: 0 } satisfies ShakeResult;
          }),
      });
      const eventRouter = EventRouter.of({
        drain: () => Effect.void,
        open: () =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const route: EventRoute = {
                events: Stream.fromQueue(eventQueue),
                setFilter: () => Effect.die("unexpected filter update"),
              };
              yield* Deferred.succeed(routeOpened, undefined);
              return route;
            }),
            () => Deferred.succeed(routeFinalized, undefined),
          ),
      });
      const services = Layer.mergeAll(
        Layer.succeed(Application, application),
        Layer.succeed(EventRouter, eventRouter),
        ownership.layer,
      );

      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag === "UnixAddress") {
          return yield* Effect.die("Test server did not bind a TCP address");
        }

        const parentScope = yield* Effect.scope;
        const clientScope = yield* Scope.fork(parentScope);
        const hostname =
          server.address.hostname === "0.0.0.0" ? "127.0.0.1" : server.address.hostname;
        const client = yield* RpcClient.make(`ws://${hostname}:${server.address.port}/rpc`).pipe(
          Scope.provide(clientScope),
        );
        const received: Array<AgentEvent.AgentEventEnvelope> = [];

        yield* client.Events().pipe(
          Stream.filter((frame) => frame.kind === "event"),
          Stream.map((frame) => frame.envelope),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              received.push(event);
              yield* Queue.offer(receivedEvents, event);
            }),
          ),
          Effect.forkIn(clientScope),
        );
        yield* Deferred.await(routeOpened);
        assert.deepStrictEqual(yield* client.ListWorkspaces(), [newerWebWorkspace, webWorkspace]);
        assert.deepStrictEqual(
          yield* client.ListChats({ workspaceId: webWorkspace.id }),
          (yield* ownership.chats.listOpenByWorkspace(webWorkspace.id)).map((chat) => ({
            ...chat,
            title: chat.id === firstChatId ? "Persisted inventory review" : null,
          })),
        );
        const updatedCwd = AbsolutePath.make("/tmp/pico-rpc-updated");
        for (const id of [discordWorkspace.id, workspaceId(10), workspaceId(99)]) {
          const before = yield* ownership.workspaces.findById(id);
          for (const request of [
            client.ListChats({ workspaceId: id }).pipe(Effect.asVoid),
            client.CreateChat({ workspaceId: id, externalId: null }).pipe(Effect.asVoid),
            client.DeleteWorkspace({ workspaceId: id }),
            client
              .UpdateWorkspace({
                workspaceId: id,
                configuration: { kind: "direct", cwd: updatedCwd },
              })
              .pipe(Effect.asVoid),
          ]) {
            const rejected = yield* request.pipe(Effect.flip);
            assert.instanceOf(rejected, ApplicationError);
            assert.strictEqual(rejected.reason, "not-found");
          }
          assert.deepStrictEqual(yield* ownership.workspaces.findById(id), before);
        }
        yield* client.UpdateWorkspace({
          workspaceId: webWorkspace.id,
          configuration: { kind: "direct", cwd: updatedCwd },
        });
        assert.deepStrictEqual(
          yield* ownership.workspaces.findById(webWorkspace.id),
          Option.some({ ...webWorkspace, defaultCwd: updatedCwd }),
        );
        for (const chatId of [foreignChatId, missingChatId]) {
          for (const request of [
            client.Transcript({ chatId }).pipe(Effect.asVoid),
            client.ContextUsage({ chatId }).pipe(Effect.asVoid),
            client.AvailableModels({ chatId }).pipe(Effect.asVoid),
            client.AvailableSkills({ chatId }).pipe(Effect.asVoid),
            client
              .SwitchModel({
                chatId,
                model: { provider: "pico-fixture", id: "private" },
              })
              .pipe(Effect.asVoid),
            client.SendMessage({
              chatId,
              prompt: AgentMessage.AgentPrompt.make({ text: "foreign", attachments: [] }),
            }),
            client.Abort({ chatId }),
            client.CloseChat({ chatId, allowDirtyWorktree: true }).pipe(Effect.asVoid),
            client.Shake({ chatId, mode: "images" }).pipe(Effect.asVoid),
          ]) {
            const rejected = yield* request.pipe(Effect.flip);
            assert.instanceOf(rejected, ApplicationError);
            assert.strictEqual(rejected.reason, "not-found");
          }
        }
        assert.deepStrictEqual(transcriptInputs, []);
        assert.deepStrictEqual(sendInputs, []);
        assert.deepStrictEqual(abortInputs, []);
        assert.deepStrictEqual(contextInputs, []);
        assert.deepStrictEqual(yield* ownership.chats.listOpenByWorkspace(discordWorkspace.id), [
          foreignChat,
        ]);
        const creation = yield* client
          .CreateWorkspace({
            name: "Foreign",
            defaultCwd: webWorkspace.defaultCwd,
            platform: "discord",
            externalId: "3.4",
            worktree: null,
          })
          .pipe(Effect.flip);
        assert.instanceOf(creation, ApplicationError);
        assert.strictEqual(creation.reason, "invalid-state");

        assert.deepStrictEqual(
          yield* client.ContextUsage({ chatId: firstChatId }),
          contextSnapshot,
        );
        assert.deepStrictEqual(contextInputs, [firstChatId]);
        assert.instanceOf(
          yield* client.ContextUsage({ chatId: secondChatId }).pipe(Effect.flip),
          ChatClosed,
        );
        assert.deepStrictEqual(yield* client.Transcript({ chatId: firstChatId }), transcript);
        assert.deepStrictEqual(transcriptInputs, [firstChatId]);
        const operational = yield* client.Transcript({ chatId: secondChatId }).pipe(Effect.flip);
        assert.instanceOf(operational, ApplicationError);
        assert.strictEqual(operational.reason, "operation");
        assert.strictEqual(failures().length, 1);
        assert.deepInclude(failures()[0]?.annotations, {
          component: "rpc",
          procedure: "Transcript",
          chatId: secondChatId,
        });
        assert.isString(failures()[0]?.annotations.requestId);

        const prompt = AgentMessage.AgentPrompt.make({
          text: "ship it",
          attachments: [
            {
              type: "image",
              name: "ship.png",
              data: "iVBORw==",
              mimeType: "image/png",
            },
          ],
        });
        const sending = yield* client.SendMessage({ chatId: firstChatId, prompt }).pipe(
          Effect.tap(() => Deferred.succeed(sendReturned, undefined)),
          Effect.forkChild,
        );
        yield* Deferred.await(sent);
        assert.deepStrictEqual(yield* client.Shake({ chatId: firstChatId, mode: "images" }), {
          mode: "images",
          imagesDropped: 2,
          tokensFreed: 0,
        });
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(sendReturned));
        yield* Deferred.succeed(releaseSend, undefined);
        assert.isUndefined(yield* Fiber.join(sending));
        assert.deepStrictEqual(sendInputs, [{ chatId: firstChatId, prompt }]);
        assert.instanceOf(
          yield* client
            .SendMessage({
              chatId: secondChatId,
              prompt: AgentMessage.AgentPrompt.make({ text: "too late", attachments: [] }),
            })
            .pipe(Effect.flip),
          ChatClosed,
        );
        assert.instanceOf(
          yield* client.Shake({ chatId: secondChatId, mode: "images" }).pipe(Effect.flip),
          ChatClosed,
        );
        const shakeFailure = yield* client
          .Shake({ chatId: firstChatId, mode: "elide" })
          .pipe(Effect.flip);
        assert.instanceOf(shakeFailure, ApplicationError);
        assert.strictEqual(shakeFailure.reason, "operation");
        assert.strictEqual(failures().length, 2);
        assert.deepInclude(failures()[1]?.annotations, {
          component: "rpc",
          procedure: "Shake",
          chatId: firstChatId,
        });
        assert.isString(failures()[1]?.annotations.requestId);

        yield* client.Abort({ chatId: secondChatId });
        yield* Deferred.await(aborted);
        assert.deepStrictEqual(abortInputs, [secondChatId]);
        const rejected = yield* client.Abort({ chatId: firstChatId }).pipe(Effect.flip);
        assert.instanceOf(rejected, ApplicationError);
        assert.strictEqual(rejected.reason, "not-found");

        yield* ownership.chats.archive(firstChatId, 2);
        assert.deepStrictEqual(yield* client.Transcript({ chatId: firstChatId }), transcript);
        yield* Queue.offerAll(eventQueue, [
          {
            chatId: newChatId,
            event: { type: "notice", level: "info", message: "too early" },
            publication: Publication.make(3),
            origin: "session",
          },
          {
            chatId: foreignChatId,
            event: { type: "notice", level: "info", message: "private" },
            publication: Publication.make(4),
            origin: "session",
          },
          firstEvent,
        ]);
        assert.deepStrictEqual(yield* Queue.take(receivedEvents), firstEvent);
        const created = yield* client.CreateChat({
          workspaceId: webWorkspace.id,
          externalId: null,
        });
        assert.strictEqual(created.id, newChatId);
        const createdEvent: AgentEvent.AgentEventEnvelope = {
          chatId: created.id,
          publication: Publication.make(5),
          origin: "session",
          event: {
            type: "text-delta",
            messageId: AgentMessage.AgentMessageId.make("new-web-chat"),
            contentIndex: 0,
            text: "new web chat",
          },
        };
        yield* Queue.offerAll(eventQueue, [createdEvent, secondEvent]);
        assert.deepStrictEqual(yield* Queue.take(receivedEvents), createdEvent);
        assert.deepStrictEqual(yield* Queue.take(receivedEvents), secondEvent);
        assert.deepStrictEqual(received, [firstEvent, createdEvent, secondEvent]);
        assert.isFalse(yield* Deferred.isDone(routeFinalized));

        yield* Scope.close(clientScope, Exit.void);
        yield* Deferred.await(routeFinalized);
        assert.strictEqual(failures().length, 2);
      }).pipe(
        Effect.scoped,
        Effect.provide(HttpRouter.serve(RpcServer.routes)),
        Effect.provide(services),
        Effect.provide(NodeHttpServer.layerTest),
        Effect.provide(logger),
      );
    }).pipe(Effect.scoped),
  );

  it.live("fails closed on database errors and releases the Events route", () =>
    Effect.gen(function* () {
      const ownership = yield* ownershipFixture();
      const database = yield* Effect.acquireRelease(
        Effect.sync(() => new Database(ownership.storeFile)),
        (database) => Effect.sync(() => database.close()),
      );
      const queue = yield* Queue.unbounded<AgentEvent.AgentEventEnvelope>();
      const opened = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      const router = EventRouter.of({
        drain: () => Effect.void,
        open: () =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Deferred.succeed(opened, undefined);
              return {
                events: Stream.fromQueue(queue),
                setFilter: () => Effect.die("unexpected filter change"),
              };
            }),
            () => Deferred.succeed(closed, undefined),
          ),
      });
      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag === "UnixAddress") return yield* Effect.die("Expected TCP server");
        const host = server.address.hostname === "0.0.0.0" ? "127.0.0.1" : server.address.hostname;
        const client = yield* RpcClient.make(`ws://${host}:${server.address.port}/rpc`);
        const received: Array<AgentEvent.AgentEventEnvelope> = [];
        const subscription = yield* client.Events().pipe(
          Stream.filter((frame) => frame.kind === "event"),
          Stream.map((frame) => frame.envelope),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              received.push(event);
            }),
          ),
          Effect.exit,
          Effect.forkChild,
        );
        yield* Deferred.await(opened);
        yield* Effect.sync(() => database.run("DROP TABLE chats"));
        const chatRead = yield* client.Transcript({ chatId: firstChatId }).pipe(Effect.flip);
        assert.instanceOf(chatRead, ApplicationError);
        assert.strictEqual(chatRead.reason, "operation");
        const shake = yield* client
          .Shake({ chatId: firstChatId, mode: "images" })
          .pipe(Effect.flip);
        assert.instanceOf(shake, ApplicationError);
        assert.strictEqual(shake.reason, "operation");
        yield* Queue.offer(queue, firstEvent);
        const exit = yield* Fiber.join(subscription);
        if (Exit.isSuccess(exit)) return yield* Effect.die("Expected ownership failure");
        const streamError = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        assert.instanceOf(streamError, ApplicationError);
        assert.strictEqual(streamError.reason, "operation");
        assert.deepStrictEqual(received, []);
        yield* Deferred.await(closed);
        yield* Effect.sync(() => database.run("DROP TABLE workspaces"));
        const workspaceRead = yield* client
          .ListChats({
            workspaceId: webWorkspace.id,
          })
          .pipe(Effect.flip);
        assert.instanceOf(workspaceRead, ApplicationError);
        assert.strictEqual(workspaceRead.reason, "operation");
      }).pipe(
        Effect.scoped,
        Effect.provide(HttpRouter.serve(RpcServer.routes)),
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Application, unusedApplication),
            Layer.succeed(EventRouter, router),
            ownership.layer,
          ),
        ),
        Effect.provide(NodeHttpServer.layerTest),
      );
    }).pipe(Effect.scoped),
  );

  for (const stage of ["acquisition", "execution"]) {
    it.live(`reports Events ${stage} defects once without logging stream content`, () =>
      Effect.gen(function* () {
        const ownership = yield* ownershipFixture();
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const logger = Logger.layer([
          Logger.make((options) => {
            logs.push(Logger.formatStructured.log(options));
          }),
        ]);
        const defect = new Error("private-stream-content");
        const eventRouter = EventRouter.of({
          drain: () => Effect.void,
          open: () =>
            stage === "acquisition"
              ? Effect.die(defect)
              : Effect.succeed({
                  events: Stream.make(firstEvent).pipe(Stream.concat(Stream.die(defect))),
                  setFilter: () => Effect.void,
                }),
        });
        const { exit, received } = yield* Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          if (server.address._tag === "UnixAddress")
            return yield* Effect.die("Expected TCP server");
          const hostname =
            server.address.hostname === "0.0.0.0" ? "127.0.0.1" : server.address.hostname;
          const client = yield* RpcClient.make(`ws://${hostname}:${server.address.port}/rpc`);
          const received: Array<AgentEvent.AgentEventEnvelope> = [];
          const exit = yield* client.Events().pipe(
            Stream.filter((frame) => frame.kind === "event"),
            Stream.map((frame) => frame.envelope),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                received.push(event);
              }),
            ),
            Effect.exit,
          );
          return { exit, received };
        }).pipe(
          Effect.scoped,
          Effect.provide(HttpRouter.serve(RpcServer.routes)),
          Effect.provide(
            Layer.merge(
              Layer.succeed(Application, unusedApplication),
              Layer.succeed(EventRouter, eventRouter),
            ),
          ),
          Effect.provide(ownership.layer),
          Effect.provide(NodeHttpServer.layerTest),
          Effect.provide(logger),
        );
        assert.isTrue(Exit.hasDies(exit));
        assert.deepStrictEqual(received, stage === "execution" ? [firstEvent] : []);
        const failures = logs.filter((entry) => entry.level === "ERROR");
        assert.strictEqual(failures.length, 1);
        assert.deepInclude(failures[0]?.annotations, { component: "rpc", procedure: "Events" });
        assert.isString(failures[0]?.annotations.requestId);
        assert.notInclude(JSON.stringify(failures), "private-stream-content");
      }).pipe(Effect.scoped),
    );
  }
});
