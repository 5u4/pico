import { assert, describe, it } from "@effect/vitest";
import {
  type AgentAssistantMessage,
  AgentMessageId,
  type AgentToolResultMessage,
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
  it("keeps thinking and tool disclosures open from running through settlement and snapshot handoff", () => {
    const draft = reduceLiveChat(emptyLiveChat(), {
      type: "thinking-delta",
      messageId: firstId,
      contentIndex: 0,
      text: "plan",
    });
    const running = reduceLiveChat(draft, {
      type: "tool-started",
      toolCallId: "read-file",
      toolName: "read",
      argumentsJson: '{"path":"file.ts"}',
    });
    const pending = items([], running);
    assert.deepStrictEqual(
      pending.map((item) => item.kind),
      ["assistant", "tool-group"],
    );
    const disclosures = new Set(
      pending.flatMap((item) =>
        item.kind === "assistant" ? item.blocks.map((block) => block.id) : [item.id],
      ),
    );
    const opened = items([], running, disclosures);
    assert.deepStrictEqual(
      opened.flatMap((item) =>
        item.kind === "tool-group"
          ? [{ open: item.open, states: item.calls.map((call) => call.state.kind) }]
          : [],
      ),
      [{ open: true, states: ["running"] }],
    );
    assert.deepStrictEqual(
      opened.flatMap((item) =>
        item.kind === "assistant"
          ? item.blocks.flatMap((block) => (block.kind === "thinking" ? [block.open] : []))
          : [],
      ),
      [true],
    );
    const live = reduceLiveChat(running, { type: "message-settled", message: toolMessage });
    const settled = items([], live, disclosures);
    const acknowledged = acknowledgeTranscript(live, [toolMessage]);
    const snapshot = items([toolMessage], acknowledged, disclosures);
    for (const presentation of [settled, snapshot]) {
      assert.deepStrictEqual(
        presentation.map((item) => item.kind),
        ["assistant", "tool-group", "assistant"],
      );
      assert.deepStrictEqual(
        presentation.flatMap((item) => (item.kind === "tool-group" ? [item] : [])),
        opened.flatMap((item) => (item.kind === "tool-group" ? [item] : [])),
      );
      assert.deepStrictEqual(
        presentation.flatMap((item) =>
          item.kind === "assistant"
            ? item.blocks.flatMap((block) =>
                block.kind === "thinking" ? [{ id: block.id, open: block.open }] : [],
              )
            : [],
        ),
        opened.flatMap((item) =>
          item.kind === "assistant"
            ? item.blocks.flatMap((block) =>
                block.kind === "thinking" ? [{ id: block.id, open: block.open }] : [],
              )
            : [],
        ),
      );
      assert.deepStrictEqual(
        presentation.flatMap((item) =>
          item.kind === "assistant" ? item.blocks.map((block) => block.text) : [],
        ),
        ["plan", "after tool"],
      );
    }
    assert.deepStrictEqual(
      snapshot.map((item) => item.id),
      settled.map((item) => item.id),
    );
  });

  it("keeps a result-only tool disclosure open when its assistant anchor arrives without merging distinct calls", () => {
    const running = reduceLiveChat(emptyLiveChat(), {
      type: "tool-started",
      toolCallId: "read-file",
      toolName: "read",
      argumentsJson: '{"path":"file.ts"}',
    });
    const pending = items([], running);
    const disclosures = new Set(pending.map((item) => item.id));
    const result: AgentToolResultMessage = {
      role: "tool-result",
      toolCallId: "read-file",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      status: "succeeded",
      timestamp: 2,
    };
    const fallback = items([result], running, disclosures);
    assert.deepStrictEqual(
      fallback.map((item) => item.id),
      pending.map((item) => item.id),
    );
    assert.deepStrictEqual(
      fallback.flatMap((item) =>
        item.kind === "tool-group"
          ? [{ open: item.open, outputs: item.calls.map((call) => call.output) }]
          : [],
      ),
      [{ open: true, outputs: ["file contents"] }],
    );
    const message: AgentAssistantMessage = {
      ...toolMessage,
      content: [
        ...toolMessage.content,
        {
          type: "tool-call",
          id: "read-file-again",
          name: "read",
          argumentsJson: '{"path":"file.ts"}',
        },
      ],
    };
    const transcript = [message, result];
    const snapshot = items(transcript, acknowledgeTranscript(running, transcript), disclosures);
    assert.deepStrictEqual(
      snapshot.map((item) => item.kind),
      ["assistant", "tool-group", "assistant", "tool-group"],
    );
    const tools = snapshot.filter((item) => item.kind === "tool-group");
    assert.deepStrictEqual(tools[0], fallback[0]);
    assert.notStrictEqual(tools[0]?.id, tools[1]?.id);
    assert.notStrictEqual(tools[0]?.calls[0]?.id, tools[1]?.calls[0]?.id);
    assert.strictEqual(tools[1]?.open, false);
    assert.deepStrictEqual(
      tools.map((item) => item.calls.map((call) => call.label)),
      [["read"], ["read"]],
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
