import { assert, describe, it } from "@effect/vitest";
import { AbsolutePath } from "@pico/contract/path";
import {
  type CreateApplicationCommand,
  DiscordApplicationIntegrationType,
  DiscordInteractionContextType,
} from "discordeno";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as DiscordCommand from "./discord-command.ts";
import { type DiscordStartupBot, openBot } from "./layer.ts";

const config = {
  token: Redacted.make("test"),
  allowedGuildIds: ["1", "2"],
  defaultCwd: AbsolutePath.make("/tmp/pico-discord-startup"),
  showToolCalls: false,
  showThinking: false,
} as const;

type Call =
  | { readonly kind: "start" }
  | { readonly kind: "global"; readonly commands: ReadonlyArray<CreateApplicationCommand> }
  | {
      readonly kind: "guild";
      readonly guildId: string;
      readonly commands: ReadonlyArray<CreateApplicationCommand>;
    }
  | { readonly kind: "shutdown" };

const makeBot = (
  joinedGuildIds: ReadonlyArray<string>,
  failGuildId?: string,
): {
  readonly bot: DiscordStartupBot;
  readonly collectedGuildIds: Set<string>;
  readonly calls: Array<Call>;
} => {
  const calls: Array<Call> = [];
  const collectedGuildIds = new Set<string>();
  const bot = {
    start: async () => {
      calls.push({ kind: "start" });
      for (const guildId of joinedGuildIds) collectedGuildIds.add(guildId);
    },
    shutdown: async () => {
      calls.push({ kind: "shutdown" });
    },
    helpers: {
      upsertGlobalApplicationCommands: async (commands) => {
        calls.push({ kind: "global", commands });
        return [];
      },
      upsertGuildApplicationCommands: async (guildId, commands) => {
        const normalizedGuildId = guildId.toString();
        calls.push({ kind: "guild", guildId: normalizedGuildId, commands });
        if (normalizedGuildId === failGuildId) throw new Error("reconciliation failed");
        return [];
      },
    },
  } satisfies DiscordStartupBot;
  return { bot, collectedGuildIds, calls };
};

describe("Discord startup", () => {
  it.effect("reconciles pico's complete command ownership and shuts down on release", () =>
    Effect.gen(function* () {
      const harness = makeBot(["1", "2", "3"]);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* openBot(harness.bot, config, harness.collectedGuildIds);
          assert.deepStrictEqual(harness.calls, [
            { kind: "start" },
            { kind: "global", commands: DiscordCommand.directMessageCommands },
            { kind: "guild", guildId: "1", commands: DiscordCommand.applicationCommands },
            { kind: "guild", guildId: "2", commands: DiscordCommand.applicationCommands },
            { kind: "guild", guildId: "3", commands: [] },
          ]);
          const global = harness.calls.find((call) => call.kind === "global");
          assert.isDefined(global);
          assert.deepStrictEqual(global?.commands.map(({ name }) => name).sort(), [
            "context",
            "shake",
          ]);
          for (const command of global?.commands ?? []) {
            assert.deepStrictEqual(command.contexts, [DiscordInteractionContextType.BotDm]);
            assert.deepStrictEqual(command.integrationTypes, [
              DiscordApplicationIntegrationType.GuildInstall,
            ]);
          }
        }),
      );

      assert.deepStrictEqual(harness.calls.at(-1), { kind: "shutdown" });
      assert.strictEqual(harness.calls.filter((call) => call.kind === "global").length, 1);
    }),
  );

  it.effect(
    "starts DM-only mode and removes guild commands without requiring guild membership",
    () =>
      Effect.gen(function* () {
        const harness = makeBot(["3"]);
        yield* Effect.scoped(
          openBot(harness.bot, { ...config, allowedGuildIds: [] }, harness.collectedGuildIds),
        );
        assert.deepStrictEqual(harness.calls, [
          { kind: "start" },
          { kind: "global", commands: DiscordCommand.directMessageCommands },
          { kind: "guild", guildId: "3", commands: [] },
          { kind: "shutdown" },
        ]);
      }),
  );

  it.effect("fails missing allowed guilds and cleans up the connected bot", () =>
    Effect.gen(function* () {
      const harness = makeBot(["1", "3"]);
      const exit = yield* Effect.exit(
        Effect.scoped(openBot(harness.bot, config, harness.collectedGuildIds)),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(harness.calls, [{ kind: "start" }, { kind: "shutdown" }]);
    }),
  );

  it.effect("cleans up before propagating a reconciliation failure", () =>
    Effect.gen(function* () {
      const harness = makeBot(["1", "2", "3"], "2");
      const exit = yield* Effect.exit(
        Effect.scoped(openBot(harness.bot, config, harness.collectedGuildIds)),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(harness.calls, [
        { kind: "start" },
        { kind: "global", commands: DiscordCommand.directMessageCommands },
        { kind: "guild", guildId: "1", commands: DiscordCommand.applicationCommands },
        { kind: "guild", guildId: "2", commands: DiscordCommand.applicationCommands },
        { kind: "shutdown" },
      ]);
    }),
  );
  it.effect("retains reconciliation context while reporting independent rollback failure", () =>
    Effect.gen(function* () {
      const harness = makeBot(["1", "2"]);
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
      const bot: DiscordStartupBot = {
        ...harness.bot,
        id: 999n,
        helpers: {
          ...harness.bot.helpers,
          upsertGuildApplicationCommands: () =>
            Promise.reject({
              status: 403,
              body: '{"code":50013,"message":"private-startup-body"}',
            }),
        },
        shutdown: () => Promise.reject({ status: 504, body: "private-shutdown-body" }),
      };
      const failure = yield* Effect.flip(
        Effect.scoped(openBot(bot, config, harness.collectedGuildIds)),
      ).pipe(Effect.provide(Logger.layer([logger])));
      assert.strictEqual(failure.operation, "register-guild-commands");
      assert.strictEqual(failure.guildId, "1");
      assert.strictEqual(failure.status, 403);
      assert.strictEqual(failure.discordCode, 50013);
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0]?.annotations.operation, "stop-bot");
      assert.strictEqual(logs[0]?.annotations.botId, "999");
      assert.notInclude(JSON.stringify(logs), "private-");
      assert.notInclude(JSON.stringify(failure), "private-");
    }),
  );
});
