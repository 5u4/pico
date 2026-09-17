import { assert, describe, it } from "@effect/vitest";
import {
  type AgentAssistantMessage,
  AgentMessageId,
  type AgentToolResultMessage,
  type AgentTranscript,
} from "@pico/contract/agent-message";
import type { TodoState } from "@pico/contract/agent-runtime";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import {
  acknowledgeTranscript,
  emptyLiveChat,
  type LiveChat,
  reduceLiveChat,
} from "../../frontend-state/src/chat-state.ts";
import { normalizeTranscript } from "../../omp/src/agent-event.ts";
import { presentTodo, presentTranscript } from "./transcript-presentation.ts";

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

const items = (
  transcript: AgentTranscript,
  live: LiveChat,
  disclosures: ReadonlyMap<string, boolean> = new Map(),
) => {
  const presentation = presentTranscript(
    AsyncResult.success(transcript),
    live,
    disclosures,
    {
      kind: "active",
    },
    { kind: "unavailable" },
  );
  return presentation.state === "ready" ? presentation.items : [];
};

const thinkingBlocks = (presentation: ReturnType<typeof items>) =>
  presentation.flatMap((item) =>
    item.kind === "assistant" ? item.blocks.filter((block) => block.kind === "thinking") : [],
  );

describe("transcript identity", () => {
  it("keeps manually opened thinking and tool disclosures through settlement and snapshot handoff", () => {
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
    const disclosures = new Map(
      pending
        .flatMap((item) =>
          item.kind === "assistant"
            ? item.blocks.map((block) => block.id)
            : item.kind === "tool-group"
              ? item.calls.flatMap((call) => [call.id, `details-${call.id}`])
              : [],
        )
        .map((id) => [id, true]),
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
    const disclosures = new Map(pending.map((item) => [item.id, true]));
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
      fallback.filter((item) => item.kind !== "waiting").map((item) => item.id),
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
      snapshot.filter((item) => item.kind !== "waiting").map((item) => item.kind),
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
      handedOff.filter((item) => item.kind !== "waiting").map((item) => item.id),
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
    assert.deepStrictEqual(
      items([], running).map((item) => (item.kind === "assistant" ? item.state.kind : item.kind)),
      ["unknown", "waiting"],
    );
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
    assert.deepInclude(thinkingBlocks(presentation)[0], {
      open: false,
      label: "Thinking status unknown",
    });
  });
});

describe("disclosure lifecycle", () => {
  it("follows the final sorted thinking block until later content or settlement unless manually closed", () => {
    const current = reduceLiveChat(emptyLiveChat(), {
      type: "thinking-delta",
      messageId: firstId,
      contentIndex: 2,
      text: "current plan",
    });
    const draft = reduceLiveChat(current, {
      type: "thinking-delta",
      messageId: firstId,
      contentIndex: 0,
      text: "earlier plan",
    });
    assert.deepStrictEqual(
      thinkingBlocks(items([], draft)).map((block) => ({
        text: block.text,
        label: block.label,
        open: block.open,
      })),
      [
        { text: "earlier plan", label: "Thought", open: false },
        { text: "current plan", label: "Thinking", open: true },
      ],
    );
    const closed = new Map([["assistant-first-content-2", false]]);
    const continued = reduceLiveChat(draft, {
      type: "thinking-delta",
      messageId: firstId,
      contentIndex: 2,
      text: " continued",
    });
    assert.deepInclude(thinkingBlocks(items([], continued, closed))[1], {
      text: "current plan continued",
      label: "Thinking",
      open: false,
    });
    const disconnected = presentTranscript(
      AsyncResult.success([]),
      draft,
      new Map(),
      {
        kind: "unavailable",
        cause: Cause.empty,
      },
      { kind: "unavailable" },
    );
    assert.strictEqual(disconnected.state, "ready");
    if (disconnected.state !== "ready") return;
    assert.deepStrictEqual(
      thinkingBlocks(disconnected.items).map((block) => ({ label: block.label, open: block.open })),
      [
        { label: "Thought", open: false },
        { label: "Thinking status unknown", open: false },
      ],
    );
    const answering = reduceLiveChat(draft, {
      type: "text-delta",
      messageId: firstId,
      contentIndex: 3,
      text: "answer",
    });
    const message: AgentAssistantMessage = {
      ...toolMessage,
      content: [
        { type: "thinking", text: "earlier plan" },
        { type: "text", text: "context" },
        { type: "thinking", text: "current plan" },
      ],
    };
    const settled = reduceLiveChat(draft, { type: "message-settled", message });
    for (const presentation of [
      items([], answering),
      items([], settled),
      items([message], acknowledgeTranscript(settled, [message])),
    ]) {
      assert.deepStrictEqual(
        thinkingBlocks(presentation).map((block) => ({ label: block.label, open: block.open })),
        [
          { label: "Thought", open: false },
          { label: "Thought", open: false },
        ],
      );
    }
  });

  it("keeps tool groups open for running siblings while preserving each member's manual choice", () => {
    const first = reduceLiveChat(emptyLiveChat(), {
      type: "tool-started",
      toolCallId: "a",
      toolName: "read",
      argumentsJson: "{}",
    });
    const closed = new Map([["tool-a", false]]);
    assert.strictEqual(
      items([], first, closed).find((item) => item.kind === "tool-group")?.open,
      false,
    );
    const siblings = reduceLiveChat(first, {
      type: "tool-started",
      toolCallId: "b",
      toolName: "read",
      argumentsJson: "{}",
    });
    const expanded = items([], siblings, closed).find((item) => item.kind === "tool-group");
    assert.strictEqual(expanded?.open, true);
    assert.deepStrictEqual(
      expanded?.calls.map((call) => call.open),
      [false, false],
    );
    closed.set("tool-b", false);
    assert.strictEqual(
      items([], siblings, closed).find((item) => item.kind === "tool-group")?.open,
      false,
    );
    const oneFinished = reduceLiveChat(siblings, {
      type: "tool-finished",
      toolCallId: "a",
      toolName: "read",
      status: "succeeded",
    });
    assert.strictEqual(
      items([], oneFinished).find((item) => item.kind === "tool-group")?.open,
      true,
    );
    const finished = reduceLiveChat(oneFinished, {
      type: "tool-finished",
      toolCallId: "b",
      toolName: "read",
      status: "failed",
    });
    assert.strictEqual(items([], finished).find((item) => item.kind === "tool-group")?.open, false);
    const opened = new Map([["tool-a", true]]);
    const transcript = [
      { ...toolMessage, content: [toolCall("a"), toolCall("b")] },
      toolResult("a", []),
      toolResult("b", [], "failed"),
    ];
    for (const presentation of [
      items([], finished, opened),
      items(transcript, acknowledgeTranscript(finished, transcript), opened),
    ]) {
      assert.strictEqual(presentation.find((item) => item.kind === "tool-group")?.open, true);
    }
  });
});

describe("response activity", () => {
  it("shows waiting from an active run before history or a first delta and removes it when activity ends", () => {
    const running = reduceLiveChat(emptyLiveChat(), { type: "run-started" });
    const waiting = presentTranscript(
      AsyncResult.initial(),
      running,
      new Map(),
      {
        kind: "active",
      },
      { kind: "unavailable" },
    );
    assert.strictEqual(waiting.state, "ready");
    if (waiting.state !== "ready") return;
    assert.deepStrictEqual(
      waiting.items.map((item) => item.kind),
      ["waiting"],
    );

    const disconnected = presentTranscript(
      AsyncResult.success([]),
      running,
      new Map(),
      {
        kind: "unavailable",
        cause: Cause.empty,
      },
      { kind: "unavailable" },
    );
    assert.strictEqual(disconnected.state, "empty");
    const reconnecting = presentTranscript(
      AsyncResult.success([]),
      running,
      new Map(),
      {
        kind: "opening",
      },
      { kind: "unavailable" },
    );
    assert.strictEqual(reconnecting.state, "empty");
    const completed = reduceLiveChat(running, { type: "run-finished", outcome: "completed" });
    assert.deepStrictEqual(items([], completed), []);
  });

  it("lets drafts and running tools replace waiting and resumes waiting between completed activities", () => {
    const running = reduceLiveChat(emptyLiveChat(), { type: "run-started" });
    const draft = reduceLiveChat(running, {
      type: "thinking-delta",
      messageId: firstId,
      contentIndex: 0,
      text: "Planning",
    });
    assert.deepStrictEqual(
      items([], draft).map((item) => item.kind),
      ["assistant"],
    );
    const settled = reduceLiveChat(draft, { type: "message-settled", message: toolMessage });
    assert.deepStrictEqual(
      items([], settled).map((item) => (item.kind === "assistant" ? item.state.kind : item.kind)),
      ["complete", "tool-group", "complete", "waiting"],
    );
    const toolRunning = reduceLiveChat(settled, {
      type: "tool-started",
      toolCallId: "read-file",
      toolName: "read",
      argumentsJson: "{}",
    });
    assert.deepStrictEqual(
      items([], toolRunning).map((item) => item.kind),
      ["assistant", "tool-group", "assistant"],
    );
    const toolFinished = reduceLiveChat(toolRunning, {
      type: "tool-finished",
      toolCallId: "read-file",
      toolName: "read",
      status: "succeeded",
    });
    const afterTool = items([], toolFinished);
    assert.deepStrictEqual(
      afterTool.map((item) => item.kind),
      ["assistant", "tool-group", "assistant", "waiting"],
    );
    assert.deepStrictEqual(
      items([toolMessage], acknowledgeTranscript(toolFinished, [toolMessage])),
      afterTool,
    );
    const result = toolResult("read-file", [{ type: "text", text: "file content" }]);
    assert.deepStrictEqual(
      items([result], toolRunning).map((item) => item.kind),
      ["assistant", "tool-group", "assistant", "waiting"],
    );
  });

  it("settles or interrupts live feedback without changing received text or replaying retained blocks", () => {
    const text = "  first\n\tsecond 😀 ";
    const draft = reduceLiveChat(emptyLiveChat(), {
      type: "text-delta",
      messageId: firstId,
      contentIndex: 0,
      text,
    });
    const active = items([], draft);
    assert.deepStrictEqual(
      active.map((item) => (item.kind === "assistant" ? item.state.kind : item.kind)),
      ["streaming"],
    );
    const disconnected = presentTranscript(
      AsyncResult.success([]),
      draft,
      new Map(),
      {
        kind: "unavailable",
        cause: Cause.empty,
      },
      { kind: "unavailable" },
    );
    assert.strictEqual(disconnected.state, "ready");
    if (disconnected.state !== "ready") return;
    const aborted = reduceLiveChat(draft, { type: "run-finished", outcome: "aborted" });
    for (const presentation of [disconnected.items, items([], aborted)]) {
      assert.deepStrictEqual(
        presentation.map((item) => (item.kind === "assistant" ? item.state.kind : item.kind)),
        ["unknown"],
      );
      assert.deepStrictEqual(
        presentation.flatMap((item) =>
          item.kind === "assistant" ? item.blocks.map((block) => block.text) : [],
        ),
        [text],
      );
    }
    const message: AgentAssistantMessage = {
      ...toolMessage,
      stopReason: "stop",
      content: [{ type: "text", text }],
    };
    const settled = reduceLiveChat(draft, { type: "message-settled", message });
    const finished = reduceLiveChat(settled, { type: "run-finished", outcome: "completed" });
    const snapshot = items([message], acknowledgeTranscript(finished, [message]));
    assert.deepStrictEqual(
      snapshot.map((item) => (item.kind === "assistant" ? item.state.kind : item.kind)),
      ["complete"],
    );
    assert.deepStrictEqual(
      snapshot.flatMap((item) =>
        item.kind === "assistant" ? item.blocks.map((block) => block.text) : [],
      ),
      [text],
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
    const disclosures = new Map(
      [...pending.flatMap((group) => group.calls.map((call) => call.id)), "details-tool-b"].map(
        (id) => [id, true],
      ),
    );
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
    const closed = new Map(disclosures);
    for (const group of regrouped) {
      for (const call of group.calls) closed.set(call.id, false);
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
    assert.strictEqual(group?.open, true);
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
    const reconnecting = presentTranscript(
      AsyncResult.success(transcript),
      live,
      new Map(),
      {
        kind: "opening",
      },
      { kind: "unavailable" },
    );
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

describe("canonical todo presentation", () => {
  const ready: TodoState = {
    kind: "ready",
    phases: [{ name: "Build", tasks: [{ content: "Ship", status: "in_progress" }] }],
  };
  type NativeResult = Extract<
    Parameters<typeof normalizeTranscript>[0][number],
    { readonly role: "toolResult" }
  >;
  const result = (id: string, overrides: Partial<NativeResult> = {}): AgentTranscript =>
    normalizeTranscript([
      {
        role: "toolResult",
        toolCallId: id,
        toolName: "todo",
        content: [{ type: "text", text: `Output for ${id}` }],
        details: { op: "done", phases: [], storage: "session" },
        isError: false,
        timestamp: 2,
        ...overrides,
      },
    ]);
  const render = (messages: AgentTranscript, todo: TodoState, live = emptyLiveChat()) => {
    const presentation = presentTranscript(
      AsyncResult.success(messages),
      live,
      new Map(),
      { kind: "active" },
      todo,
    );
    return presentation.state === "ready" ? presentation.items : [];
  };

  it("suppresses successful direct snapshots before grouping and keeps adjacent prose together", () => {
    const messages: AgentTranscript = [
      {
        ...toolMessage,
        content: [
          { type: "text", text: "Before" },
          { ...toolCall("direct"), name: "todo" },
          { type: "text", text: "After" },
          toolCall("read-a"),
          { ...toolCall("legacy"), name: "todo" },
          toolCall("read-b"),
        ],
      },
      ...result("direct"),
      ...result("legacy", { details: { phases: [], storage: "session" } }),
    ];
    const shown = render(messages, ready);
    assert.deepStrictEqual(
      shown.map((item) =>
        item.kind === "tool-group"
          ? item.calls.map((call) => call.id)
          : item.kind === "assistant"
            ? item.blocks.map((block) => block.kind === "text" && block.text)
            : item.kind,
      ),
      [
        ["Before", "After"],
        ["tool-read-a", "tool-read-b"],
      ],
    );
    assert.deepStrictEqual(render(messages, { kind: "ready", phases: [] }), shown);
    assert.deepStrictEqual(
      render(messages, { kind: "unavailable" }).flatMap((item) =>
        item.kind === "tool-group" ? item.calls.map((call) => call.id) : [],
      ),
      ["tool-direct", "tool-read-a", "tool-legacy", "tool-read-b"],
    );
  });

  it("keeps errors, unsupported results, views, eval and unsettled calls inspectable", () => {
    const messages: AgentTranscript = [
      ...result("hidden"),
      ...result("failure", { isError: true }),
      ...result("view", { details: { op: "view", phases: [], storage: "session" } }),
      ...result("unknown-op", { details: { op: "future", phases: [], storage: "session" } }),
      ...result("unknown-status", {
        details: {
          op: "done",
          phases: [{ name: "Build", tasks: [{ content: "Ship", status: "future" }] }],
          storage: "session",
        },
      }),
      ...result("mixed-image", {
        content: [
          { type: "text", text: "Keep mixed output" },
          { type: "image", data: "", mimeType: "image/png" },
        ],
      }),
      ...result("multiple", { isError: true }),
      ...result("multiple"),
      ...result("eval", { toolName: "eval" }),
    ];
    let live = reduceLiveChat(emptyLiveChat(), {
      type: "tool-started",
      toolCallId: "unsettled",
      toolName: "todo",
      argumentsJson: "{}",
    });
    live = reduceLiveChat(live, {
      type: "tool-finished",
      toolCallId: "unsettled",
      toolName: "todo",
      status: "succeeded",
    });
    const calls = render(messages, ready, live).flatMap((item) =>
      item.kind === "tool-group" ? item.calls : [],
    );
    assert.deepStrictEqual(
      calls.map((call) => call.id),
      [
        "tool-failure",
        "tool-view",
        "tool-unknown-op",
        "tool-unknown-status",
        "tool-mixed-image",
        "tool-multiple",
        "tool-eval",
        "tool-unsettled",
      ],
    );
    assert.strictEqual(calls.find((call) => call.id === "tool-failure")?.state.kind, "failed");
    assert.strictEqual(
      calls.find((call) => call.id === "tool-multiple")?.output,
      "Output for multiple\nOutput for multiple",
    );
    assert.strictEqual(calls.find((call) => call.id === "tool-unsettled")?.output, undefined);
  });

  it("retains finished checklists without counting skipped tasks as completed and hides clear", () => {
    const finished: TodoState = {
      kind: "ready",
      phases: [
        {
          name: "Build",
          tasks: [
            { content: "Ship", status: "completed" },
            { content: "Optional", status: "abandoned" },
          ],
        },
      ],
    };
    const checklist = presentTodo(finished, false);
    assert.isNotNull(checklist);
    assert.strictEqual(checklist?.completed, 1);
    assert.strictEqual(checklist?.total, 2);
    assert.isNull(presentTodo({ kind: "ready", phases: [] }, true));
    assert.isNull(presentTodo({ kind: "ready", phases: [{ name: "Build", tasks: [] }] }, true));
    assert.isNull(presentTodo({ kind: "unavailable" }, true));
  });
});
