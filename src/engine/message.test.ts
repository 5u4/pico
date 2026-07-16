import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@oh-my-pi/pi-ai";
import {
  type Message,
  olderWindow,
  tailWindow,
  toMessages,
  toStreamMessage,
} from "./message.ts";

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function custom(content: string, display = true): AgentMessage {
  return {
    role: "custom",
    customType: "command:ping",
    content,
    display,
    timestamp: 0,
  } as AgentMessage;
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

describe("toMessages", () => {
  test("maps a user text message", () => {
    expect(toMessages([user("hello")])).toEqual([
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
    expect(toMessages(messages)[0]?.parts).toEqual([
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
    expect(toMessages(messages)[0]?.parts).toEqual([
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
    expect(toMessages(messages)[0]?.parts).toEqual([
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
    const part = toMessages(messages)[0]?.parts[0];
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
    expect(toMessages(messages)).toEqual([]);
  });

  test("indexes ids by original message position", () => {
    const messages: AgentMessage[] = [user("a"), user("b")];
    expect(toMessages(messages).map((m) => m.id)).toEqual(["m0", "m1"]);
  });

  test("coalesces consecutive assistant messages into one turn", () => {
    const messages: AgentMessage[] = [
      user("go"),
      assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: {} }]),
      toolResult("c1", "boom", true),
      assistant([{ type: "toolCall", id: "c2", name: "bash", arguments: {} }]),
      toolResult("c2", "ok"),
      assistant([{ type: "text", text: "done" }]),
    ];
    const ui = toMessages(messages);
    expect(ui.map((m) => m.id)).toEqual(["m0", "m1"]);
    expect(ui[1]?.parts).toEqual([
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "bash",
        args: {},
        result: "boom",
        isError: true,
      },
      {
        type: "tool-call",
        toolCallId: "c2",
        toolName: "bash",
        args: {},
        result: "ok",
        isError: false,
      },
      { type: "text", text: "done" },
    ]);
  });

  test("splits assistant turns across a user message", () => {
    const messages: AgentMessage[] = [
      user("a"),
      assistant([{ type: "text", text: "one" }]),
      user("b"),
      assistant([{ type: "text", text: "two" }]),
    ];
    expect(toMessages(messages).map((m) => m.id)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
    ]);
  });

  test("renders a displayed custom message as a system message", () => {
    expect(toMessages([custom("Pong hi")])).toEqual([
      { id: "m0", role: "system", parts: [{ type: "text", text: "Pong hi" }] },
    ]);
  });

  test("drops a hidden custom message", () => {
    expect(toMessages([custom("secret", false)])).toEqual([]);
  });

  test("flushes the assistant run before a custom message", () => {
    const messages: AgentMessage[] = [
      assistant([{ type: "text", text: "hi" }]),
      custom("Pong there"),
    ];
    expect(toMessages(messages)).toEqual([
      { id: "m0", role: "assistant", parts: [{ type: "text", text: "hi" }] },
      {
        id: "m1",
        role: "system",
        parts: [{ type: "text", text: "Pong there" }],
      },
    ]);
  });
});

describe("toStreamMessage", () => {
  test("id matches the coalesced snapshot turn id mid-stream", () => {
    const committed: AgentMessage[] = [
      user("go"),
      assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: {} }]),
      toolResult("c1", "boom", true),
    ];
    const stream = assistant([{ type: "text", text: "retry" }]);
    const tail = toStreamMessage(committed, stream);
    const snapshot = toMessages([...committed, stream]);
    expect(tail?.id).toBe("m1");
    expect(tail?.id).toBe(snapshot[snapshot.length - 1]?.id);
    expect(tail?.parts).toEqual(snapshot[snapshot.length - 1]?.parts);
  });

  test("ids the first live step at its future index", () => {
    const committed: AgentMessage[] = [user("go")];
    const stream = assistant([{ type: "text", text: "hi" }]);
    expect(toStreamMessage(committed, stream)?.id).toBe("m1");
  });
});

function msg(id: string): Message {
  return { id, role: "user", parts: [{ type: "text", text: id }] };
}

describe("tailWindow", () => {
  test("returns all with hasMore false when under the limit", () => {
    const all = [msg("m0"), msg("m1")];
    expect(tailWindow(all, 5)).toEqual({ window: all, hasMore: false });
  });

  test("keeps the last limit messages and flags hasMore", () => {
    const all = [msg("m0"), msg("m1"), msg("m2"), msg("m3")];
    const { window, hasMore } = tailWindow(all, 2);
    expect(window.map((m) => m.id)).toEqual(["m2", "m3"]);
    expect(hasMore).toBe(true);
  });
});

describe("olderWindow", () => {
  test("returns the page before the cursor and hasMore when more remain", () => {
    const all = [msg("m0"), msg("m1"), msg("m2"), msg("m3")];
    const { messages, hasMore } = olderWindow(all, "m3", 2);
    expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(hasMore).toBe(true);
  });

  test("stops at the start with hasMore false", () => {
    const all = [msg("m0"), msg("m1"), msg("m2")];
    const { messages, hasMore } = olderWindow(all, "m2", 5);
    expect(messages.map((m) => m.id)).toEqual(["m0", "m1"]);
    expect(hasMore).toBe(false);
  });

  test("empty when the cursor is the first message or missing", () => {
    const all = [msg("m0"), msg("m1")];
    expect(olderWindow(all, "m0", 5)).toEqual({ messages: [], hasMore: false });
    expect(olderWindow(all, "nope", 5)).toEqual({
      messages: [],
      hasMore: false,
    });
  });
});
