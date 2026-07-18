import { z } from "zod";
import type { ContextUsageInfo } from "../../engine/conversations";
import type { Message } from "../../engine/message";

export const commandSchema = z.discriminatedUnion("name", [
  z.object({
    kind: z.literal("command"),
    name: z.literal("ping"),
    text: z.string().optional(),
  }),
]);

export const clientCommandSchema = z.union([
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("prompt"), text: z.string().min(1) }),
    z.object({ kind: z.literal("abort") }),
    z.object({ kind: z.literal("select"), conversationId: z.string().min(1) }),
    z.object({
      kind: z.literal("create"),
      workspaceId: z.string().min(1),
      prompt: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal("createWorkspace"),
      label: z.string().min(1),
    }),
    z.object({
      kind: z.literal("renameWorkspace"),
      workspaceId: z.string().min(1),
      label: z.string().min(1),
    }),
    z.object({
      kind: z.literal("updateWorkspaceCwd"),
      workspaceId: z.string().min(1),
      cwd: z.string().min(1),
      worktree: z
        .object({
          defaultBranch: z.string().min(1),
          branchPrefix: z.string().min(1),
        })
        .nullable()
        .optional(),
    }),
    z.object({ kind: z.literal("archive"), conversationId: z.string().min(1) }),
    z.object({ kind: z.literal("draft") }),
    z.object({
      kind: z.literal("loadOlder"),
      conversationId: z.string().min(1),
      beforeId: z.string().min(1),
    }),
    z.object({ kind: z.literal("heartbeat") }),
  ]),
  commandSchema,
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type CommandCommand = z.infer<typeof commandSchema>;

export type ConversationSummary = {
  id: string;
  title: string | null;
  cwd: string;
  branch: string | null;
};

export type WorkspaceSummary = {
  id: string;
  label: string | null;
  cwd: string;
  worktree: boolean;
  defaultBranch: string | null;
  branchPrefix: string | null;
  conversations: ConversationSummary[];
};

export type ServerEvent =
  | {
      kind: "workspaces";
      items: WorkspaceSummary[];
      activeId: string | null;
      draftWorkspaceId?: string;
    }
  | {
      kind: "snapshot";
      conversationId: string;
      messages: Message[];
      isStreaming: boolean;
      usage: ContextUsageInfo | null;
      hasMore: boolean;
    }
  | {
      kind: "older";
      conversationId: string;
      messages: Message[];
      hasMore: boolean;
    }
  | {
      kind: "stream";
      conversationId: string;
      message: Message | null;
      isStreaming: boolean;
    }
  | { kind: "error"; message: string }
  | { kind: "attention"; conversationIds: string[] }
  | { kind: "heartbeatAck" };

export function parseClientCommand(raw: unknown): ClientCommand | undefined {
  const parsed = clientCommandSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
