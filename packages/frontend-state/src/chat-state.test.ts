import { assert, describe, it } from "@effect/vitest";
import { emptyLiveChat, reduceLiveChat } from "./chat-state.ts";

describe("live chat transitions", () => {
  it("retains tool start arguments and represents a completion observed without its start", () => {
    const started = reduceLiveChat(emptyLiveChat(), {
      type: "tool-started",
      toolCallId: "first",
      toolName: "shell",
      argumentsJson: '{"command":"pwd"}',
    });
    const finished = reduceLiveChat(started, {
      type: "tool-finished",
      toolCallId: "first",
      toolName: "shell",
      status: "succeeded",
    });
    const joinedLate = reduceLiveChat(finished, {
      type: "tool-finished",
      toolCallId: "second",
      toolName: "read",
      status: "failed",
    });
    assert.deepStrictEqual(joinedLate.tools.get("first"), {
      kind: "finished",
      start: {
        type: "tool-started",
        toolCallId: "first",
        toolName: "shell",
        argumentsJson: '{"command":"pwd"}',
      },
      end: { type: "tool-finished", toolCallId: "first", toolName: "shell", status: "succeeded" },
    });
    assert.deepStrictEqual(joinedLate.tools.get("second"), {
      kind: "finished",
      start: null,
      end: { type: "tool-finished", toolCallId: "second", toolName: "read", status: "failed" },
    });
  });

  it("clears drafts on assistant settlement without erasing another assistant's text on tool settlement", () => {
    const partial = reduceLiveChat(emptyLiveChat(), {
      type: "text-delta",
      contentIndex: 4,
      text: "partial",
    });
    const afterTool = reduceLiveChat(partial, {
      type: "message-settled",
      message: {
        role: "tool-result",
        toolCallId: "tool",
        toolName: "read",
        content: [],
        status: "succeeded",
        timestamp: 1,
      },
    });
    assert.strictEqual(afterTool.blocks.get(4)?.text, "partial");
    const afterAssistant = reduceLiveChat(afterTool, {
      type: "message-settled",
      message: {
        role: "assistant",
        status: "failed",
        stopReason: "aborted",
        message: null,
        content: [{ type: "text", text: "partial" }],
        model: "test",
        timestamp: 2,
      },
    });
    assert.strictEqual(afterAssistant.blocks.size, 0);
    assert.strictEqual(afterAssistant.run.kind, "running");
    assert.deepStrictEqual(
      reduceLiveChat(afterAssistant, {
        type: "run-finished",
        outcome: "aborted",
      }).run,
      { kind: "finished", outcome: "aborted" },
    );
  });
});
