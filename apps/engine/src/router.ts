import type { HttpServerError } from "@effect/platform";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import type { ChatMessage, Surface } from "@pico/core";
import {
  CreateChatRequest,
  CreateSpaceRequest,
  type HistoryPage,
  HistoryQuery,
  type PromptAccepted,
  PromptRequest,
  type StreamFrame,
  UpdateSpaceCwdRequest,
} from "@pico/web-protocol";
import { Effect, type ParseResult, Schema, Stream } from "effect";
import { type SurfaceError, toWireFailure } from "./errors.ts";
import {
  toStreamFrame,
  toWireChat,
  toWireInFlight,
  toWireMessage,
  toWireSpace,
} from "./translate.ts";

const HISTORY_WINDOW = 100;

const IdParam = Schema.Struct({ id: Schema.String });
const HistoryParams = Schema.Struct({
  id: Schema.String,
  ...HistoryQuery.fields,
});

type HandlerError =
  | SurfaceError
  | ParseResult.ParseError
  | HttpServerError.RequestError;

const jsonOrDie = (
  body: unknown,
  options?: { readonly status?: number },
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  HttpServerResponse.json(body, options).pipe(Effect.orDie);

const respondWire = (
  error: HandlerError,
): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  if (error._tag === "ParseError" || error._tag === "RequestError") {
    return jsonOrDie(
      { _tag: "BadRequest", message: error.message },
      { status: 400 },
    );
  }
  const { status, body } = toWireFailure(error);
  return jsonOrDie(body, { status });
};

const encodeSse = (frame: StreamFrame): string =>
  `data: ${JSON.stringify(frame)}\n\n`;

const paginate = (
  all: ReadonlyArray<ChatMessage>,
  before: number | undefined,
  limit: number,
): HistoryPage => {
  const end = Math.min(before ?? all.length, all.length);
  const start = Math.max(0, end - limit);
  return {
    messages: all.slice(start, end).map(toWireMessage),
    hasMore: start > 0,
    nextCursor: start > 0 ? start : null,
  };
};

export const buildRouter = (surface: Surface): HttpRouter.HttpRouter<never> =>
  HttpRouter.empty.pipe(
    HttpRouter.post(
      "/spaces",
      Effect.gen(function* () {
        const body =
          yield* HttpServerRequest.schemaBodyJson(CreateSpaceRequest);
        const space = yield* surface.createSpace({
          name: body.name,
          cwd: body.cwd,
        });
        return yield* jsonOrDie(toWireSpace(space), { status: 201 });
      }).pipe(Effect.catchAll(respondWire)),
    ),
    HttpRouter.get(
      "/spaces",
      Effect.gen(function* () {
        const spaces = yield* surface.listSpaces();
        return yield* jsonOrDie(spaces.map(toWireSpace));
      }).pipe(Effect.catchAll(respondWire)),
    ),
    HttpRouter.get(
      "/spaces/:id",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParam);
        const space = yield* surface.getSpace(id);
        return yield* jsonOrDie(toWireSpace(space));
      }).pipe(Effect.catchAll(respondWire)),
    ),
    HttpRouter.patch(
      "/spaces/:id",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParam);
        const body = yield* HttpServerRequest.schemaBodyJson(
          UpdateSpaceCwdRequest,
        );
        const space = yield* surface.updateSpaceCwd(id, body.cwd);
        return yield* jsonOrDie(toWireSpace(space));
      }).pipe(Effect.catchAll(respondWire)),
    ),
    HttpRouter.del(
      "/spaces/:id",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParam);
        yield* surface.deleteSpace(id);
        return HttpServerResponse.empty({ status: 204 });
      }).pipe(Effect.catchAll(respondWire)),
    ),
    HttpRouter.post(
      "/spaces/:id/chats",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParam);
        const body = yield* HttpServerRequest.schemaBodyJson(CreateChatRequest);
        const { chat } = yield* surface.createChat(id, body.title);
        return yield* jsonOrDie(toWireChat(chat), { status: 201 });
      }).pipe(Effect.catchAll(respondWire)),
    ),
    HttpRouter.get(
      "/spaces/:id/chats",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParam);
        const chats = yield* surface.listChats(id);
        return yield* jsonOrDie(chats.map(toWireChat));
      }).pipe(Effect.catchAll(respondWire)),
    ),
    HttpRouter.post(
      "/chats/:id/archive",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParam);
        yield* surface.archiveChat(id);
        return HttpServerResponse.empty({ status: 204 });
      }).pipe(Effect.catchAll(respondWire)),
    ),
    HttpRouter.post(
      "/chats/:id/prompt",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParam);
        const body = yield* HttpServerRequest.schemaBodyJson(PromptRequest);
        const { session } = yield* surface.openChat(id);
        const outcome = yield* session.prompt(body.text);
        const accepted: PromptAccepted = { _tag: outcome._tag };
        return yield* jsonOrDie(accepted, { status: 202 });
      }).pipe(Effect.catchAll(respondWire)),
    ),
    HttpRouter.get(
      "/chats/:id/history",
      Effect.gen(function* () {
        const { id, before, limit } =
          yield* HttpRouter.schemaParams(HistoryParams);
        const { session } = yield* surface.openChat(id);
        const all = yield* session.history;
        const page = paginate(all, before, limit ?? HISTORY_WINDOW);
        return yield* jsonOrDie(page);
      }).pipe(Effect.catchAll(respondWire)),
    ),
    HttpRouter.get(
      "/chats/:id/events",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParam);
        const { session } = yield* surface.openChat(id);
        const connection = yield* session.connect;
        const page = paginate(connection.messages, undefined, HISTORY_WINDOW);
        const inFlight =
          connection.inFlight._tag === "Some"
            ? toWireInFlight(connection.inFlight.value)
            : null;
        const snapshot: StreamFrame = {
          _tag: "snapshot",
          messages: page.messages,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          inFlight,
        };
        const frames = Stream.make(snapshot).pipe(
          Stream.concat(connection.live.pipe(Stream.map(toStreamFrame))),
          Stream.map(encodeSse),
          Stream.encodeText,
        );
        return HttpServerResponse.stream(frames, {
          contentType: "text/event-stream",
          headers: { "cache-control": "no-cache", connection: "keep-alive" },
        });
      }).pipe(Effect.catchAll(respondWire)),
    ),
  );
