import { z } from "zod";

export const clientCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), text: z.string().min(1) }),
  z.object({ kind: z.literal("abort") }),
  z.object({ kind: z.literal("select"), conversationId: z.string().min(1) }),
  z.object({ kind: z.literal("create"), title: z.string().min(1).optional() }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;

export type ConversationSummary = {
  id: string;
  title: string | null;
};

export type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type UiPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: JsonObject;
      result?: string;
      isError?: boolean;
    };

export type UiMessage = {
  id: string;
  role: "user" | "assistant";
  parts: UiPart[];
};

export type ServerEvent =
  | { kind: "conversations"; items: ConversationSummary[]; activeId: string }
  | {
      kind: "snapshot";
      conversationId: string;
      messages: UiMessage[];
      isStreaming: boolean;
    }
  | { kind: "error"; message: string };

export function parseClientCommand(raw: unknown): ClientCommand | undefined {
  const parsed = clientCommandSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
