import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { StreamFrame, WireError, WireSpace } from "./src/index.ts";

describe("web-protocol", () => {
  it("decodes a wire space with null optionals", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(WireSpace)({
        id: "s1",
        name: "local",
        platform: "web",
        defaultCwd: "/tmp",
        externalId: null,
        checkoutBranch: null,
        branchPrefix: null,
        createdAt: 1234,
      }),
    );
    expect(decoded.platform).toBe("web");
    expect(decoded.externalId).toBeNull();
  });

  it("rejects an invalid platform", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(WireSpace)({
        id: "s1",
        name: "local",
        platform: "slack",
        defaultCwd: "/tmp",
        externalId: null,
        checkoutBranch: null,
        branchPrefix: null,
        createdAt: 1234,
      }).pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
  });

  it("round-trips a snapshot frame", async () => {
    const frame: StreamFrame = {
      _tag: "snapshot",
      messages: [{ role: "assistant", text: "hi" }],
      hasMore: true,
      nextCursor: 42,
      inFlight: { index: 3, message: { role: "assistant", text: "typ" } },
    };
    const encoded = await Effect.runPromise(Schema.encode(StreamFrame)(frame));
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(StreamFrame)(encoded),
    );
    expect(decoded).toEqual(frame);
  });

  it("round-trips a text_delta frame", async () => {
    const frame: StreamFrame = { _tag: "text_delta", index: 2, delta: "x" };
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(StreamFrame)(frame),
    );
    expect(decoded).toEqual(frame);
  });

  it("decodes a tagged wire error", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(WireError)({
        _tag: "ChatBusy",
        message: "chat is busy",
        chatId: "c1",
      }),
    );
    expect(decoded._tag).toBe("ChatBusy");
  });
});
