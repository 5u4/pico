import { assert, describe, it } from "@effect/vitest";
import { type AgentAssistantMessage, AgentMessageId } from "@pico/contract/agent-message";
import {
  acknowledgeTranscript,
  emptyLiveChat,
  type LiveChat,
  reduceLiveChat,
} from "./chat-state.ts";

const firstId = AgentMessageId.make("first");
const secondId = AgentMessageId.make("second");
const repeated: AgentAssistantMessage = {
  id: firstId,
  role: "assistant",
  status: "completed",
  stopReason: "stop",
  content: [{ type: "text", text: "repeated" }],
  model: "test",
  timestamp: 1,
};
const settled = (state: LiveChat) =>
  [...state.assistant.values()].flatMap((entry) =>
    entry.kind === "settled" ? [entry.message] : [],
  );
const blocks = (state: LiveChat, id: AgentMessageId) => {
  const message = state.assistant.get(id);
  return message?.kind === "draft" ? [...message.blocks.values()] : [];
};

describe("live chat transitions", () => {
  it("retains tool start arguments and supports completion without a start", () => {
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
    const first = joinedLate.tools.get("first");
    const second = joinedLate.tools.get("second");
    assert.strictEqual(first?.start?.argumentsJson, '{"command":"pwd"}');
    assert.strictEqual(first?.kind === "finished" ? first.end.status : null, "succeeded");
    assert.strictEqual(second?.kind === "finished" ? second.end.status : null, "failed");
    assert.strictEqual(second?.start, null);
  });

  it("folds deltas by message and content index without joining distinct drafts", () => {
    let state = emptyLiveChat();
    for (const event of [
      { type: "text-delta", messageId: firstId, contentIndex: 4, text: "first" },
      { type: "thinking-delta", messageId: firstId, contentIndex: 0, text: "plan" },
      { type: "text-delta", messageId: secondId, contentIndex: 4, text: "second" },
      { type: "text-delta", messageId: firstId, contentIndex: 4, text: " answer" },
    ] as const) {
      state = reduceLiveChat(state, event);
    }
    assert.deepStrictEqual(
      blocks(state, firstId).map((block) => block.text),
      ["first answer", "plan"],
    );
    assert.deepStrictEqual(
      blocks(state, secondId).map((block) => block.text),
      ["second"],
    );
  });

  it("settles one draft in place without clearing another or losing a failed response", () => {
    const first = reduceLiveChat(emptyLiveChat(), {
      type: "text-delta",
      messageId: firstId,
      contentIndex: 0,
      text: "partial",
    });
    const second = reduceLiveChat(first, {
      type: "text-delta",
      messageId: secondId,
      contentIndex: 0,
      text: "next",
    });
    const afterTool = reduceLiveChat(second, {
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
    const failed: AgentAssistantMessage = {
      ...repeated,
      status: "failed",
      stopReason: "aborted",
      message: null,
      content: [{ type: "text", text: "partial" }],
    };
    const completed = reduceLiveChat(afterTool, { type: "message-settled", message: failed });
    const late = reduceLiveChat(completed, {
      type: "text-delta",
      messageId: firstId,
      contentIndex: 0,
      text: "late",
    });
    assert.deepStrictEqual(settled(late), [failed]);
    assert.deepStrictEqual(
      blocks(late, secondId).map((block) => block.text),
      ["next"],
    );
    assert.deepStrictEqual([...late.assistant.keys()], [firstId, secondId]);
    assert.deepStrictEqual(reduceLiveChat(late, { type: "run-finished", outcome: "aborted" }).run, {
      kind: "finished",
      outcome: "aborted",
    });
  });

  it("preserves equal content with distinct IDs and acknowledges only the included ID", () => {
    const other = { ...repeated, id: secondId };
    const first = reduceLiveChat(emptyLiveChat(), { type: "message-settled", message: repeated });
    const both = reduceLiveChat(first, { type: "message-settled", message: other });
    assert.deepStrictEqual(settled(both), [repeated, other]);
    const missing = acknowledgeTranscript(both, []);
    assert.deepStrictEqual(settled(missing), [repeated, other]);
    const acknowledged = acknowledgeTranscript(missing, [
      { ...repeated, model: "normalized-model" },
    ]);
    assert.deepStrictEqual(settled(acknowledged), [other]);
    assert.deepStrictEqual(settled(acknowledgeTranscript(acknowledged, [other])), []);
  });

  it("acknowledges a live-first settlement without a baseline and ignores repeated settlement", () => {
    const first = reduceLiveChat(emptyLiveChat(), { type: "message-settled", message: repeated });
    const repeatedEvent = reduceLiveChat(first, { type: "message-settled", message: repeated });
    assert.deepStrictEqual(settled(repeatedEvent), [repeated]);
    const snapshot = acknowledgeTranscript(repeatedEvent, [repeated]);
    const late = reduceLiveChat(snapshot, { type: "message-settled", message: repeated });
    assert.deepStrictEqual(settled(late), []);
  });

  it("replaces a draft with a snapshot while retaining a newer draft and suppressing late events", () => {
    const first = reduceLiveChat(emptyLiveChat(), {
      type: "thinking-delta",
      messageId: firstId,
      contentIndex: 0,
      text: "plan",
    });
    const second = reduceLiveChat(first, {
      type: "text-delta",
      messageId: secondId,
      contentIndex: 0,
      text: "next",
    });
    const snapshot = acknowledgeTranscript(second, [repeated]);
    assert.deepStrictEqual(blocks(snapshot, firstId), []);
    assert.deepStrictEqual(
      blocks(snapshot, secondId).map((block) => block.text),
      ["next"],
    );
    const compacted = acknowledgeTranscript(snapshot, []);
    const finished = reduceLiveChat(compacted, { type: "run-finished", outcome: "completed" });
    const lateDelta = reduceLiveChat(finished, {
      type: "thinking-delta",
      messageId: firstId,
      contentIndex: 0,
      text: "late",
    });
    const lateSettlement = reduceLiveChat(lateDelta, {
      type: "message-settled",
      message: repeated,
    });
    assert.deepStrictEqual(blocks(lateSettlement, firstId), []);
    assert.deepStrictEqual(settled(lateSettlement), []);
    assert.deepStrictEqual(lateSettlement.run, { kind: "finished", outcome: "completed" });
  });

  for (const boundary of ["run-finished", "run-started"] as const) {
    it(`retains an orphan draft across ${boundary} until its own ID is acknowledged`, () => {
      const partial = reduceLiveChat(emptyLiveChat(), {
        type: "text-delta",
        messageId: firstId,
        contentIndex: 0,
        text: "orphan",
      });
      const retained = reduceLiveChat(
        partial,
        boundary === "run-finished" ? { type: boundary, outcome: "aborted" } : { type: boundary },
      );
      const next = reduceLiveChat(reduceLiveChat(retained, { type: "run-started" }), {
        type: "text-delta",
        messageId: secondId,
        contentIndex: 0,
        text: "next run",
      });
      const orphan = next.assistant.get(firstId);
      assert.strictEqual(orphan?.kind === "draft" ? orphan.phase : null, "retained");
      assert.deepStrictEqual(
        blocks(next, firstId).map((block) => block.text),
        ["orphan"],
      );
      const acknowledged = acknowledgeTranscript(next, [repeated]);
      assert.deepStrictEqual(blocks(acknowledged, firstId), []);
      assert.deepStrictEqual(
        blocks(acknowledged, secondId).map((block) => block.text),
        ["next run"],
      );
    });
  }

  for (const previous of ["unknown", "finished"] as const) {
    it(`does not revive a run when tool completion arrives after ${previous}`, () => {
      const initial =
        previous === "unknown"
          ? emptyLiveChat()
          : reduceLiveChat(emptyLiveChat(), { type: "run-finished", outcome: "completed" });
      const completed = reduceLiveChat(initial, {
        type: "tool-finished",
        toolCallId: "late",
        toolName: "read",
        status: "succeeded",
      });
      assert.strictEqual(completed.run.kind, previous);
    });
  }
});
