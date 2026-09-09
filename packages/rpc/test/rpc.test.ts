import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import type * as AgentEvent from "@pico/contract/agent-event";
import type * as AgentMessage from "@pico/contract/agent-message";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { type EventFilter, type EventRoute, EventRouter } from "@pico/contract/event-router";
import * as RpcClient from "@pico/rpc/client";
import * as RpcServer from "@pico/rpc/server";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
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

describe("RPC", () => {
  it.live("serves every procedure through one scoped WebSocket client", () =>
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
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
        createWorkspace: () => Effect.die("unexpected workspace creation"),
        bindWorkspace: () => Effect.die("unexpected workspace binding"),
        createChat: () => Effect.die("unexpected chat creation"),
        findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
        findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
        transcript: (chatId) =>
          Effect.sync(() => {
            transcriptInputs.push(chatId);
            return transcript;
          }),
        sendMessage: (chatId, prompt) =>
          Effect.gen(function* () {
            sendInputs.push({ chatId, prompt });
            yield* Deferred.succeed(sent, undefined);
          }),
        abort: (chatId) =>
          Effect.gen(function* () {
            abortInputs.push(chatId);
            yield* Deferred.succeed(aborted, undefined);
          }),
        contextUsage: () => Effect.die("unexpected context read"),
        shake: () => Effect.die("unexpected chat shake"),
      });
      const eventRouter = EventRouter.of({
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

        yield* client.SendMessage({ chatId: firstChatId, prompt: "ship it" });
        yield* Deferred.await(sent);
        assert.deepStrictEqual(sendInputs, [{ chatId: firstChatId, prompt: "ship it" }]);

        yield* client.Abort({ chatId: secondChatId });
        yield* Deferred.await(aborted);
        assert.deepStrictEqual(abortInputs, [secondChatId]);

        yield* Queue.offerAll(eventQueue, [firstEvent, secondEvent]);
        yield* Deferred.await(eventsDelivered);
        assert.deepStrictEqual(received, [firstEvent, secondEvent]);
        assert.isFalse(yield* Deferred.isDone(routeFinalized));

        yield* Scope.close(clientScope, Exit.void);
        yield* Deferred.await(routeFinalized);
      }).pipe(
        Effect.provide(RpcServer.layer),
        Effect.provide(services),
        Effect.provide(NodeHttpServer.layerTest),
        Effect.scoped,
      );
    }),
  );
});
