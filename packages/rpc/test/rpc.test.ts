import { Database } from "bun:sqlite";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import type * as AgentEvent from "@pico/contract/agent-event";
import * as AgentMessage from "@pico/contract/agent-message";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ApplicationError, ChatClosed } from "@pico/contract/errors";
import { type EventRoute, EventRouter } from "@pico/contract/event-router";
import { AbsolutePath } from "@pico/contract/path";
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
  return { workspaces, chats, storeFile, layer: Layer.succeedContext(context) };
}, Effect.provide(BunFileSystem.layer));
const transcript: AgentMessage.AgentTranscript = [
  {
    role: "assistant",
    status: "completed",
    stopReason: "stop",
    content: [{ type: "text", text: "ready" }],
    model: "integration-test",
    timestamp: 1,
  },
];
const firstEvent: AgentEvent.AgentEventEnvelope = {
  chatId: firstChatId,
  event: { type: "notice", level: "info", message: "first" },
};
const secondEvent: AgentEvent.AgentEventEnvelope = {
  chatId: secondChatId,
  event: { type: "title-changed", title: "Ship exchange titles" },
};

const unusedApplication = Application.of({
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
  switchModel: () => Effect.die("unexpected model switch"),
  shake: () => Effect.die("unexpected chat shake"),
  closeChat: () => Effect.die("unexpected chat close"),
});

describe("RPC", () => {
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

      const application = Application.of({
        ...unusedApplication,
        listWorkspaces: () => ownership.workspaces.list().pipe(Effect.orDie),
        listChats: (workspaceId) =>
          ownership.chats.listOpenByWorkspace(workspaceId).pipe(Effect.orDie),
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
          yield* ownership.chats.listOpenByWorkspace(webWorkspace.id),
        );
        for (const id of [discordWorkspace.id, workspaceId(10), workspaceId(99)]) {
          for (const request of [
            client.ListChats({ workspaceId: id }).pipe(Effect.asVoid),
            client.CreateChat({ workspaceId: id, externalId: null }).pipe(Effect.asVoid),
          ]) {
            const rejected = yield* request.pipe(Effect.flip);
            assert.instanceOf(rejected, ApplicationError);
            assert.strictEqual(rejected.reason, "not-found");
          }
        }
        for (const chatId of [foreignChatId, missingChatId]) {
          for (const request of [
            client.Transcript({ chatId }).pipe(Effect.asVoid),
            client.SendMessage({
              chatId,
              prompt: AgentMessage.AgentPrompt.make({ text: "foreign", attachments: [] }),
            }),
            client.Abort({ chatId }),
          ]) {
            const rejected = yield* request.pipe(Effect.flip);
            assert.instanceOf(rejected, ApplicationError);
            assert.strictEqual(rejected.reason, "not-found");
          }
        }
        assert.deepStrictEqual(transcriptInputs, []);
        assert.deepStrictEqual(sendInputs, []);
        assert.deepStrictEqual(abortInputs, []);
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

        yield* client.Abort({ chatId: secondChatId });
        yield* Deferred.await(aborted);
        assert.deepStrictEqual(abortInputs, [secondChatId]);
        const rejected = yield* client.Abort({ chatId: firstChatId }).pipe(Effect.flip);
        assert.instanceOf(rejected, ApplicationError);
        assert.strictEqual(rejected.reason, "not-found");

        yield* ownership.chats.archive(firstChatId, 2);
        assert.deepStrictEqual(yield* client.Transcript({ chatId: firstChatId }), transcript);
        yield* Queue.offerAll(eventQueue, [
          { chatId: newChatId, event: { type: "notice", level: "info", message: "too early" } },
          { chatId: foreignChatId, event: { type: "notice", level: "info", message: "private" } },
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
          event: { type: "text-delta", contentIndex: 0, text: "new web chat" },
        };
        yield* Queue.offerAll(eventQueue, [createdEvent, secondEvent]);
        assert.deepStrictEqual(yield* Queue.take(receivedEvents), createdEvent);
        assert.deepStrictEqual(yield* Queue.take(receivedEvents), secondEvent);
        assert.deepStrictEqual(received, [firstEvent, createdEvent, secondEvent]);
        assert.isFalse(yield* Deferred.isDone(routeFinalized));

        yield* Scope.close(clientScope, Exit.void);
        yield* Deferred.await(routeFinalized);
        assert.strictEqual(failures().length, 1);
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
