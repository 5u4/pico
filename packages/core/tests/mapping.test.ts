import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { toChatEvent, toChatMessage } from "../src/agents/mapping.ts";

describe("toChatEvent", () => {
  it("maps a text_delta assistant event", () => {
    const event = {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: { role: "assistant", content: [] },
      },
    } as unknown as AgentSessionEvent;
    expect(toChatEvent(event)).toEqual({ _tag: "text_delta", delta: "hello" });
  });

  it("maps a thinking_delta assistant event", () => {
    const event = {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "pondering",
        partial: { role: "assistant", content: [] },
      },
    } as unknown as AgentSessionEvent;
    expect(toChatEvent(event)).toEqual({
      _tag: "thinking_delta",
      delta: "pondering",
    });
  });

  it("maps an assistant error event to an error ChatEvent", () => {
    const event = {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "error",
        reason: "aborted",
        error: { role: "assistant", content: [{ type: "text", text: "boom" }] },
      },
    } as unknown as AgentSessionEvent;
    expect(toChatEvent(event)).toEqual({
      _tag: "error",
      reason: "aborted",
      message: "boom",
    });
  });

  it("maps tool_execution_start and tool_execution_end", () => {
    const start = {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "x" },
    } as unknown as AgentSessionEvent;
    expect(toChatEvent(start)).toEqual({
      _tag: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "x" },
    });

    const end = {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read",
      result: "file contents",
      isError: false,
    } as unknown as AgentSessionEvent;
    expect(toChatEvent(end)).toEqual({
      _tag: "tool_execution_end",
      toolCallId: "c1",
      toolName: "read",
      result: "file contents",
      isError: false,
    });
  });

  it("maps the agent and turn lifecycle events", () => {
    const lifecycle: Array<[string, string]> = [
      ["agent_start", "agent_start"],
      ["agent_end", "agent_end"],
      ["turn_start", "turn_start"],
      ["turn_end", "turn_end"],
    ];
    for (const [piType, tag] of lifecycle) {
      const event = {
        type: piType,
        messages: [],
      } as unknown as AgentSessionEvent;
      expect(toChatEvent(event)).toEqual({ _tag: tag });
    }
  });

  it("stringifies a non-string tool result", () => {
    const end = {
      type: "tool_execution_end",
      toolCallId: "c2",
      toolName: "eval",
      result: { value: 42 },
      isError: true,
    } as unknown as AgentSessionEvent;
    expect(toChatEvent(end)).toEqual({
      _tag: "tool_execution_end",
      toolCallId: "c2",
      toolName: "eval",
      result: '{"value":42}',
      isError: true,
    });
  });

  it("drops events outside the narrow contract", () => {
    const dropped: AgentSessionEvent[] = [
      { type: "message_start" } as unknown as AgentSessionEvent,
      { type: "message_end" } as unknown as AgentSessionEvent,
      { type: "tool_execution_update" } as unknown as AgentSessionEvent,
      {
        type: "notice",
        level: "info",
        message: "x",
      } as unknown as AgentSessionEvent,
      {
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "text_start",
          contentIndex: 0,
          partial: { role: "assistant", content: [] },
        },
      } as unknown as AgentSessionEvent,
    ];
    for (const event of dropped) {
      expect(toChatEvent(event)).toBeNull();
    }
  });
});

describe("toChatMessage", () => {
  it("extracts text from an assistant parts array", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "part one " },
        { type: "text", text: "part two" },
      ],
    } as unknown as AgentMessage;
    expect(toChatMessage(message)).toEqual({
      role: "assistant",
      text: "part one part two",
    });
  });

  it("handles a bare-string user content", () => {
    const message = {
      role: "user",
      content: "just text",
    } as unknown as AgentMessage;
    expect(toChatMessage(message)).toEqual({ role: "user", text: "just text" });
  });

  it("drops non user/assistant roles", () => {
    const toolResult = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: "x" }],
    } as unknown as AgentMessage;
    expect(toChatMessage(toolResult)).toBeNull();
  });
});
