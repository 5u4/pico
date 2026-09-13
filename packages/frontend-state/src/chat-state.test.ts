import { assert, describe, it } from "@effect/vitest";
import type { AgentAssistantMessage } from "@pico/contract/agent-message";
import { acknowledgeTranscript, emptyLiveChat, reduceLiveChat } from "./chat-state.ts";

const repeated: AgentAssistantMessage = {
  role: "assistant",
  status: "completed",
  stopReason: "stop",
  content: [{ type: "text", text: "repeated" }],
  model: "test",
  timestamp: 1,
};

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

  it("retains assistant settlement beside the next draft without clearing on tool settlement", () => {
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
    assert.deepStrictEqual(
      afterAssistant.pending.map((entry) =>
        entry.kind === "message" ? entry.message.content : [],
      ),
      [[{ type: "text", text: "partial" }]],
    );
    const next = reduceLiveChat(afterAssistant, {
      type: "text-delta",
      contentIndex: 4,
      text: "next",
    });
    assert.strictEqual(next.blocks.get(4)?.text, "next");
    assert.deepStrictEqual(next.pending, afterAssistant.pending);
    assert.strictEqual(afterAssistant.run.kind, "running");
    assert.deepStrictEqual(
      reduceLiveChat(afterAssistant, {
        type: "run-finished",
        outcome: "aborted",
      }).run,
      { kind: "finished", outcome: "aborted" },
    );
  });

  it("requires a second occurrence for an equal settlement after acknowledging the first", () => {
    const running = reduceLiveChat(emptyLiveChat(), { type: "run-started" }, []);
    const first = reduceLiveChat(running, { type: "message-settled", message: repeated }, []);
    const acknowledged = acknowledgeTranscript(first, [repeated], first.pending);
    assert.deepStrictEqual(acknowledged.pending, []);
    const second = reduceLiveChat(acknowledged, { type: "message-settled", message: repeated }, [
      repeated,
    ]);
    const missing = acknowledgeTranscript(second, [repeated], second.pending);
    assert.deepStrictEqual(
      missing.pending.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
      [repeated],
    );
    assert.deepStrictEqual(
      acknowledgeTranscript(missing, [repeated, repeated], missing.pending).pending,
      [],
    );
  });

  it("carries unresolved occurrence targets across runs without recounting their snapshot", () => {
    const running = reduceLiveChat(emptyLiveChat(), { type: "run-started" }, []);
    const first = reduceLiveChat(running, { type: "message-settled", message: repeated }, []);
    const second = reduceLiveChat(first, { type: "message-settled", message: repeated }, []);
    const nextRun = reduceLiveChat(second, { type: "run-started" }, [repeated]);
    const third = reduceLiveChat(nextRun, { type: "message-settled", message: repeated }, [
      repeated,
    ]);
    const missing = acknowledgeTranscript(third, [repeated, repeated], third.pending);
    assert.deepStrictEqual(
      missing.pending.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
      [repeated],
    );
    assert.deepStrictEqual(
      acknowledgeTranscript(missing, [repeated, repeated, repeated], missing.pending).pending,
      [],
    );
  });

  it("retains unknown occurrence targets through later snapshots and inherited equal settlements", () => {
    const draft = reduceLiveChat(emptyLiveChat(), {
      type: "text-delta",
      contentIndex: 0,
      text: "repeated",
    });
    const first = reduceLiveChat(draft, { type: "message-settled", message: repeated }, [repeated]);
    const missing = acknowledgeTranscript(first, [repeated, repeated], first.pending);
    assert.deepStrictEqual(
      missing.pending.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
      [repeated],
    );
    const nextRun = reduceLiveChat(missing, { type: "run-started" }, [repeated, repeated]);
    const second = reduceLiveChat(nextRun, { type: "message-settled", message: repeated }, [
      repeated,
      repeated,
    ]);
    const ambiguous = acknowledgeTranscript(second, [repeated, repeated, repeated], second.pending);
    assert.deepStrictEqual(
      ambiguous.pending.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
      [repeated, repeated],
    );
  });

  for (const boundary of ["run-finished", "run-started"] as const) {
    it(`retains an orphan draft across ${boundary} and the next run`, () => {
      const partial = reduceLiveChat(emptyLiveChat(), {
        type: "text-delta",
        contentIndex: 0,
        text: "orphan",
      });
      const sealed = reduceLiveChat(
        partial,
        boundary === "run-finished" ? { type: boundary, outcome: "aborted" } : { type: boundary },
      );
      const next = reduceLiveChat(reduceLiveChat(sealed, { type: "run-started" }), {
        type: "text-delta",
        contentIndex: 0,
        text: "next run",
      });
      assert.deepStrictEqual(
        next.pending.flatMap((entry) =>
          entry.kind === "blocks" ? [...entry.blocks.values()].map((block) => block.text) : [],
        ),
        ["orphan"],
      );
      assert.strictEqual(next.blocks.get(0)?.text, "next run");
    });
  }

  for (const previous of ["unknown", "finished"] as const) {
    it(`marks running when tool completion arrives after ${previous}`, () => {
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
      assert.strictEqual(completed.run.kind, "running");
      assert.deepStrictEqual(completed.tools.get("late"), {
        kind: "finished",
        start: null,
        end: { type: "tool-finished", toolCallId: "late", toolName: "read", status: "succeeded" },
      });
    });
  }
});
