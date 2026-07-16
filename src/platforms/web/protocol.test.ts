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

  test("rejects an unknown command name", () => {
    expect(
      parseClientCommand({ kind: "command", name: "unknown" }),
    ).toBeUndefined();
  });

  test("rejects a malformed prompt", () => {
    expect(parseClientCommand({ kind: "prompt" })).toBeUndefined();
  });
});
