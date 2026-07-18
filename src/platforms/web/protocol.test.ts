import { describe, expect, test } from "bun:test";
import { parseClientCommand } from "./protocol";

describe("parseClientCommand", () => {
  test("parses a plain prompt command", () => {
    expect(parseClientCommand({ kind: "prompt", text: "hi" })).toEqual({
      kind: "prompt",
      text: "hi",
    });
  });

  test("parses a ping command with text", () => {
    expect(
      parseClientCommand({ kind: "command", name: "ping", text: "hello" }),
    ).toEqual({ kind: "command", name: "ping", text: "hello" });
  });

  test("parses a ping command without text", () => {
    expect(parseClientCommand({ kind: "command", name: "ping" })).toEqual({
      kind: "command",
      name: "ping",
    });
  });

  test("parses a heartbeat command", () => {
    expect(parseClientCommand({ kind: "heartbeat" })).toEqual({
      kind: "heartbeat",
    });
  });

  test("parses a searchFiles command", () => {
    expect(
      parseClientCommand({ kind: "searchFiles", query: "adapter", seq: 3 }),
    ).toEqual({ kind: "searchFiles", query: "adapter", seq: 3 });
  });

  test("rejects a searchFiles command with a negative seq", () => {
    expect(
      parseClientCommand({ kind: "searchFiles", query: "x", seq: -1 }),
    ).toBeUndefined();
  });

  test("rejects an unknown command name", () => {
    expect(
      parseClientCommand({ kind: "command", name: "unknown" }),
    ).toBeUndefined();
  });

  test("rejects a malformed prompt", () => {
    expect(parseClientCommand({ kind: "prompt" })).toBeUndefined();
  });
});
