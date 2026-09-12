import { Application } from "@pico/contract/application";
import { ApplicationError, ChatClosed, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { EventRouter } from "@pico/contract/event-router";
import { PicoRpcs } from "@pico/contract/rpc";
import * as Cause from "effect/Cause";
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
      Transcript: ({ chatId }, { requestId }) =>
        application.transcript(chatId).pipe(
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "Transcript",
            chatId,
            requestId: String(requestId),
          }),
        ),
      SendMessage: ({ chatId, prompt }, { requestId }) =>
        application.sendMessage(chatId, prompt).pipe(
          Effect.flatMap((delivery) =>
            delivery.kind === "handled" ? Effect.void : delivery.completed,
          ),
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "SendMessage",
            chatId,
            requestId: String(requestId),
          }),
        ),
      Abort: ({ chatId }, { requestId }) =>
        application.abort(chatId).pipe(
          Effect.tapCause(reportFailure),
          Effect.annotateLogs({
            component: "rpc",
            procedure: "Abort",
            chatId,
            requestId: String(requestId),
          }),
        ),
      Events: (_, { requestId }) =>
        Stream.unwrap(eventRouter.open(() => true).pipe(Effect.map((route) => route.events))).pipe(
          Stream.tapCause((cause) =>
            reportFailure(cause).pipe(
              Effect.annotateLogs({
                component: "rpc",
                procedure: "Events",
                requestId: String(requestId),
              }),
            ),
          ),
        ),
    });
  }),
);

const routes = RpcServer.layerHttp({ group: PicoRpcs, path: "/rpc" }).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcSerialization.layerJson),
);

export const layer = HttpRouter.serve(routes);

const reportFailure = (cause: Cause.Cause<unknown>) => {
  const operational = cause.reasons.some((reason) => {
    if (reason._tag === "Interrupt") return false;
    if (reason._tag === "Die") return true;
    const error = reason.error;
    if (error instanceof ApplicationError) return error.reason === "operation";
    return !(error instanceof ChatClosed || error instanceof WorkspaceBindingInvalid);
  });
  if (!operational) return Effect.void;
  const safeCause = Cause.fromReasons(
    cause.reasons.map((reason) => {
      if (reason._tag === "Interrupt") return reason;
      if (
        reason._tag === "Fail" &&
        (reason.error instanceof ApplicationError ||
          reason.error instanceof ChatClosed ||
          reason.error instanceof WorkspaceBindingInvalid)
      )
        return reason;
      const error = new Error(
        reason._tag === "Die" ? "Unexpected RPC defect" : "RPC operation failed",
      );
      return reason._tag === "Die" ? Cause.makeDieReason(error) : Cause.makeFailReason(error);
    }),
  );
  return Effect.logError("pico.rpc.failed", safeCause).pipe(
    Effect.annotateLogs({ operation: "request", outcome: "failure" }),
  );
};
