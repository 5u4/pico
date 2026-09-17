import { assert } from "@effect/vitest";
import type { MessageDelivery } from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import type { ApplicationError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { ApplicationCommandOptionTypes, InteractionTypes } from "discordeno";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as DiscordAcknowledgement from "./discord-acknowledgement.ts";
import type { DiscordInputBot, DiscordInteraction } from "./discord-input.ts";
import type { DiscordMessage } from "./discord-prompt.ts";

export const acknowledgeInteraction = DiscordAcknowledgement.make(async () => undefined);

export const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");

export const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");

export const defaultCwd = AbsolutePath.make("/tmp/pico-discord-input");

export const boundWorkspace: Workspace.Workspace = {
  id: workspaceId,
  name: "general",
  platform: "discord",
  externalId: "1.10",
  defaultCwd,
  worktree: null,
  modelOverride: null,
  createdAt: 0,
};

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

export const modelOptions = (value: string, focused = false) => [
  { name: "model", type: ApplicationCommandOptionTypes.String, value, focused },
];

export const interaction = (overrides: Partial<DiscordInteraction> = {}): DiscordInteraction => ({
  id: 1n,
  token: "interaction-token",
  acknowledged: false,
  type: InteractionTypes.ApplicationCommand,
  guildId: 1n,
  channelId: 10n,
  user: { id: 100n },
  data: { name: "bind", options: bindOptions("/repo") },
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

export const modelSuggestions = Effect.fn("test.modelSuggestions")(function* (
  bot: DiscordInputBot,
  command: DiscordInteraction,
) {
  const responded =
    yield* Deferred.make<NonNullable<Parameters<DiscordInteraction["respond"]>[0]["choices"]>>();
  interactionHandlerFor(bot)({
    ...command,
    type: InteractionTypes.ApplicationCommandAutocomplete,
    edit: async () => {
      throw new Error("autocomplete cannot edit a response");
    },
    respond: async (response) => {
      assert.isUndefined(response.content);
      assert.isUndefined(response.flags);
      Deferred.doneUnsafe(responded, Effect.succeed(response.choices ?? []));
    },
  });
  return yield* Deferred.await(responded);
});

export const privateCommandReply = Effect.fn("test.privateCommandReply")(function* (
  bot: DiscordInputBot,
  command: DiscordInteraction,
) {
  const edited = yield* Deferred.make<string>();
  const reply: DiscordInteraction = {
    ...command,
    respond: async () => {
      throw new Error("a command must defer before replying");
    },
    edit: async (response) => {
      assert.isTrue(reply.acknowledged);
      assert.deepStrictEqual(response.allowedMentions, { parse: [], repliedUser: false });
      Deferred.doneUnsafe(edited, Effect.succeed(response.content ?? ""));
    },
  };
  interactionHandlerFor(bot)(reply);
  return yield* Deferred.await(edited);
});
