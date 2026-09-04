import { Application } from "@pico/contract/application";
import { EventRouter } from "@pico/contract/event-router";
import { PicoRpcs } from "@pico/contract/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

const handlers = PicoRpcs.toLayer(
  Effect.gen(function* () {
    const application = yield* Application;
    const eventRouter = yield* EventRouter;

    return PicoRpcs.of({
      Transcript: ({ chatId }) => application.transcript(chatId),
      SendMessage: ({ chatId, prompt }) => application.sendMessage(chatId, prompt),
      Abort: ({ chatId }) => application.abort(chatId),
      Events: () =>
        Stream.unwrap(eventRouter.open(() => true).pipe(Effect.map((route) => route.events))),
    });
  }),
);

const routes = RpcServer.layerHttp({ group: PicoRpcs, path: "/rpc" }).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcSerialization.layerJson),
);

export const layer = HttpRouter.serve(routes);
