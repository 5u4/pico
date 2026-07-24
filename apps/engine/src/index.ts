import { HttpMiddleware, HttpServer } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Chats, makeSurface, PicoConfig, Store } from "@pico/core";
import { Effect, Layer } from "effect";
import { buildRouter } from "./router.ts";

const port = Number(process.env.PICO_ENGINE_PORT ?? 4319);

const HttpLive = Layer.unwrapEffect(
  makeSurface("web").pipe(
    Effect.map((surface) =>
      HttpServer.serve(HttpMiddleware.logger)(buildRouter(surface)),
    ),
  ),
).pipe(
  HttpServer.withLogAddress,
  Layer.provide(BunHttpServer.layer({ port })),
  Layer.provide(
    Layer.mergeAll(Chats.Default, Store.Default, PicoConfig.Default),
  ),
);

BunRuntime.runMain(Layer.launch(HttpLive));
