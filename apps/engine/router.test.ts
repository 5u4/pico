import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpApp } from "@effect/platform";
import {
  ChatBusy,
  type ChatSession,
  Chats,
  layerPicoConfig,
  layerStore,
  makeSurface,
  type PromptOutcome,
} from "@pico/core";
import {
  StreamFrame,
  WireChat,
  WireError,
  WireSpace,
} from "@pico/web-protocol";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { buildRouter } from "./src/router.ts";

interface Handler {
  readonly call: (path: string, init?: RequestInit) => Promise<Response>;
}

const startedOutcome: PromptOutcome = { _tag: "Started" };

const decodeBody = <A, I>(
  schema: Schema.Schema<A, I>,
  res: Response,
): Effect.Effect<A> =>
  Effect.promise(() => res.json()).pipe(
    Effect.flatMap(Schema.decodeUnknown(schema)),
    Effect.orDie,
  );

const stubSession = (chatId: string, busy: boolean): ChatSession => ({
  chatId,
  history: Effect.succeed([{ role: "user", text: "prior" }]),
  connect: Effect.succeed({
    messages: [{ role: "user", text: "prior" }],
    inFlight: Option.none(),
    live: Stream.make(
      { _tag: "text_delta", index: 1, delta: "po" } as const,
      { _tag: "text_delta", index: 1, delta: "ng" } as const,
      { _tag: "agent_end" } as const,
    ),
  }),
  prompt: () =>
    busy
      ? Effect.fail(new ChatBusy({ chatId }))
      : Effect.succeed(startedOutcome),
});

const withHandler = <A>(
  body: (handler: Handler) => Effect.Effect<A>,
  opts: { readonly busy?: boolean } = {},
): Promise<A> => {
  const configRoot = mkdtempSync(join(tmpdir(), "pico-engine-"));
  const chats = Chats.make({
    getOrCreate: (chatId) =>
      Effect.succeed(stubSession(chatId, opts.busy ?? false)),
    invalidate: () => Effect.void,
  });
  const layers = Layer.mergeAll(
    layerStore(":memory:"),
    Layer.succeed(Chats, chats),
    layerPicoConfig(configRoot),
  );
  const program = Effect.gen(function* () {
    const surface = yield* makeSurface("web");
    const webHandler = HttpApp.toWebHandler(buildRouter(surface));
    const handler: Handler = {
      call: (path, init) =>
        webHandler(new Request(`http://engine${path}`, init)),
    };
    return yield* body(handler);
  });
  return Effect.runPromise(
    Effect.scoped(program).pipe(Effect.provide(layers)),
  ).finally(() => rmSync(configRoot, { recursive: true, force: true }));
};

const createSpace = (handler: Handler): Promise<Response> =>
  handler.call("/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "local", cwd: process.cwd() }),
  });

describe("engine transport", () => {
  it("creates and lists a space", async () => {
    const result = await withHandler((handler) =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(() => createSpace(handler));
        expect(created.status).toBe(201);
        const space = yield* decodeBody(WireSpace, created);
        expect(space.platform).toBe("web");

        const listed = yield* Effect.promise(() => handler.call("/spaces"));
        expect(listed.status).toBe(200);
        const spaces = yield* decodeBody(Schema.Array(WireSpace), listed);
        expect(spaces).toHaveLength(1);
        return space.id;
      }),
    );
    expect(typeof result).toBe("string");
  });

  it("runs the create-chat, prompt, and events flow", async () => {
    await withHandler((handler) =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(() => createSpace(handler));
        const space = yield* decodeBody(WireSpace, created);

        const chatRes = yield* Effect.promise(() =>
          handler.call(`/spaces/${space.id}/chats`, {
            method: "POST",
            body: JSON.stringify({ title: "first" }),
          }),
        );
        expect(chatRes.status).toBe(201);
        const chat = yield* decodeBody(WireChat, chatRes);

        const promptRes = yield* Effect.promise(() =>
          handler.call(`/chats/${chat.id}/prompt`, {
            method: "POST",
            body: JSON.stringify({ text: "ping" }),
          }),
        );
        expect(promptRes.status).toBe(202);

        const eventsRes = yield* Effect.promise(() =>
          handler.call(`/chats/${chat.id}/events`),
        );
        expect(eventsRes.status).toBe(200);
        expect(eventsRes.headers.get("content-type")).toContain(
          "text/event-stream",
        );
        const text = yield* Effect.promise(() => eventsRes.text());
        const frames = yield* Effect.forEach(
          text
            .split("\n\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice("data: ".length)) as unknown),
          Schema.decodeUnknown(StreamFrame),
        ).pipe(Effect.orDie);
        expect(frames[0]?._tag).toBe("snapshot");
        expect(frames.some((f) => f._tag === "text_delta")).toBe(true);
        expect(frames.some((f) => f._tag === "agent_end")).toBe(true);
      }),
    );
  });

  it("returns 404 ChatNotFound for an unknown chat", async () => {
    await withHandler((handler) =>
      Effect.gen(function* () {
        const res = yield* Effect.promise(() =>
          handler.call("/chats/UNKNOWN/events"),
        );
        expect(res.status).toBe(404);
        const err = yield* decodeBody(WireError, res);
        expect(err._tag).toBe("ChatNotFound");
      }),
    );
  });

  it("returns 400 InvalidSpaceName for an empty name", async () => {
    await withHandler((handler) =>
      Effect.gen(function* () {
        const res = yield* Effect.promise(() =>
          handler.call("/spaces", {
            method: "POST",
            body: JSON.stringify({ name: "  ", cwd: process.cwd() }),
          }),
        );
        expect(res.status).toBe(400);
        const err = yield* decodeBody(WireError, res);
        expect(err._tag).toBe("InvalidSpaceName");
      }),
    );
  });

  it("returns 409 ChatBusy when a prompt is rejected", async () => {
    await withHandler(
      (handler) =>
        Effect.gen(function* () {
          const created = yield* Effect.promise(() => createSpace(handler));
          const space = yield* decodeBody(WireSpace, created);
          const chatRes = yield* Effect.promise(() =>
            handler.call(`/spaces/${space.id}/chats`, {
              method: "POST",
              body: JSON.stringify({ title: "busy" }),
            }),
          );
          const chat = yield* decodeBody(WireChat, chatRes);
          const res = yield* Effect.promise(() =>
            handler.call(`/chats/${chat.id}/prompt`, {
              method: "POST",
              body: JSON.stringify({ text: "again" }),
            }),
          );
          expect(res.status).toBe(409);
          const err = yield* decodeBody(WireError, res);
          expect(err._tag).toBe("ChatBusy");
        }),
      { busy: true },
    );
  });
});
