import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { PicoRoot } from "@pico/contract/config";
import { ConfigError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { load } from "./config.ts";
import { open } from "./root.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const config = (allowedGuild: string, defaultCwd: string) => `[discord]
allowed_guild = ${allowedGuild}
default_cwd = ${JSON.stringify(defaultCwd)}
`;

describe("PicoConfig.load", () => {
  it.effect("loads Pico config and resolves Discord secrets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-config-",
      });
      const root = PicoRoot.make(path.join(temporaryDirectory, "root"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const paths = yield* open(root);
          const tokenFile = path.join(paths.secretsDir, "discord_bot_token");
          const defaultCwd = path.join(temporaryDirectory, "workspace");
          yield* fileSystem.makeDirectory(paths.secretsDir, { recursive: true });

          assert.isTrue(Option.isNone((yield* load(paths)).discord));

          yield* fileSystem.writeFileString(paths.configFile, config('["guild-1"]', defaultCwd));
          assert.isTrue(Option.isNone((yield* load(paths)).discord));
          yield* fileSystem.writeFileString(tokenFile, "  token-value\n", { mode: 0o600 });
          const discord = Option.getOrThrow((yield* load(paths)).discord);
          assert.strictEqual(Redacted.value(discord.token), "token-value");
          assert.strictEqual(String(discord.token), "<redacted:discord_bot_token>");
          assert.deepStrictEqual(
            {
              allowedGuildIds: discord.allowedGuildIds,
              defaultCwd: discord.defaultCwd,
              showToolCalls: discord.showToolCalls,
              showThinking: discord.showThinking,
            },
            {
              allowedGuildIds: ["guild-1"],
              defaultCwd: AbsolutePath.make(defaultCwd),
              showToolCalls: false,
              showThinking: false,
            },
          );

          yield* fileSystem.writeFileString(
            paths.configFile,
            `${config('["guild-1"]', defaultCwd)}show_tool_calls = true\n`,
          );
          const toolCallsOnly = Option.getOrThrow((yield* load(paths)).discord);
          assert.isTrue(toolCallsOnly.showToolCalls);
          assert.isFalse(toolCallsOnly.showThinking);
          yield* fileSystem.writeFileString(
            paths.configFile,
            `${config('["guild-1"]', defaultCwd)}show_thinking = true\n`,
          );
          const thinkingOnly = Option.getOrThrow((yield* load(paths)).discord);
          assert.isFalse(thinkingOnly.showToolCalls);
          assert.isTrue(thinkingOnly.showThinking);

          yield* fileSystem.writeFileString(tokenFile, "\n");
          assert.isTrue(Option.isNone((yield* load(paths)).discord));
          yield* fileSystem.writeFileString(tokenFile, "token-value");
          yield* fileSystem.writeFileString(paths.configFile, config("[]", defaultCwd));
          assert.isTrue(Option.isNone((yield* load(paths)).discord));

          yield* fileSystem.writeFileString(paths.configFile, config('["guild-1"]', "relative"));
          const invalidCwd = yield* load(paths).pipe(Effect.flip);
          assert.instanceOf(invalidCwd, ConfigError);
          assert.include(invalidCwd.message, "discord.default_cwd");

          yield* fileSystem.writeFileString(paths.configFile, "[discord]\nallowed_guild = 1\n");
          assert.instanceOf(yield* load(paths).pipe(Effect.flip), ConfigError);

          yield* fileSystem.writeFileString(
            paths.configFile,
            `${config('["guild-1"]', defaultCwd)}show_tool_calls = "private-config-value"\n`,
          );
          const invalidType = yield* load(paths).pipe(Effect.flip);
          assert.instanceOf(invalidType, ConfigError);
          assert.include(invalidType.message, "discord.show_tool_calls");
          assert.notInclude(invalidType.message, "private-config-value");
          yield* fileSystem.writeFileString(
            paths.configFile,
            `${config('["guild-1"]', defaultCwd)}show_thinking = 1\n`,
          );
          assert.instanceOf(yield* load(paths).pipe(Effect.flip), ConfigError);

          yield* fileSystem.writeFileString(
            paths.configFile,
            config('["guild-1", ""]', defaultCwd),
          );
          assert.instanceOf(yield* load(paths).pipe(Effect.flip), ConfigError);

          yield* fileSystem.writeFileString(
            paths.configFile,
            'secret = "private-config-value"\ndiscord = [\n',
          );
          const invalidSyntax = yield* load(paths).pipe(Effect.flip);
          assert.instanceOf(invalidSyntax, ConfigError);
          assert.include(invalidSyntax.message, "TOML");
          assert.notInclude(invalidSyntax.message, "private-config-value");
        }),
      );
    }).pipe(Effect.provide(platformLayer)),
  );
});
