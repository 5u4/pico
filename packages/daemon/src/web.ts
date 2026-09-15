import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as RpcServer from "@pico/rpc/server";
import * as WebAssets from "@pico/web/assets";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const open = Effect.fn("Daemon.Web.open")(function* () {
  const assets = yield* WebAssets.build();
  const server = yield* BunHttpServer.make({
    hostname: "127.0.0.1",
    port: 0,
    disablePreemptiveShutdown: true,
  });
  if (server.address._tag !== "TcpAddress") {
    return yield* Effect.die(new Error("Web listener did not acquire a TCP address"));
  }
  const host = `127.0.0.1:${server.address.port}`;
  const webUrl = `http://${host}`;
  yield* Layer.build(
    HttpRouter.serve(
      Layer.mergeAll(RpcServer.routes, assetRoutes(assets), boundary(host, webUrl, assets.files)),
      { disableLogger: true, disableListenLog: true },
    ).pipe(Layer.provide(Layer.succeed(HttpServer.HttpServer)(server))),
  );
  return { webUrl };
});

const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
};

const assetRoutes = (assets: WebAssets.Assets) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const index = response(assets.index);
      yield* router.add("*", "/", index);
      for (const [path, asset] of assets.files) {
        yield* router.add("*", path, response(asset));
      }
    }),
  );

const response = (asset: WebAssets.Asset) =>
  HttpServerResponse.uint8Array(asset.body, { contentType: asset.contentType });

const boundary = (host: string, webUrl: string, files: ReadonlyMap<string, WebAssets.Asset>) =>
  HttpRouter.middleware(
    (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const origin = request.headers.origin;
        if (request.headers.host !== host || (origin !== undefined && origin !== webUrl)) {
          return HttpServerResponse.empty({ status: 403, headers });
        }
        const query = request.url.indexOf("?");
        const path = query === -1 ? request.url : request.url.slice(0, query);
        if (path !== "/rpc" && path !== "/" && !files.has(path)) {
          return HttpServerResponse.empty({ status: 404, headers });
        }
        if (path === "/rpc") {
          if (request.method !== "GET") {
            return HttpServerResponse.empty({
              status: 405,
              headers: { ...headers, allow: "GET" },
            });
          }
          if (request.headers.upgrade?.toLowerCase() !== "websocket") {
            return HttpServerResponse.empty({
              status: 426,
              headers: { ...headers, upgrade: "websocket" },
            });
          }
          if (origin !== webUrl) return HttpServerResponse.empty({ status: 403, headers });
        } else if (request.method !== "GET" && request.method !== "HEAD") {
          return HttpServerResponse.empty({
            status: 405,
            headers: { ...headers, allow: "GET, HEAD" },
          });
        }
        return HttpServerResponse.setHeaders(yield* httpEffect, headers);
      }),
    { global: true },
  );
