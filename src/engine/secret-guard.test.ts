import { describe, expect, test } from "bun:test";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import { isSecretPath, secretGuard } from "./secret-guard.ts";

describe("isSecretPath", () => {
  test("blocks .env and env variants", () => {
    expect(isSecretPath(".env")).toBe(true);
    expect(isSecretPath(".env.local")).toBe(true);
    expect(isSecretPath(".env.production")).toBe(true);
    expect(isSecretPath("app/.env.e2e")).toBe(true);
  });

  test("allows env template files", () => {
    expect(isSecretPath(".env.example")).toBe(false);
    expect(isSecretPath(".env.e2e.example")).toBe(false);
    expect(isSecretPath(".env.sample")).toBe(false);
    expect(isSecretPath(".env.template")).toBe(false);
    expect(isSecretPath(".env.dist")).toBe(false);
  });

  test("blocks private keys and secret files", () => {
    expect(isSecretPath("/home/u/.ssh/id_rsa")).toBe(true);
    expect(isSecretPath("id_ed25519")).toBe(true);
    expect(isSecretPath("server.pem")).toBe(true);
    expect(isSecretPath("tls.key")).toBe(true);
    expect(isSecretPath("config/secrets.yml")).toBe(true);
    expect(isSecretPath(".npmrc")).toBe(true);
    expect(isSecretPath(".pypirc")).toBe(true);
  });

  test("allows ordinary source files", () => {
    expect(isSecretPath("src/index.ts")).toBe(false);
    expect(isSecretPath("README.md")).toBe(false);
    expect(isSecretPath("environment.ts")).toBe(false);
  });
});

type Handlers = {
  input?: (event: { text: string }) => unknown;
  tool_call?: (event: ToolCallEvent) => unknown;
  tool_result?: (event: ToolResultEvent) => unknown;
};

function collectHandlers(): Handlers {
  const handlers: Handlers = {};
  const pi = {
    on(event: string, handler: (e: never) => unknown) {
      const h = handler as (e: unknown) => unknown;
      if (event === "input") handlers.input = h as Handlers["input"];
      if (event === "tool_call")
        handlers.tool_call = h as Handlers["tool_call"];
      if (event === "tool_result")
        handlers.tool_result = h as Handlers["tool_result"];
    },
  } as unknown as ExtensionAPI;
  secretGuard(pi);
  return handlers;
}

function textResult(text: string): ToolResultEvent {
  const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
  return {
    type: "tool_result",
    toolCallId: "t1",
    toolName: "bash",
    input: {},
    content,
    isError: false,
    details: undefined,
  };
}

describe("secretGuard input handler", () => {
  test("scrubs secrets from inbound text", () => {
    const { input } = collectHandlers();
    const out = input?.({
      text: "my key ghp_16C7e42F292c6912E7710c838347Ae178B4a ok",
    });
    expect(out).toEqual({ text: "my key [REDACTED] ok" });
  });

  test("returns nothing for clean text", () => {
    const { input } = collectHandlers();
    expect(input?.({ text: "just a normal message" })).toBeUndefined();
  });
});

describe("secretGuard tool_call handler", () => {
  test("blocks read of a secret path", () => {
    const { tool_call } = collectHandlers();
    const event: ToolCallEvent = {
      type: "tool_call",
      toolCallId: "t1",
      toolName: "read",
      input: { path: ".env" },
    };
    const out = tool_call?.(event) as { block?: boolean } | undefined;
    expect(out?.block).toBe(true);
  });

  test("blocks grep of a secret path", () => {
    const { tool_call } = collectHandlers();
    const event: ToolCallEvent = {
      type: "tool_call",
      toolCallId: "t1",
      toolName: "grep",
      input: { pattern: "KEY", path: ".env.local" },
    };
    const out = tool_call?.(event) as { block?: boolean } | undefined;
    expect(out?.block).toBe(true);
  });

  test("allows read of a template env file", () => {
    const { tool_call } = collectHandlers();
    const event: ToolCallEvent = {
      type: "tool_call",
      toolCallId: "t1",
      toolName: "read",
      input: { path: ".env.example" },
    };
    expect(tool_call?.(event)).toBeUndefined();
  });

  test("does not guard glob", () => {
    const { tool_call } = collectHandlers();
    const event: ToolCallEvent = {
      type: "tool_call",
      toolCallId: "t1",
      toolName: "glob",
      input: { path: ".env" },
    };
    expect(tool_call?.(event)).toBeUndefined();
  });
});

describe("secretGuard tool_result handler", () => {
  test("redacts secrets in tool output", () => {
    const { tool_result } = collectHandlers();
    const out = tool_result?.(
      textResult("leaked sk-abcdefghijklmnopqrstuvwxyz0123 here"),
    ) as { content?: TextContent[] } | undefined;
    expect(out?.content?.[0]?.text).toBe("leaked [REDACTED] here");
  });

  test("returns nothing when output is clean", () => {
    const { tool_result } = collectHandlers();
    expect(tool_result?.(textResult("all good, no secrets"))).toBeUndefined();
  });
});
