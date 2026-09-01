import { Database } from "bun:sqlite";
import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { createBot, type RecursivePartial, type TransformersDesiredProperties } from "discordeno";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const required = (name: string) => {
  const value = Bun.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
  return value;
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
  const mainFile = path.join(process.cwd(), "apps/daemon/src/main.ts");
  const readiness = `pico.daemon.ready root=${canonicalRoot}`;
  const firstMarker = "PICO_DISCORD_SMOKE_FIRST";
  const secondMarker = "PICO_DISCORD_SMOKE_SECOND";
  let output = "";
  let sourceMessageId: bigint | undefined;
  let threadId: bigint | undefined;

  yield* fileSystem.makeDirectory(workspaceCwd, { recursive: true });
  yield* fileSystem.makeDirectory(secretsDir, { recursive: true, mode: 0o700 });
  yield* fileSystem.writeFileString(tokenFile, picoToken, { mode: 0o600 });
  yield* fileSystem.writeFileString(
    path.join(canonicalRoot, "config.toml"),
    `[discord]\nallowed_guild = [${JSON.stringify(guildId)}]\ndefault_cwd = ${JSON.stringify(workspaceCwd)}\n`,
  );

  const desiredProperties = {
    channel: { id: true, type: true },
    message: { author: true, content: true, id: true },
    user: { id: true },
  } satisfies RecursivePartial<TransformersDesiredProperties>;
  const sender = createBot({ token: senderToken, desiredProperties });
  const pico = createBot({ token: picoToken, desiredProperties });
  const diagnostics = () => `\nDaemon output:\n${output || "<empty>"}`;

  yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const handle = Bun.spawn([process.execPath, mainFile, canonicalRoot], {
        stdout: "pipe",
        stderr: "inherit",
      });
      const reader = handle.stdout.getReader();
      const decoder = new TextDecoder();
      let finished = false;
      const done = (async () => {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return;
            output += decoder.decode(chunk.value, { stream: true });
          }
        } finally {
          finished = true;
          reader.releaseLock();
        }
      })();
      const closeOutput = async () => {
        if (!finished) await reader.cancel();
        await done;
      };
      return { handle, closeOutput };
    }),
    (child) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          poll("daemon readiness", async () => {
            if (output.includes(readiness)) return true;
            if (child.handle.exitCode !== null) {
              throw new Error(`Daemon exited with code ${child.handle.exitCode}${diagnostics()}`);
            }
            return undefined;
          }),
        );

        const source = yield* Effect.tryPromise(() =>
          sender.helpers.sendMessage(channelId, {
            content: `Do not use tools. Reply with exactly ${firstMarker}.`,
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

        const firstReply = yield* Effect.tryPromise(() =>
          poll("first Pico reply", async () => {
            const messages = await sender.helpers.getMessages(source.id, { limit: 100 });
            return messages.find(
              (message) => message.author.id === pico.id && message.content.includes(firstMarker),
            );
          }),
        );

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
          (error) =>
            new Error(`Discord smoke failed: ${String(error)}${diagnostics()}`, {
              cause: error,
            }),
        ),
      ),
    (child) =>
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
        const stopDaemon = Effect.gen(function* () {
          if (child.handle.exitCode === null) child.handle.kill("SIGTERM");
          yield* Effect.promise(() => child.handle.exited);
          yield* Effect.tryPromise(() => child.closeOutput()).pipe(Effect.timeout("5 seconds"));
        });

        yield* removeThread.pipe(Effect.ignore);
        yield* removeSource.pipe(Effect.ignore);
        yield* stopDaemon;
      }),
  );
});

describe("Discord adapter", () => {
  it.effect("creates one thread-backed chat and continues it", () =>
    smoke().pipe(Effect.provide(BunServices.layer), Effect.scoped),
  );
});
