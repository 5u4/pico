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
          assert.deepStrictEqual(
            Option.getOrThrow((yield* load(paths)).discord).allowedGuildIds,
            [],
          );

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
  it.effect(
    "defaults the external browser off and validates explicit selection without Discord",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-external-browser-config-",
        });
        const paths = yield* open(PicoRoot.make(path.join(temporaryDirectory, "root")));
        assert.strictEqual((yield* load(paths)).browser.externalBrowser, "off");
        for (const source of ["", "[browser]\n", '[browser]\nidle_timeout = "1 minute"\n']) {
          yield* fileSystem.writeFileString(paths.configFile, source);
          assert.strictEqual((yield* load(paths)).browser.externalBrowser, "off");
        }
        for (const externalBrowser of ["agent-browser", "off"]) {
          yield* fileSystem.writeFileString(
            paths.configFile,
            `[browser]\nexternal_browser = "${externalBrowser}"\n`,
          );
          const loaded = yield* load(paths);
          assert.strictEqual(loaded.browser.externalBrowser, externalBrowser);
          assert.isTrue(Option.isNone(loaded.discord));
        }
        for (const invalid of ['"private-unsupported-provider"', "true", "1", "[]", "{}"]) {
          yield* fileSystem.writeFileString(
            paths.configFile,
            `[browser]\nexternal_browser = ${invalid}\n`,
          );
          const error = yield* load(paths).pipe(Effect.flip);
          assert.instanceOf(error, ConfigError);
          assert.include(error.message, "browser.external_browser");
          assert.notInclude(error.message, "private-unsupported-provider");
        }
      }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  );

  it.effect(
    "enables direct messages with an empty guild allowlist while validating configuration",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = PicoRoot.make(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-dm-config-" }),
        );
        const paths = yield* open(root);
        yield* fileSystem.makeDirectory(paths.secretsDir, { recursive: true });
        const tokenFile = path.join(paths.secretsDir, "discord_bot_token");
        yield* fileSystem.writeFileString(tokenFile, "token-value", { mode: 0o600 });
        yield* fileSystem.writeFileString(paths.configFile, config("[]", root));
        const discord = Option.getOrThrow((yield* load(paths)).discord);
        assert.deepStrictEqual(discord.allowedGuildIds, []);
        assert.strictEqual(Redacted.value(discord.token), "token-value");
        yield* fileSystem.writeFileString(paths.configFile, config("[]", "relative"));
        const invalidCwd = yield* load(paths).pipe(Effect.flip);
        assert.instanceOf(invalidCwd, ConfigError);
        assert.include(invalidCwd.message, "discord.default_cwd");
        yield* fileSystem.writeFileString(tokenFile, "");
        assert.isTrue(Option.isNone((yield* load(paths)).discord));
      }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  );

  it.effect("loads and validates browser lifetime without Discord credentials", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-browser-config-",
      });
      const paths = yield* open(PicoRoot.make(path.join(temporaryDirectory, "root")));
      assert.strictEqual((yield* load(paths)).browser.idleTimeoutMs, 10_800_000);
      yield* fileSystem.writeFileString(
        paths.configFile,
        '[browser]\nidle_timeout = "90 minutes"\n',
      );
      assert.strictEqual((yield* load(paths)).browser.idleTimeoutMs, 5_400_000);
      yield* fileSystem.writeFileString(
        paths.configFile,
        `${config('["guild-1"]', temporaryDirectory)}\n[browser]\nidle_timeout = 1234\n`,
      );
      const loaded = yield* load(paths);
      assert.strictEqual(loaded.browser.idleTimeoutMs, 1234);
      assert.isTrue(Option.isNone(loaded.discord));
      for (const invalid of [
        '"Infinity"',
        '"0 seconds"',
        '"-1 second"',
        "0.5",
        "9007199254740992",
        '"private-invalid-value"',
      ]) {
        yield* fileSystem.writeFileString(
          paths.configFile,
          `[browser]\nidle_timeout = ${invalid}\n`,
        );
        const error = yield* load(paths).pipe(Effect.flip);
        assert.instanceOf(error, ConfigError);
        assert.notInclude(error.message, "private-invalid-value");
      }
    }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  );
});
