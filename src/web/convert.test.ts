import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@oh-my-pi/pi-ai";
import { toUiMessages } from "./convert.ts";

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function toolResult(
  toolCallId: string,
  text: string,
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  };
}

describe("toUiMessages", () => {
  test("maps a user text message", () => {
    expect(toUiMessages([user("hello")])).toEqual([
      { id: "m0", role: "user", parts: [{ type: "text", text: "hello" }] },
    ]);
  });

  test("maps assistant text and thinking to distinct parts", () => {
    const messages: AgentMessage[] = [
      assistant([
        { type: "thinking", thinking: "pondering" },
        { type: "text", text: "answer" },
      ]),
    ];
    expect(toUiMessages(messages)[0]?.parts).toEqual([
      { type: "reasoning", text: "pondering" },
      { type: "text", text: "answer" },
    ]);
  });

  test("stitches a tool call to its result by toolCallId", () => {
    const messages: AgentMessage[] = [
      assistant([
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "." },
        },
      ]),
      toolResult("call-1", "file listing"),
    ];
    expect(toUiMessages(messages)[0]?.parts).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "." },
        result: "file listing",
        isError: false,
      },
    ]);
  });

  test("leaves result undefined when the tool has not returned", () => {
    const messages: AgentMessage[] = [
      assistant([
        { type: "toolCall", id: "call-2", name: "read", arguments: {} },
      ]),
    ];
    expect(toUiMessages(messages)[0]?.parts).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "read",
        args: {},
        result: undefined,
        isError: undefined,
      },
    ]);
  });

  test("propagates a tool error flag", () => {
    const messages: AgentMessage[] = [
      assistant([{ type: "toolCall", id: "c", name: "read", arguments: {} }]),
      toolResult("c", "boom", true),
    ];
    const part = toUiMessages(messages)[0]?.parts[0];
    expect(part).toMatchObject({
      type: "tool-call",
      isError: true,
      result: "boom",
    });
  });

  test("drops empty messages and standalone tool results", () => {
    const messages: AgentMessage[] = [
      user(""),
      assistant([{ type: "text", text: "" }]),
      toolResult("orphan", "ignored"),
    ];
    expect(toUiMessages(messages)).toEqual([]);
  });

  test("indexes ids by original message position", () => {
    const messages: AgentMessage[] = [user("a"), user("b")];
    expect(toUiMessages(messages).map((m) => m.id)).toEqual(["m0", "m1"]);
  });
});
