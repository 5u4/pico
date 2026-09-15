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

const toolCall = (
  id: string,
  argumentsJson = "{}",
): Extract<AgentAssistantMessage["content"][number], { readonly type: "tool-call" }> => ({
  type: "tool-call",
  id,
  name: "read",
  argumentsJson,
});

const toolResult = (
  toolCallId: string,
  content: AgentToolResultMessage["content"],
  status: AgentToolResultMessage["status"] = "succeeded",
): AgentToolResultMessage => ({
  role: "tool-result",
  toolCallId,
  toolName: "read",
  content,
  status,
  timestamp: 2,
});

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
        item.kind === "assistant"
          ? item.blocks.map((block) => block.id)
          : item.kind === "tool-group"
            ? item.calls.flatMap((call) => [call.id, `details-${call.id}`])
            : [],
      ),
    );
    const opened = items([], running, disclosures);
    assert.deepStrictEqual(
      opened.flatMap((item) =>
        item.kind === "tool-group"
          ? [
              {
                open: item.open,
                states: item.calls.map((call) => call.state.kind),
                details: item.calls.map((call) => call.open),
              },
            ]
          : [],
      ),
      [{ open: true, states: ["running"], details: [true] }],
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
        presentation.flatMap((item) =>
          item.kind === "tool-group"
            ? [
                {
                  id: item.id,
                  open: item.open,
                  calls: item.calls.map((call) => ({
                    id: call.id,
                    open: call.open,
                    state: call.state.kind,
                  })),
                },
              ]
            : [],
        ),
        [
          {
            id: "tool-read-file",
            open: true,
            calls: [{ id: "tool-read-file", open: true, state: "running" }],
          },
        ],
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
    assert.strictEqual(tools[0]?.id, fallback[0]?.id);
    assert.strictEqual(tools[0]?.open, true);
    assert.strictEqual(tools[0]?.calls[0]?.output, "file contents");
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

describe("tool trace grouping", () => {
  it("groups consecutive same-name calls without crossing assistant content or message boundaries", () => {
    const presentation = items(
      [
        {
          ...toolMessage,
          content: [
            toolCall("a"),
            toolCall("b"),
            { type: "text", text: "between" },
            toolCall("c"),
            { type: "thinking", text: "next step" },
            toolCall("d"),
            { type: "image", data: "", mimeType: "image/png" },
            toolCall("e"),
          ],
        },
        { ...toolMessage, id: secondId, content: [toolCall("f")] },
        {
          ...toolMessage,
          id: AgentMessageId.make("failed"),
          status: "failed",
          stopReason: "error",
          message: "Stopped here",
          content: [toolCall("g")],
        },
      ],
      emptyLiveChat(),
    );
    assert.deepStrictEqual(
      presentation.map((item) =>
        item.kind === "tool-group"
          ? item.calls.map((call) => call.id)
          : item.kind === "assistant"
            ? item.blocks.map((block) => block.kind)
            : item.kind,
      ),
      [
        ["tool-a", "tool-b"],
        ["text"],
        ["tool-c"],
        ["thinking"],
        ["tool-d"],
        ["text"],
        ["tool-e"],
        ["tool-f"],
        ["tool-g"],
        "notice",
      ],
    );
  });

  it("keeps result fallbacks on their side of users, live fallbacks, and notices", () => {
    let live = emptyLiveChat();
    for (const toolCallId of ["live-a", "live-b"]) {
      live = reduceLiveChat(live, {
        type: "tool-started",
        toolCallId,
        toolName: "read",
        argumentsJson: "{}",
      });
    }
    live = reduceLiveChat(live, {
      type: "notice",
      level: "warning",
      message: "Connection interrupted",
    });
    const presentation = items(
      [
        toolResult("before-a", []),
        toolResult("before-b", []),
        { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 3 },
        toolResult("after", []),
      ],
      live,
    );
    assert.deepStrictEqual(
      presentation.map((item) =>
        item.kind === "tool-group" ? item.calls.map((call) => call.id) : item.kind,
      ),
      [
        ["tool-before-a", "tool-before-b"],
        "user",
        ["tool-after"],
        ["tool-live-a", "tool-live-b"],
        "notice",
      ],
    );
  });

  it("preserves member-based expansion through settlement prepend and split, then closes each group", () => {
    let running = emptyLiveChat();
    for (const toolCallId of ["b", "c"]) {
      running = reduceLiveChat(running, {
        type: "tool-started",
        toolCallId,
        toolName: "read",
        argumentsJson: "{}",
      });
    }
    const pending = items([], running).filter((item) => item.kind === "tool-group");
    const disclosures = new Set([
      ...pending.flatMap((group) => group.calls.map((call) => call.id)),
      "details-tool-b",
    ]);
    const opened = items([], running, disclosures).filter((item) => item.kind === "tool-group");
    assert.deepStrictEqual(
      opened.map((group) => ({ id: group.id, open: group.open })),
      [{ id: "tool-b", open: true }],
    );
    const message: AgentAssistantMessage = {
      ...toolMessage,
      content: [toolCall("a"), toolCall("b"), { type: "text", text: "between" }, toolCall("c")],
    };
    const settled = reduceLiveChat(running, { type: "message-settled", message });
    const snapshot = acknowledgeTranscript(settled, [message]);
    for (const presentation of [
      items([], settled, disclosures),
      items([message], snapshot, disclosures),
    ]) {
      const groups = presentation.filter((item) => item.kind === "tool-group");
      assert.deepStrictEqual(
        groups.map((group) => ({ id: group.id, open: group.open })),
        [
          { id: "tool-a", open: true },
          { id: "tool-c", open: true },
        ],
      );
      assert.deepStrictEqual(
        groups.flatMap((group) => group.calls.filter((call) => call.open).map((call) => call.id)),
        ["tool-b"],
      );
    }
    const regrouped = items([message], snapshot, disclosures).filter(
      (item) => item.kind === "tool-group",
    );
    const closed = new Set(disclosures);
    for (const group of regrouped) {
      for (const call of group.calls) closed.delete(call.id);
    }
    const closedGroups = items([message], snapshot, closed).filter(
      (item) => item.kind === "tool-group",
    );
    assert.deepStrictEqual(
      closedGroups.map((group) => group.open),
      [false, false],
    );
    assert.strictEqual(closedGroups[0]?.calls[1]?.open, true);
  });

  it("emits one anchored call when results precede snapshot or settled-live anchors", () => {
    const message: AgentAssistantMessage = {
      ...toolMessage,
      content: [toolCall("read-file")],
    };
    const first = toolResult("read-file", [{ type: "text", text: "first output" }]);
    const last = toolResult("read-file", [{ type: "text", text: "last output" }], "failed");
    const settled = reduceLiveChat(emptyLiveChat(), { type: "message-settled", message });
    for (const presentation of [
      items([first, message, last], emptyLiveChat()),
      items([first, last], settled),
    ]) {
      const calls = presentation.flatMap((item) => (item.kind === "tool-group" ? item.calls : []));
      assert.deepStrictEqual(
        calls.map((call) => ({ id: call.id, output: call.output, state: call.state.kind })),
        [{ id: "tool-read-file", output: "first output\nlast output", state: "failed" }],
      );
    }
  });
});

describe("tool trace content", () => {
  it("preserves mixed states and distinguishes empty output from output not yet available", () => {
    let live = emptyLiveChat();
    for (const toolCallId of ["failed", "finished", "running"]) {
      live = reduceLiveChat(live, {
        type: "tool-started",
        toolCallId,
        toolName: "read",
        argumentsJson: "{}",
      });
    }
    live = reduceLiveChat(live, {
      type: "tool-finished",
      toolCallId: "finished",
      toolName: "read",
      status: "succeeded",
    });
    const message: AgentAssistantMessage = {
      ...toolMessage,
      content: [toolCall("failed"), toolCall("finished"), toolCall("running"), toolCall("unknown")],
    };
    const transcript = [message, toolResult("failed", [], "failed")];
    const group = items(transcript, live).find((item) => item.kind === "tool-group");
    assert.strictEqual(group?.open, false);
    assert.deepStrictEqual(
      group?.calls.map((call) => ({ state: call.state.kind, output: call.output })),
      [
        { state: "failed", output: "" },
        { state: "succeeded", output: undefined },
        { state: "running", output: undefined },
        { state: "unknown", output: undefined },
      ],
    );
    for (const state of ["failed", "running", "unknown", "complete"]) {
      assert.include(group?.title ?? "", state);
    }
    const reconnecting = presentTranscript(AsyncResult.success(transcript), live, new Set(), {
      kind: "opening",
    });
    const reconnectingCalls =
      reconnecting.state === "ready"
        ? reconnecting.items.flatMap((item) => (item.kind === "tool-group" ? item.calls : []))
        : [];
    assert.deepStrictEqual(
      reconnectingCalls.map((call) => call.state.kind),
      ["failed", "succeeded", "unknown", "unknown"],
    );
  });

  it("selects intent and concrete argument fields while retaining raw malformed and non-object input", () => {
    const argumentsCases = [
      ['{"i":"Reading the module","path":"file.ts"}', "Reading the module"],
      ['{"i":7,"path":"file.ts"}', "file.ts"],
      ['{"i":" ","command":"bun run check"}', "bun run check"],
      ['{"query":"thinking trace"}', "thinking trace"],
      ['{"pattern":"onDisclosuresChange"}', "onDisclosuresChange"],
      ['{"i":', '{"i":'],
      ['[{"i":"not an object"}]', '[{"i":"not an object"}]'],
      ["null", "null"],
      ['{"path":{"nested":true}}', '{"path":{"nested":true}}'],
    ];
    const content = argumentsCases.map(([argumentsJson], index) =>
      toolCall(`summary-${index}`, argumentsJson),
    );
    const presentation = items([{ ...toolMessage, content }], emptyLiveChat());
    const calls = presentation.flatMap((item) => (item.kind === "tool-group" ? item.calls : []));
    assert.deepStrictEqual(
      calls.map((call) => [call.arguments, call.summary]),
      argumentsCases,
    );
    const liveArguments = '{\n  "path": "retained.ts",\n  "other": "full arguments"\n}';
    const started = reduceLiveChat(emptyLiveChat(), {
      type: "tool-started",
      toolCallId: "retained",
      toolName: "read",
      argumentsJson: liveArguments,
    });
    const finished = reduceLiveChat(started, {
      type: "tool-finished",
      toolCallId: "retained",
      toolName: "read",
      status: "succeeded",
    });
    const retained = items([toolResult("unavailable", [])], finished).flatMap((item) =>
      item.kind === "tool-group" ? item.calls : [],
    );
    assert.deepStrictEqual(
      retained.map((call) => call.arguments),
      [undefined, liveArguments],
    );
  });
});
