import { assert, describe, it } from "@effect/vitest";
import {
  type AgentAssistantMessage,
  AgentMessageId,
  type AgentTranscript,
} from "@pico/contract/agent-message";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
  acknowledgeTranscript,
  emptyLiveChat,
  type LiveChat,
  reduceLiveChat,
} from "../../frontend-state/src/chat-state.ts";
import { presentTranscript } from "./transcript-presentation.ts";

const firstId = AgentMessageId.make("first");
const secondId = AgentMessageId.make("second");
const toolMessage: AgentAssistantMessage = {
  id: firstId,
  role: "assistant",
  status: "completed",
  stopReason: "tool-use",
  content: [
    { type: "thinking", text: "plan" },
    { type: "tool-call", id: "read-file", name: "read", argumentsJson: '{"path":"file.ts"}' },
    { type: "text", text: "after tool" },
  ],
  model: "test",
  timestamp: 1,
};

const items = (transcript: AgentTranscript, live: LiveChat, disclosures = new Set<string>()) => {
  const presentation = presentTranscript(AsyncResult.success(transcript), live, disclosures, {
    kind: "active",
  });
  return presentation.state === "ready" ? presentation.items : [];
};

describe("transcript identity", () => {
  it("keeps thinking and tool disclosures through live-first snapshot handoff without duplicate anchors", () => {
    const running = reduceLiveChat(emptyLiveChat(), {
      type: "tool-started",
      toolCallId: "read-file",
      toolName: "read",
      argumentsJson: '{"path":"file.ts"}',
    });
    const live = reduceLiveChat(running, { type: "message-settled", message: toolMessage });
    const pending = items([], live);
    assert.deepStrictEqual(
      pending.map((item) => item.kind),
      ["assistant", "tool-group", "assistant"],
    );
    const disclosures = new Set(
      pending.flatMap((item) =>
        item.kind === "assistant" ? item.blocks.map((block) => block.id) : [item.id],
      ),
    );
    const acknowledged = acknowledgeTranscript(live, [toolMessage]);
    const snapshot = items([toolMessage], acknowledged, disclosures);
    assert.deepStrictEqual(
      snapshot.map((item) => item.id),
      pending.map((item) => item.id),
    );
    assert.deepStrictEqual(
      snapshot.flatMap((item) =>
        item.kind === "assistant" ? item.blocks.map((block) => block.text) : [],
      ),
      ["plan", "after tool"],
    );
    assert.deepStrictEqual(
      snapshot.flatMap((item) =>
        item.kind === "assistant"
          ? item.blocks.flatMap((block) => (block.kind === "thinking" ? [block.open] : []))
          : [],
      ),
      [true],
    );
    assert.deepStrictEqual(
      snapshot.flatMap((item) => (item.kind === "tool-group" ? [item.open] : [])),
      [true],
    );
    assert.deepStrictEqual(
      snapshot.flatMap((item) =>
        item.kind === "tool-group" ? item.calls.map((call) => call.state.kind) : [],
      ),
      ["running"],
    );
  });

  it("replaces snapshot-owned drafts and suppresses late events while keeping equal content with another ID", () => {
    const message: AgentAssistantMessage = {
      ...toolMessage,
      stopReason: "stop",
      content: [{ type: "thinking", text: "same plan" }],
    };
    const first = reduceLiveChat(emptyLiveChat(), {
      type: "thinking-delta",
      messageId: firstId,
      contentIndex: 0,
      text: "same plan",
    });
    const original = items([], first);
    const second = reduceLiveChat(first, {
      type: "thinking-delta",
      messageId: secondId,
      contentIndex: 0,
      text: "same plan",
    });
    const acknowledged = acknowledgeTranscript(second, [message]);
    const lateDelta = reduceLiveChat(acknowledged, {
      type: "thinking-delta",
      messageId: firstId,
      contentIndex: 0,
      text: "late",
    });
    const lateSettlement = reduceLiveChat(lateDelta, { type: "message-settled", message });
    const snapshot = items([message], lateSettlement);
    assert.deepStrictEqual(
      snapshot.map((item) => item.kind),
      ["assistant", "assistant"],
    );
    assert.strictEqual(snapshot[0]?.id, original[0]?.id);
    assert.notStrictEqual(snapshot[0]?.id, snapshot[1]?.id);
    assert.deepStrictEqual(
      snapshot.flatMap((item) =>
        item.kind === "assistant" ? item.blocks.map((block) => block.text) : [],
      ),
      ["same plan", "same plan"],
    );
    const settled = reduceLiveChat(lateSettlement, {
      type: "message-settled",
      message: { ...message, id: secondId },
    });
    const handedOff = items(
      [message, { ...message, id: secondId }],
      acknowledgeTranscript(settled, [message, { ...message, id: secondId }]),
    );
    assert.deepStrictEqual(
      handedOff.map((item) => item.id),
      snapshot.map((item) => item.id),
    );
  });

  it("keeps orphan output ordered and retained rather than streaming during the next run", () => {
    const partial = reduceLiveChat(emptyLiveChat(), {
      type: "thinking-delta",
      messageId: firstId,
      contentIndex: 0,
      text: "orphan plan",
    });
    const finished = reduceLiveChat(partial, { type: "run-finished", outcome: "aborted" });
    const running = reduceLiveChat(finished, { type: "run-started" });
    const next = reduceLiveChat(running, {
      type: "text-delta",
      messageId: secondId,
      contentIndex: 0,
      text: "next answer",
    });
    const presentation = items([], next);
    assert.deepStrictEqual(
      presentation.flatMap((item) =>
        item.kind === "assistant"
          ? [{ state: item.state.kind, text: item.blocks.map((block) => block.text) }]
          : [],
      ),
      [
        { state: "unknown", text: ["orphan plan"] },
        { state: "streaming", text: ["next answer"] },
      ],
    );
  });
});
