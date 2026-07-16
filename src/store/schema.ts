import { z } from "zod";

export const platformSchema = z.enum(["web", "discord"]);
export type Platform = z.infer<typeof platformSchema>;

export const workspaceSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  platform: platformSchema,
  label: z.string().nullable(),
  externalId: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const conversationSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  title: z.string().nullable(),
  titleSource: z.enum(["provisional", "final"]).nullable(),
  externalId: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;
