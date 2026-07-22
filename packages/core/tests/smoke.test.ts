import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chunk, Effect, Fiber, Layer, Stream } from "effect";
import { ulid } from "ulid";
import { Auth } from "../src/agents/auth.ts";
import { Catalog } from "../src/agents/catalog.ts";
import { Chats } from "../src/agents/chats.ts";
import { layerChatsConfig } from "../src/agents/config.ts";
import type { ChatEvent } from "../src/agents/schema.ts";

const smokeLayer = Chats.DefaultWithoutDependencies.pipe(
  Layer.provide(Auth.Default),
  Layer.provide(Catalog.Default),
  Layer.provide(layerChatsConfig(mkdtempSync(join(tmpdir(), "pico-smoke-")))),
);

describe.skipIf(!process.env.PICO_SMOKE)("chat smoke (real LLM)", () => {
  it("streams a turn end-to-end", async () => {
    const program = Effect.gen(function* () {
      const chats = yield* Chats;
      const chat = yield* chats.getOrCreate(ulid(), { cwd: process.cwd() });

      const collector = yield* Effect.fork(
        chat.events.pipe(
          Stream.takeUntil((event: ChatEvent) => event._tag === "turn_end"),
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
      expect(events.some((e) => e._tag === "turn_end")).toBe(true);

      const messages = yield* chat.history;
      expect(messages.some((m) => m.role === "assistant")).toBe(true);
    });

    await Effect.runPromise(
      Effect.scoped(program).pipe(Effect.provide(smokeLayer)),
    );
  }, 120_000);
});
