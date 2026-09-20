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

const telegramConfig = (allowedChat: string, allowedUser: string) => `[telegram]
allowed_chat = ${allowedChat}
allowed_user = ${allowedUser}
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

  it.effect("loads Telegram config independently from Discord", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = PicoRoot.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-telegram-config-" }),
      );
      const paths = yield* open(root);
      yield* fileSystem.makeDirectory(paths.secretsDir, { recursive: true });
      const telegramToken = path.join(paths.secretsDir, "telegram_bot_token");
      const discordToken = path.join(paths.secretsDir, "discord_bot_token");
      const defaultCwd = path.join(String(root), "workspace");

      yield* fileSystem.writeFileString(paths.configFile, telegramConfig('["-1001"]', '["42"]'));
      const withoutToken = yield* load(paths);
      assert.isTrue(Option.isNone(withoutToken.telegram));
      assert.isTrue(Option.isNone(withoutToken.discord));

      yield* fileSystem.writeFileString(telegramToken, "  tg-token\n", { mode: 0o600 });
      const telegram = Option.getOrThrow((yield* load(paths)).telegram);
      assert.strictEqual(Redacted.value(telegram.token), "tg-token");
      assert.strictEqual(String(telegram.token), "<redacted:telegram_bot_token>");
      assert.deepStrictEqual(telegram.allowedChatIds, ["-1001"]);
      assert.deepStrictEqual(telegram.allowedUserIds, ["42"]);
      assert.isTrue(Option.isNone((yield* load(paths)).discord));

      yield* fileSystem.writeFileString(
        paths.configFile,
        `${config('["guild-1"]', defaultCwd)}\n${telegramConfig('["-1001"]', '["42"]')}`,
      );
      assert.isTrue(Option.isNone((yield* load(paths)).discord));
      assert.isTrue(Option.isSome((yield* load(paths)).telegram));

      yield* fileSystem.writeFileString(discordToken, "discord-token", { mode: 0o600 });
      const both = yield* load(paths);
      assert.isTrue(Option.isSome(both.discord));
      assert.isTrue(Option.isSome(both.telegram));

      yield* fileSystem.writeFileString(paths.configFile, telegramConfig('["-1001"]', '["0042"]'));
      const invalidUserId = yield* load(paths).pipe(Effect.flip);
      assert.instanceOf(invalidUserId, ConfigError);
      assert.include(invalidUserId.message, "telegram.allowed_user.0");

      yield* fileSystem.writeFileString(
        paths.configFile,
        telegramConfig('["private-chat"]', '["42"]'),
      );
      const invalidChatId = yield* load(paths).pipe(Effect.flip);
      assert.instanceOf(invalidChatId, ConfigError);
      assert.include(invalidChatId.message, "telegram.allowed_chat.0");

      yield* fileSystem.writeFileString(
        paths.configFile,
        `${config('["guild-1"]', defaultCwd)}\n${telegramConfig('["-1001"]', '["42"]')}`,
      );
      yield* fileSystem.writeFileString(telegramToken, "\n", { mode: 0o600 });
      const discordOnly = yield* load(paths);
      assert.isTrue(Option.isSome(discordOnly.discord));
      assert.isTrue(Option.isNone(discordOnly.telegram));
    }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  );
  it.effect("preserves port zero across Discord credential states", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = PicoRoot.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-web-port-" }),
      );
      const paths = yield* open(root);
      const web = "[web]\nport = 0\n";
      yield* fileSystem.writeFileString(paths.configFile, web);
      const withoutDiscord = yield* load(paths);
      assert.strictEqual(withoutDiscord.web.port, 0);
      assert.isTrue(Option.isNone(withoutDiscord.discord));

      yield* fileSystem.writeFileString(paths.configFile, `${config("[]", root)}\n${web}`);
      yield* fileSystem.makeDirectory(paths.secretsDir, { recursive: true });
      for (const token of [undefined, "\n", "token-value"]) {
        if (token !== undefined) {
          yield* fileSystem.writeFileString(
            path.join(paths.secretsDir, "discord_bot_token"),
            token,
            { mode: 0o600 },
          );
        }
        const loaded = yield* load(paths);
        assert.strictEqual(loaded.web.port, 0);
        assert.strictEqual(Option.isSome(loaded.discord), token === "token-value");
      }
    }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  );

  it.effect("validates web port bounds without exposing config values", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = PicoRoot.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-web-port-validation-" }),
      );
      const paths = yield* open(root);
      assert.strictEqual((yield* load(paths)).web.port, 7426);
      yield* fileSystem.writeFileString(paths.configFile, "[web]\nport = 65535\n");
      assert.strictEqual((yield* load(paths)).web.port, 65535);

      for (const invalid of ['"private-port-value"', "0.5", "-1", "65536"]) {
        yield* fileSystem.writeFileString(paths.configFile, `[web]\nport = ${invalid}\n`);
        const error = yield* load(paths).pipe(Effect.flip);
        assert.instanceOf(error, ConfigError);
        assert.include(error.message, "web.port");
        assert.notInclude(error.message, invalid.replaceAll('"', ""));
      }
      yield* fileSystem.writeFileString(paths.configFile, 'web = "private-web-value"\n');
      const error = yield* load(paths).pipe(Effect.flip);
      assert.instanceOf(error, ConfigError);
      assert.include(error.message, "web");
      assert.notInclude(error.message, "private-web-value");
    }).pipe(Effect.scoped, Effect.provide(platformLayer)),
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

  it.effect("accepts an empty guild allowlist while validating Discord configuration", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = PicoRoot.make(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-discord-config-" }),
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
