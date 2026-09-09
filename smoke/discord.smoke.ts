import { Database } from "bun:sqlite";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, it } from "@effect/vitest";
import { PicoRoot } from "@pico/contract/config";
import * as Daemon from "@pico/daemon";
import {
  ApplicationCommandOptionTypes,
  ApplicationCommandTypes,
  type CreateApplicationCommand,
  createBot,
  type RecursivePartial,
  type TransformersDesiredProperties,
} from "discordeno";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { assert } from "vitest";

const required = (name: string) => {
  const value = Bun.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
};

const staleCommands = {
  global: [
    {
      name: "stale-global",
      description: "Stale global command",
      type: ApplicationCommandTypes.ChatInput,
    },
  ],
  guild: [
    {
      name: "stale-guild",
      description: "Stale guild command",
      type: ApplicationCommandTypes.ChatInput,
    },
  ],
} satisfies {
  readonly global: Array<CreateApplicationCommand>;
  readonly guild: Array<CreateApplicationCommand>;
};

const poll = async <A>(description: string, evaluate: () => Promise<A | undefined>) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 1_200; attempt++) {
    try {
      const value = await evaluate();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
};

const smoke = Effect.fn("Discord.smoke")(function* () {
  const picoToken = required("PICO_SMOKE_DISCORD_PICO_TOKEN");
  const senderToken = required("PICO_SMOKE_DISCORD_SENDER_TOKEN");
  const guildId = required("PICO_SMOKE_DISCORD_GUILD_ID");
  const channelId = BigInt(required("PICO_SMOKE_DISCORD_CHANNEL_ID"));
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-discord-smoke-" });
  const canonicalRoot = yield* fileSystem.realPath(root);
  const workspaceCwd = path.join(canonicalRoot, "workspace");
  const secretsDir = path.join(canonicalRoot, "secrets");
  const tokenFile = path.join(secretsDir, "discord_bot_token");
  const storeFile = path.join(canonicalRoot, "store.db");
  const firstMarker = "PICO_DISCORD_SMOKE_FIRST";
  const firstPrompt = `Use the read tool to read emoji.txt, then reply with exactly ${firstMarker}.`;
  const secondMarker = "PICO_DISCORD_SMOKE_SECOND";
  let sourceMessageId: bigint | undefined;
  let threadId: bigint | undefined;

  yield* fileSystem.makeDirectory(workspaceCwd, { recursive: true });
  yield* fileSystem.makeDirectory(secretsDir, { recursive: true, mode: 0o700 });
  yield* fileSystem.writeFileString(tokenFile, picoToken, { mode: 0o600 });
  yield* fileSystem.writeFileString(path.join(workspaceCwd, "emoji.txt"), "emoji");
  yield* fileSystem.writeFileString(
    path.join(canonicalRoot, "config.toml"),
    `[discord]\nallowed_guild = [${JSON.stringify(guildId)}]\ndefault_cwd = ${JSON.stringify(workspaceCwd)}\n`,
  );

  const desiredProperties = {
    channel: { id: true, name: true, type: true },
    message: { author: true, content: true, id: true },
    user: { id: true },
  } satisfies RecursivePartial<TransformersDesiredProperties>;
  const sender = createBot({ token: senderToken, desiredProperties });
  const pico = createBot({ token: picoToken, desiredProperties });

  yield* Effect.tryPromise(() =>
    Promise.all([
      pico.helpers.upsertGlobalApplicationCommands(staleCommands.global),
      pico.helpers.upsertGuildApplicationCommands(guildId, staleCommands.guild),
    ]),
  );

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Daemon.open(PicoRoot.make(canonicalRoot));

      const [globalCommands, guildCommands] = yield* Effect.tryPromise(() =>
        Promise.all([
          pico.helpers.getGlobalApplicationCommands(),
          pico.helpers.getGuildApplicationCommands(guildId),
        ]),
      );
      assert.strictEqual(globalCommands.length, 0);
      assert.strictEqual(guildCommands.length, 3);

      const bindCommand = guildCommands.find((command) => command.name === "bind");
      assert.strictEqual(bindCommand?.name, "bind");
      assert.strictEqual(bindCommand?.type, ApplicationCommandTypes.ChatInput);
      assert.strictEqual(bindCommand?.defaultMemberPermissions, undefined);
      assert.strictEqual(bindCommand?.options?.length, 1);

      const setCommand = bindCommand?.options?.[0];
      assert.strictEqual(setCommand?.name, "set");
      assert.strictEqual(setCommand?.type, ApplicationCommandOptionTypes.SubCommand);
      assert.strictEqual(setCommand?.options?.length, 1);

      const cwdOption = setCommand?.options?.[0];
      assert.strictEqual(cwdOption?.name, "cwd");
      assert.strictEqual(cwdOption?.type, ApplicationCommandOptionTypes.String);
      assert.strictEqual(cwdOption?.required, true);

      const shakeCommand = guildCommands.find((command) => command.name === "shake");
      assert.strictEqual(shakeCommand?.type, ApplicationCommandTypes.ChatInput);
      assert.strictEqual(shakeCommand?.defaultMemberPermissions, undefined);
      assert.strictEqual(shakeCommand?.options?.length, 1);

      const modeOption = shakeCommand?.options?.[0];
      assert.strictEqual(modeOption?.name, "mode");
      assert.strictEqual(modeOption?.type, ApplicationCommandOptionTypes.String);
      assert.notStrictEqual(modeOption?.required, true);
      assert.deepStrictEqual(
        modeOption?.choices?.map(({ name, value }) => ({ name, value })),
        [
          { name: "Tool results and large blocks", value: "elide" },
          { name: "Images", value: "images" },
          { name: "Thinking", value: "thinking" },
        ],
      );

      const contextCommand = guildCommands.find((command) => command.name === "context");
      assert.strictEqual(contextCommand?.type, ApplicationCommandTypes.ChatInput);
      assert.strictEqual(contextCommand?.defaultMemberPermissions, undefined);
      assert.strictEqual(contextCommand?.options?.length ?? 0, 0);

      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            const source = yield* Effect.tryPromise(() =>
              sender.helpers.sendMessage(channelId, {
                content: firstPrompt,
                allowedMentions: { parse: [], repliedUser: false },
              }),
            );
            sourceMessageId = source.id;
            threadId = source.id;

            yield* Effect.tryPromise(() =>
              poll("Pico Discord thread", async () => {
                const channel = await sender.helpers.getChannel(source.id);
                return channel.id === source.id ? channel : undefined;
              }),
            );
            yield* Effect.tryPromise(() =>
              poll("Pico Discord read tool emoji", async () => {
                const messages = (
                  await sender.helpers.getMessages(source.id, { limit: 100 })
                ).filter((message) => message.author.id === pico.id);
                return messages.find((message) =>
                  /^📖 Read (?:.*\/)?emoji\.txt$/u.test(message.content),
                );
              }),
            );

            const firstReply = yield* Effect.tryPromise(() =>
              poll("first Pico reply", async () => {
                const messages = await sender.helpers.getMessages(source.id, { limit: 100 });
                return messages.find(
                  (message) =>
                    message.author.id === pico.id && message.content.includes(firstMarker),
                );
              }),
            );
            const title = yield* Effect.tryPromise(() =>
              poll("Pico Discord thread title", async () => {
                const channel = await sender.helpers.getChannel(source.id);
                return channel.name !== firstPrompt ? channel.name : undefined;
              }),
            );
            assert.isAtLeast(title.length, 1);
            assert.isAtMost(Array.from(title).length, 80);

            yield* Effect.tryPromise(() =>
              sender.helpers.sendMessage(source.id, {
                content: `Do not use tools. Reply with exactly ${secondMarker}.`,
                allowedMentions: { parse: [], repliedUser: false },
              }),
            );

            yield* Effect.tryPromise(() =>
              poll("second Pico reply", async () => {
                const messages = await sender.helpers.getMessages(source.id, { limit: 100 });
                return messages.find(
                  (message) =>
                    message.id !== firstReply.id &&
                    message.author.id === pico.id &&
                    message.content.includes(secondMarker),
                );
              }),
            );

            yield* Effect.sync(() => {
              const database = new Database(storeFile, { readonly: true });
              try {
                const workspaces = database
                  .query<{ count: number }, []>("SELECT count(*) AS count FROM workspaces")
                  .get();
                const chats = database
                  .query<{ count: number }, []>("SELECT count(*) AS count FROM chats")
                  .get();
                assert.strictEqual(workspaces?.count, 1);
                assert.strictEqual(chats?.count, 1);
              } finally {
                database.close();
              }
            });
          }).pipe(
            Effect.mapError(
              (error) => new Error(`Discord smoke failed: ${String(error)}`, { cause: error }),
            ),
          ),
        () =>
          Effect.gen(function* () {
            const currentThreadId = threadId;
            const removeThread =
              currentThreadId === undefined
                ? Effect.void
                : Effect.tryPromise(() => pico.helpers.deleteChannel(currentThreadId));
            const currentSourceMessageId = sourceMessageId;
            const removeSource =
              currentSourceMessageId === undefined
                ? Effect.void
                : Effect.tryPromise(() =>
                    sender.helpers.deleteMessage(channelId, currentSourceMessageId),
                  );

            yield* removeThread.pipe(Effect.ignore);
            yield* removeSource.pipe(Effect.ignore);
          }),
      );
    }),
  );
});

describe("Discord adapter", () => {
  it.effect("reconciles commands, creates one thread-backed chat, and continues it", () =>
    smoke().pipe(Effect.provide(BunServices.layer), Effect.scoped),
  );
});
