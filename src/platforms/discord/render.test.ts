import { describe, expect, test } from "bun:test";
import type { Message } from "../../engine/message.ts";
import {
  DISCORD_MESSAGE_CAP,
  defangMentions,
  renderReply,
  splitToBudget,
} from "./render.ts";

describe("defangMentions", () => {
  test("neutralizes @everyone and @here", () => {
    expect(defangMentions("hi @everyone and @here")).toBe(
      "hi @\u200beveryone and @\u200bhere",
    );
  });

  test("neutralizes user and role mentions", () => {
    expect(defangMentions("ping <@123> and <@&456>")).toBe(
      "ping <@\u200b123> and <@&\u200b456>",
    );
  });

  test("leaves plain text untouched", () => {
    expect(defangMentions("no mentions here")).toBe("no mentions here");
  });
});

describe("splitToBudget", () => {
  test("keeps a short string as one chunk", () => {
    expect(splitToBudget("short", 100)).toEqual(["short"]);
  });

  test("returns nothing for an empty string", () => {
    expect(splitToBudget("", 100)).toEqual([]);
  });

  test("splits on a newline boundary when possible", () => {
    const text = `${"a".repeat(40)}\n${"b".repeat(40)}`;
    const chunks = splitToBudget(text, 50);
    expect(chunks).toEqual(["a".repeat(40), "b".repeat(40)]);
  });

  test("every chunk stays within budget", () => {
    const text = "x".repeat(5000);
    const chunks = splitToBudget(text, DISCORD_MESSAGE_CAP);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_CAP);
  });

  test("throws on a non-positive budget", () => {
    expect(() => splitToBudget("anything", 0)).toThrow("must be positive");
  });
});

describe("renderReply", () => {
  test("renders the last assistant message only", () => {
    const messages: Message[] = [
      { id: "m0", role: "assistant", parts: [{ type: "text", text: "first" }] },
      { id: "m1", role: "user", parts: [{ type: "text", text: "again" }] },
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "second" }],
      },
    ];
    expect(renderReply(messages)).toEqual(["second"]);
  });

  test("renders tool calls as truncated emoji lines", () => {
    const messages: Message[] = [
      {
        id: "m0",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "bash",
            args: { command: "ls" },
          },
          { type: "text", text: "done" },
        ],
      },
    ];
    const [chunk] = renderReply(messages);
    expect(chunk).toContain("🛠️ `bash`");
    expect(chunk).toContain("done");
  });

  test("flags an errored tool call", () => {
    const messages: Message[] = [
      {
        id: "m0",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "bash",
            args: {},
            isError: true,
          },
        ],
      },
    ];
    expect(renderReply(messages)[0]).toContain("⚠️ `bash`");
  });

  test("returns nothing when there is no assistant reply", () => {
    const messages: Message[] = [
      { id: "m0", role: "user", parts: [{ type: "text", text: "hi" }] },
    ];
    expect(renderReply(messages)).toEqual([]);
  });

  test("defangs mentions in the final reply", () => {
    const messages: Message[] = [
      {
        id: "m0",
        role: "assistant",
        parts: [{ type: "text", text: "cc @everyone" }],
      },
    ];
    expect(renderReply(messages)[0]).toBe("cc @\u200beveryone");
  });
});
