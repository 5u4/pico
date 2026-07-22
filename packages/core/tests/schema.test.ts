import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";
import { ChatEvent, ChatMessage } from "../src/agents/schema.ts";

describe("ChatEvent schema", () => {
  it("encodes and decodes each variant round-trip", async () => {
    const samples: ChatEvent[] = [
      { _tag: "text_delta", delta: "hi" },
      { _tag: "thinking_delta", delta: "hmm" },
      {
        _tag: "tool_execution_start",
        toolCallId: "c1",
        toolName: "read",
        args: { p: 1 },
      },
      {
        _tag: "tool_execution_end",
        toolCallId: "c1",
        toolName: "read",
        result: "ok",
        isError: false,
      },
      { _tag: "agent_start" },
      { _tag: "agent_end" },
      { _tag: "turn_start" },
      { _tag: "turn_end" },
      { _tag: "error", reason: "aborted", message: "boom" },
    ];
    for (const sample of samples) {
      const encoded = await Effect.runPromise(Schema.encode(ChatEvent)(sample));
      const decoded = await Effect.runPromise(
        Schema.decodeUnknown(ChatEvent)(encoded),
      );
      expect(decoded).toEqual(sample);
    }
  });

  it("rejects an unknown tag", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ChatEvent)({ _tag: "nope" }).pipe(Effect.either),
    );
    expect(result._tag).toBe("Left");
  });
});

describe("ChatMessage schema", () => {
  it("decodes a valid message", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(ChatMessage)({ role: "user", text: "hello" }),
    );
    expect(decoded).toEqual({ role: "user", text: "hello" });
  });

  it("rejects an invalid role", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ChatMessage)({ role: "system", text: "x" }).pipe(
        Effect.either,
      ),
    );
    expect(result._tag).toBe("Left");
  });
});
