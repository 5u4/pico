import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { Effect, Layer, Stream } from "effect";
import type { ChatSession } from "../src/agents/chat.ts";
import { Chats } from "../src/agents/chats.ts";
import { SessionInitFailed } from "../src/agents/errors.ts";
import { type PromptOutcome, started } from "../src/agents/schema.ts";
import { layerPicoConfig, type PicoConfig } from "../src/config/pico-config.ts";
import { layerStore, Store } from "../src/store/store.ts";
import { makeSurface } from "../src/surface/surface.ts";

const thisFile = import.meta.path;

interface StubOptions {
  readonly getOrCreate?: (
    chatId: string,
  ) => Effect.Effect<ChatSession, SessionInitFailed>;
  readonly onInvalidate?: (chatId: string) => void;
  readonly onPrompt?: (chatId: string) => void;
}

const fakeSession = (
  chatId: string,
  onPrompt?: (chatId: string) => void,
): ChatSession => ({
  chatId,
  events: Stream.empty,
  history: Effect.succeed([]),
  prompt: (): Effect.Effect<PromptOutcome> =>
    Effect.sync(() => {
      onPrompt?.(chatId);
      return started;
    }),
});

const run = <A, E>(
  program: Effect.Effect<A, E, Store | Chats | PicoConfig>,
  opts: StubOptions = {},
): Promise<A> => {
  const chats = Chats.make({
    getOrCreate:
      opts.getOrCreate ??
      ((chatId) => Effect.succeed(fakeSession(chatId, opts.onPrompt))),
    invalidate: (chatId) => Effect.sync(() => opts.onInvalidate?.(chatId)),
  });
  const layers = Layer.mergeAll(
    layerStore(":memory:"),
    Layer.succeed(Chats, chats),
    layerPicoConfig("/nonexistent-surface-test-root"),
  );
  return Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layers)));
};

const failTag = <A, E extends { readonly _tag: string }>(
  program: Effect.Effect<A, E, Store | Chats | PicoConfig>,
  opts: StubOptions = {},
): Promise<string> =>
  run(
    program.pipe(
      Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "NO_FAILURE" }),
    ),
    opts,
  );

describe("Surface spaces", () => {
  it("creates a space, trimming the name and defaulting cwd to config", async () => {
    const space = await run(
      Effect.gen(function* () {
        const web = yield* makeSurface("web");
        return yield* web.createSpace({ name: "  work  " });
      }),
    );
    expect(space.name).toBe("work");
    expect(space.defaultCwd).toBe(homedir());
    expect(space.platform).toBe("web");
  });

  it("rejects an empty name with InvalidSpaceName", async () => {
    expect(
      await failTag(
        Effect.flatMap(makeSurface("web"), (web) =>
          web.createSpace({ name: "   " }),
        ),
      ),
    ).toBe("InvalidSpaceName");
  });

  it("rejects a relative cwd with InvalidCwd", async () => {
    expect(
      await failTag(
        Effect.flatMap(makeSurface("web"), (web) =>
          web.createSpace({ name: "x", cwd: "rel/path" }),
        ),
      ),
    ).toBe("InvalidCwd");
  });

  it("rejects a missing cwd with CwdNotFound", async () => {
    expect(
      await failTag(
        Effect.flatMap(makeSurface("web"), (web) =>
          web.createSpace({ name: "x", cwd: "/nonexistent/surface/zzz" }),
        ),
      ),
    ).toBe("CwdNotFound");
  });

  it("rejects a file cwd with NotADirectory", async () => {
    expect(
      await failTag(
        Effect.flatMap(makeSurface("web"), (web) =>
          web.createSpace({ name: "x", cwd: thisFile }),
        ),
      ),
    ).toBe("NotADirectory");
  });

  it("isolates spaces by platform for get and list", async () => {
    const result = await run(
      Effect.gen(function* () {
        const web = yield* makeSurface("web");
        const discord = yield* makeSurface("discord");
        const ws = yield* web.createSpace({ name: "w" });
        yield* discord.createSpace({ name: "d" });
        const webList = yield* web.listSpaces();
        const discordList = yield* discord.listSpaces();
        const crossGet = yield* discord
          .getSpace(ws.id)
          .pipe(
            Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "OK" }),
          );
        return {
          webOnlyWeb: webList.every((s) => s.platform === "web"),
          webCount: webList.length,
          discordCount: discordList.length,
          crossGet,
        };
      }),
    );
    expect(result.webOnlyWeb).toBe(true);
    expect(result.webCount).toBe(1);
    expect(result.discordCount).toBe(1);
    expect(result.crossGet).toBe("SpaceNotFound");
  });

  it("refuses to delete a space with an active chat, then allows it after archive", async () => {
    const result = await run(
      Effect.gen(function* () {
        const web = yield* makeSurface("web");
        const ws = yield* web.createSpace({ name: "w" });
        const { chat } = yield* web.createChat(ws.id, "keep");
        const blocked = yield* web
          .deleteSpace(ws.id)
          .pipe(
            Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "OK" }),
          );
        yield* web.archiveChat(chat.id);
        const allowed = yield* web
          .deleteSpace(ws.id)
          .pipe(
            Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "OK" }),
          );
        return { blocked, allowed };
      }),
    );
    expect(result.blocked).toBe("SpaceHasActiveChats");
    expect(result.allowed).toBe("OK");
  });

  it("rejects updateSpaceCwd across platforms with SpaceNotFound", async () => {
    expect(
      await failTag(
        Effect.gen(function* () {
          const web = yield* makeSurface("web");
          const discord = yield* makeSurface("discord");
          const ws = yield* web.createSpace({ name: "w" });
          return yield* discord.updateSpaceCwd(ws.id, "~");
        }),
      ),
    ).toBe("SpaceNotFound");
  });
});

describe("Surface chats", () => {
  it("creates a chat returning {chat, session} without prompting", async () => {
    let prompted = false;
    const result = await run(
      Effect.gen(function* () {
        const web = yield* makeSurface("web");
        const ws = yield* web.createSpace({ name: "w" });
        const handle = yield* web.createChat(ws.id, "  hello  ");
        return {
          title: handle.chat.title,
          matches: handle.session.chatId === handle.chat.id,
          cwd: handle.chat.cwd,
        };
      }),
      { onPrompt: () => (prompted = true) },
    );
    expect(result.title).toBe("hello");
    expect(result.matches).toBe(true);
    expect(result.cwd).toBe(homedir());
    expect(prompted).toBe(false);
  });

  it("rejects an empty title with InvalidChatTitle", async () => {
    expect(
      await failTag(
        Effect.gen(function* () {
          const web = yield* makeSurface("web");
          const ws = yield* web.createSpace({ name: "w" });
          return yield* web.createChat(ws.id, "   ");
        }),
      ),
    ).toBe("InvalidChatTitle");
  });

  it("deletes the orphan chat row when session acquisition fails", async () => {
    const remaining = await run(
      Effect.gen(function* () {
        const web = yield* makeSurface("web");
        const store = yield* Store;
        const ws = yield* web.createSpace({ name: "w" });
        yield* web
          .createChat(ws.id, "doomed")
          .pipe(Effect.catchAll(() => Effect.void));
        return yield* store.chats.list(ws.id);
      }),
      {
        getOrCreate: (chatId) =>
          Effect.fail(new SessionInitFailed({ chatId, cause: "boom" })),
      },
    );
    expect(remaining.length).toBe(0);
  });

  it("archives a chat, excluding it from listChats and releasing the session", async () => {
    const invalidated: string[] = [];
    const result = await run(
      Effect.gen(function* () {
        const web = yield* makeSurface("web");
        const ws = yield* web.createSpace({ name: "w" });
        const { chat } = yield* web.createChat(ws.id, "t");
        const before = yield* web.listChats(ws.id);
        yield* web.archiveChat(chat.id);
        const after = yield* web.listChats(ws.id);
        return { chatId: chat.id, before: before.length, after: after.length };
      }),
      { onInvalidate: (id) => invalidated.push(id) },
    );
    expect(result.before).toBe(1);
    expect(result.after).toBe(0);
    expect(invalidated).toEqual([result.chatId]);
  });

  it("rejects archiving a chat from another platform with ChatNotFound", async () => {
    expect(
      await failTag(
        Effect.gen(function* () {
          const web = yield* makeSurface("web");
          const discord = yield* makeSurface("discord");
          const ws = yield* web.createSpace({ name: "w" });
          const { chat } = yield* web.createChat(ws.id, "t");
          return yield* discord.archiveChat(chat.id);
        }),
      ),
    ).toBe("ChatNotFound");
  });

  it("hard-fails openChat with CwdNotFound when the persisted cwd is gone", async () => {
    expect(
      await failTag(
        Effect.gen(function* () {
          const web = yield* makeSurface("web");
          const store = yield* Store;
          const ws = yield* web.createSpace({ name: "w" });
          const chat = yield* store.chats.create({
            spaceId: ws.id,
            cwd: "/nonexistent/surface/gone",
            title: "old",
          });
          return yield* web.openChat(chat.id);
        }),
      ),
    ).toBe("CwdNotFound");
  });
});
