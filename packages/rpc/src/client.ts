import { PicoRpcs } from "@pico/contract/rpc";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

export const make = Effect.fn("RpcClient.make")(function* (url: string) {
  const socket = yield* Socket.makeWebSocket(url).pipe(
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const protocol = yield* RpcClient.makeProtocolSocket({
    retryPolicy: Schedule.recurs(0),
  }).pipe(
    Effect.provideService(Socket.Socket, socket),
    Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json),
  );

  return yield* RpcClient.make(PicoRpcs).pipe(Effect.provideService(RpcClient.Protocol, protocol));
});
