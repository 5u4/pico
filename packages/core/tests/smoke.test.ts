import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chunk, Effect, Fiber, Layer, Stream } from "effect";
import { Auth } from "../src/agents/auth.ts";
import { Catalog } from "../src/agents/catalog.ts";
import { Chats } from "../src/agents/chats.ts";
import type { ChatEvent } from "../src/agents/schema.ts";
import { layerPicoConfig } from "../src/config/pico-config.ts";
import { Store } from "../src/store/store.ts";

describe.skipIf(!process.env.PICO_SMOKE)("chat smoke (real LLM)", () => {
  it("streams a turn end-to-end", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "pico-smoke-"));
    const config = layerPicoConfig(configRoot);
    const storeLayer = Store.DefaultWithoutDependencies.pipe(
      Layer.provide(config),
    );
    const chatsLayer = Chats.DefaultWithoutDependencies.pipe(
      Layer.provide(Auth.Default),
      Layer.provide(Catalog.Default),
      Layer.provide(config),
      Layer.provide(storeLayer),
    );
    const smokeLayer = Layer.merge(chatsLayer, storeLayer);
    const program = Effect.gen(function* () {
      const store = yield* Store;
      const chats = yield* Chats;
      const space = yield* store.spaces.create({
        defaultCwd: process.cwd(),
        platform: "web",
        name: "smoke",
      });
      const created = yield* store.chats.create({
        spaceId: space.id,
        cwd: process.cwd(),
        title: "smoke chat",
      });
      const chat = yield* chats.getOrCreate(created.id);

      const connection = yield* chat.connect;
      const collector = yield* Effect.fork(
        connection.live.pipe(
          Stream.takeUntil((event: ChatEvent) => event._tag === "agent_end"),
          Stream.runCollect,
        ),
      );

      const outcome = yield* chat.prompt(
        "Reply with exactly the word: pong. Nothing else.",
      );
      expect(outcome._tag).toBe("Started");

      const events = Chunk.toReadonlyArray(yield* Fiber.join(collector));
      const textDeltas = events.filter((e) => e._tag === "text_delta");
      expect(textDeltas.length).toBeGreaterThan(0);
      expect(events.some((e) => e._tag === "agent_end")).toBe(true);

      const messages = yield* chat.history;
      expect(messages.some((m) => m.role === "assistant")).toBe(true);
    });

    try {
      await Effect.runPromise(
        Effect.scoped(program).pipe(Effect.provide(smokeLayer)),
      );
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
