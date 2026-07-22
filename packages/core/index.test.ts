import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { Core } from "./src/index.ts";

describe("Core", () => {
  it("runs the greet effect through its layer", async () => {
    const message = await Effect.runPromise(
      Effect.gen(function* () {
        const core = yield* Core;
        return yield* core.greet("pico");
      }).pipe(Effect.provide(Core.Default)),
    );
    expect(message).toBe("hello, pico");
  });
});
