import { assert } from "@effect/vitest";
import type { MessageDelivery } from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import type { ApplicationError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { ApplicationCommandOptionTypes, InteractionTypes } from "discordeno";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { DiscordInputBot, DiscordInteraction } from "./discord-input.ts";
import type { DiscordMessage } from "./discord-prompt.ts";

export const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");

export const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");

export const defaultCwd = AbsolutePath.make("/tmp/pico-discord-input");

export const startedDelivery: MessageDelivery<ApplicationError> = {
  kind: "started",
  completed: Effect.void,
};

export const config = {
  token: Redacted.make("test"),
  allowedGuildIds: ["1"],
  defaultCwd,
  showToolCalls: false,
  showThinking: false,
} as const;

export const message = (overrides: Partial<DiscordMessage> = {}): DiscordMessage => ({
  guildId: 1n,
  author: { id: 100n },
  channelId: 10n,
  id: 11n,
  content: "hello",
  attachments: [],
  ...overrides,
});

export const handlerFor = (bot: DiscordInputBot) => {
  const handler = bot.events.messageCreate;
  assert.isFunction(handler);
  if (handler === undefined) throw new Error("Discord input handler was not installed");
  return handler;
};

export const bindOptions = (cwd: string) => [
  {
    name: "set",
    type: ApplicationCommandOptionTypes.SubCommand,
    options: [{ name: "cwd", type: ApplicationCommandOptionTypes.String, value: cwd }],
  },
];

export const interaction = (overrides: Partial<DiscordInteraction> = {}): DiscordInteraction => ({
  type: InteractionTypes.ApplicationCommand,
  guildId: 1n,
  channelId: 10n,
  user: { id: 100n },
  data: { name: "bind", options: bindOptions("/repo") },
  defer: async () => undefined,
  deferEdit: async () => undefined,
  edit: async () => undefined,
  respond: async () => undefined,
  ...overrides,
});

export const interactionHandlerFor = (bot: DiscordInputBot) => {
  const handler = bot.events.interactionCreate;
  assert.isFunction(handler);
  if (handler === undefined) throw new Error("Discord interaction handler was not installed");
  return handler;
};
