import type { Static } from "@oh-my-pi/pi-ai";
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ChatId } from "@pico/contract/chat-model";
import type { BrowserManager } from "./browser-manager.ts";

export const browserParameters = (Type: ExtensionAPI["typebox"]["Type"]) => {
  const selector = Type.String({ minLength: 1 });
  const timeout = Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 }));
  const empty = <Op extends "back" | "forward" | "reload" | "viewer" | "close" | "checkpoint">(
    op: Op,
  ) => Type.Object({ op: Type.Literal(op) }, { additionalProperties: false });
  return Type.Union([
    Type.Object(
      {
        op: Type.Literal("open"),
        url: Type.Optional(Type.String({ minLength: 1 })),
        userRequested: Type.Optional(Type.Literal(true)),
      },
      { additionalProperties: false },
    ),
    empty("back"),
    empty("forward"),
    empty("reload"),
    empty("viewer"),
    empty("close"),
    empty("checkpoint"),
    Type.Object(
      { op: Type.Literal("remember_login"), userApproved: Type.Literal(true) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("mode"),
        mode: Type.Union([Type.Literal("headless"), Type.Literal("headed")]),
        userRequested: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("snapshot"),
        interactive: Type.Optional(Type.Boolean()),
        compact: Type.Optional(Type.Boolean()),
        urls: Type.Optional(Type.Boolean()),
        selector: Type.Optional(selector),
        maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Union([
          Type.Literal("click"),
          Type.Literal("dblclick"),
          Type.Literal("hover"),
          Type.Literal("focus"),
          Type.Literal("check"),
          Type.Literal("uncheck"),
          Type.Literal("scrollintoview"),
        ]),
        selector,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Union([Type.Literal("fill"), Type.Literal("type")]),
        selector,
        text: Type.String(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("press"), key: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("select"), selector, values: Type.Array(Type.String(), { minItems: 1 }) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("scroll"),
        direction: Type.Union([
          Type.Literal("up"),
          Type.Literal("down"),
          Type.Literal("left"),
          Type.Literal("right"),
        ]),
        amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
        selector: Type.Optional(selector),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("drag"), source: selector, target: selector },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("upload"),
        selector,
        files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        userApproved: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("get"),
        what: Type.Union([
          Type.Literal("url"),
          Type.Literal("title"),
          Type.Literal("html"),
          Type.Literal("text"),
          Type.Literal("value"),
          Type.Literal("count"),
        ]),
        selector: Type.Optional(selector),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("wait"),
        condition: Type.Union([
          Type.Literal("selector"),
          Type.Literal("text"),
          Type.Literal("url"),
          Type.Literal("function"),
          Type.Literal("load"),
        ]),
        value: Type.String({ minLength: 1 }),
        timeoutMs: timeout,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("eval"), script: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("screenshot"),
        fullPage: Type.Optional(Type.Boolean()),
        selector: Type.Optional(selector),
        annotate: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("tabs"), action: Type.Literal("list") },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("tabs"),
        action: Type.Literal("new"),
        url: Type.Optional(Type.String({ minLength: 1 })),
        userRequested: Type.Optional(Type.Literal(true)),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("tabs"),
        action: Type.Union([Type.Literal("select"), Type.Literal("close")]),
        tabId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { op: Type.Literal("frame"), selector: Type.Union([selector, Type.Null()]) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("dialog"),
        response: Type.Union([
          Type.Literal("status"),
          Type.Literal("accept"),
          Type.Literal("dismiss"),
        ]),
        promptText: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  ]);
};
export type BrowserOperation = Static<ReturnType<typeof browserParameters>>;

export const makeBrowserExtension =
  ({
    manager,
    chatId,
    rootSessionId,
  }: {
    readonly manager: BrowserManager;
    readonly chatId: ChatId;
    readonly rootSessionId: string;
  }): ExtensionFactory =>
  (api) => {
    api.registerTool({
      name: "pico_browser",
      label: "Browser",
      description:
        "Use this session's isolated Pico browser. Read skill://pico-browser first. Headless by default. Direct file: previews through open or tabs/new require an explicit user request and userRequested:true; preview permission does not authorize uploading or transmitting the file. upload requires explicit user approval to send the files and userApproved:true. viewer returns a local interactive login link; end the turn and resume after the user's next message. mode requires an explicit user request and restarts the browser. checkpoint saves this owner's login after the user completes login and repairs failed restore state. remember_login requires user approval and publishes ALL saved sites as the seed for future new owners. Never use a raw browser CLI or select another owner. eval runs page JavaScript only.",
      approval: "exec",
      parameters: browserParameters(api.typebox.Type),
      execute: async (_id, params, signal, _update, ctx) => {
        try {
          const sessionId = ctx.sessionManager.getSessionId();
          const result = await manager.execute(
            {
              chatId,
              instance:
                sessionId === rootSessionId ? { kind: "main" } : { kind: "child", sessionId },
            },
            params,
            signal,
          );
          return { content: result, details: {}, isError: false };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Browser operation failed: ${error instanceof Error ? error.message : "Unknown browser error"}`,
              },
            ],
            details: {},
            isError: true,
          };
        }
      },
    });
  };
