import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import type * as AgentEvent from "@pico/contract/agent-event";
import * as AgentMessage from "@pico/contract/agent-message";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ApplicationError, ChatClosed } from "@pico/contract/errors";
import { type EventFilter, type EventRoute, EventRouter } from "@pico/contract/event-router";
import * as RpcClient from "@pico/rpc/client";
import * as RpcServer from "@pico/rpc/server";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";

const firstChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001");
const secondChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
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
  createWorkspace: () => Effect.die("unexpected workspace creation"),
  getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
  bindWorkspace: () => Effect.die("unexpected workspace binding"),
  createChat: () => Effect.die("unexpected chat creation"),
  findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
  findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
  findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
  transcript: () => Effect.die("unexpected transcript read"),
  sendMessage: () => Effect.die("unexpected message send"),
  abort: () => Effect.die("unexpected abort"),
  contextUsage: () => Effect.die("unexpected context read"),
  shake: () => Effect.die("unexpected chat shake"),
  closeChat: () => Effect.die("unexpected chat close"),
});

describe("RPC", () => {
  it.live("serves every procedure through one scoped WebSocket client", () =>
    Effect.gen(function* () {
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
      const eventsDelivered = yield* Deferred.make<void>();
      const routeFinalized = yield* Deferred.make<void>();
      const eventQueue = yield* Queue.unbounded<AgentEvent.AgentEventEnvelope>();
      const transcriptInputs: Array<Chat.ChatId> = [];
      const sendInputs: Array<{
        readonly chatId: Chat.ChatId;
        readonly prompt: AgentMessage.AgentPrompt;
      }> = [];
      const abortInputs: Array<Chat.ChatId> = [];
      const filters: Array<EventFilter> = [];

      const application = Application.of({
        ...unusedApplication,
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
        open: (filter) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              filters.push(filter);
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
      const services = Layer.merge(
        Layer.succeed(Application, application),
        Layer.succeed(EventRouter, eventRouter),
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
              if (received.length === 2) {
                yield* Deferred.succeed(eventsDelivered, undefined);
              }
            }),
          ),
          Effect.forkIn(clientScope),
        );
        yield* Deferred.await(routeOpened);
        assert.strictEqual(filters.length, 1);
        assert.isTrue(filters[0]?.(firstEvent));
        assert.isTrue(filters[0]?.(secondEvent));

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

        yield* Queue.offerAll(eventQueue, [firstEvent, secondEvent]);
        yield* Deferred.await(eventsDelivered);
        assert.deepStrictEqual(received, [firstEvent, secondEvent]);
        assert.isFalse(yield* Deferred.isDone(routeFinalized));

        yield* Scope.close(clientScope, Exit.void);
        yield* Deferred.await(routeFinalized);
        assert.strictEqual(failures().length, 1);
      }).pipe(
        Effect.scoped,
        Effect.provide(RpcServer.layer),
        Effect.provide(services),
        Effect.provide(NodeHttpServer.layerTest),
        Effect.provide(logger),
      );
    }),
  );

  for (const stage of ["acquisition", "execution"]) {
    it.live(`reports Events ${stage} defects once without logging stream content`, () =>
      Effect.gen(function* () {
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
          Effect.provide(RpcServer.layer),
          Effect.provide(
            Layer.merge(
              Layer.succeed(Application, unusedApplication),
              Layer.succeed(EventRouter, eventRouter),
            ),
          ),
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
      }),
    );
  }
});
