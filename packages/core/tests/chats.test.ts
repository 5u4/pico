import { describe, expect, it } from "bun:test";
import { isValidChatId } from "../src/agents/chats.ts";

describe("isValidChatId", () => {
  it("accepts ulid/alphanumeric ids", () => {
    expect(isValidChatId("01JQ8XZ9K3M2N4P5R6S7T8V9W0")).toBe(true);
    expect(isValidChatId("chat_123-abc")).toBe(true);
  });

  it("rejects empty and path-traversal ids", () => {
    expect(isValidChatId("")).toBe(false);
    expect(isValidChatId("..")).toBe(false);
    expect(isValidChatId("a/b")).toBe(false);
    expect(isValidChatId("../etc/passwd")).toBe(false);
    expect(isValidChatId("has space")).toBe(false);
  });
});
