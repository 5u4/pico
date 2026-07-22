import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { ThreadState } from "./src/index.ts";

describe("web-protocol", () => {
  it("decodes an empty thread state", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(ThreadState)({ threadId: null, messages: [] }),
    );
    expect(decoded.messages).toHaveLength(0);
  });

  it("rejects a malformed role", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ThreadState)({
        threadId: "t1",
        messages: [{ id: "m1", role: "system", text: "x" }],
      }).pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
  });
});
