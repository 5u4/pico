import { type BrowserConfig, ExternalBrowser, type PicoPaths } from "@pico/contract/config";
import { ConfigError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const DiscordSection = Schema.Struct({
  allowed_guild: Schema.Array(Schema.NonEmptyString),
  default_cwd: Schema.NonEmptyString,
  show_tool_calls: Schema.optionalKey(Schema.Boolean),
  show_thinking: Schema.optionalKey(Schema.Boolean),
});

const PicoConfigFile = Schema.Struct({
  discord: Schema.optionalKey(DiscordSection),
  browser: Schema.optionalKey(
    Schema.Struct({
      external_browser: Schema.optionalKey(ExternalBrowser),
      idle_timeout: Schema.optionalKey(
        Schema.Union([Schema.DurationFromString, Schema.DurationFromMillis]),
      ),
    }),
  ),
});

export interface DiscordConfig {
  readonly token: Redacted.Redacted<string>;
  readonly allowedGuildIds: ReadonlyArray<string>;
  readonly defaultCwd: AbsolutePath;
  readonly showToolCalls: boolean;
  readonly showThinking: boolean;
}

export interface PicoConfig {
  readonly discord: Option.Option<DiscordConfig>;
  readonly browser: BrowserConfig;
}

const platformError = (operation: string) => (error: PlatformError.PlatformError) =>
  new ConfigError({ message: `${operation} failed (${error.reason._tag})` });

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "MissingKey" ? "required field is missing" : "invalid field type",
  checkHook: () => "invalid field value",
});

const fieldError = (field: string, expected: string) =>
  new ConfigError({ message: `Invalid config.toml field ${field}; ${expected}` });

const disabled = (
  browser: BrowserConfig = { externalBrowser: "off", idleTimeoutMs: 10_800_000 },
): PicoConfig => ({
  discord: Option.none(),
  browser,
});

export const load = Effect.fn("PicoConfig.load")(function* (paths: PicoPaths) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (
    !(yield* fileSystem
      .exists(paths.configFile)
      .pipe(Effect.mapError(platformError("Inspect config.toml"))))
  ) {
    return disabled();
  }

  const source = yield* fileSystem
    .readFileString(paths.configFile)
    .pipe(Effect.mapError(platformError("Read config.toml")));
  const input = yield* Effect.try({
    try: () => Bun.TOML.parse(source),
    catch: () => new ConfigError({ message: "Invalid TOML syntax in config.toml" }),
  });
  const config = yield* Schema.decodeUnknownEffect(PicoConfigFile)(input).pipe(
    Effect.mapError((error) => {
      const issue = formatIssue(error.issue).issues[0];
      const field =
        issue?.path
          ?.map((segment) => (typeof segment === "object" ? String(segment.key) : String(segment)))
          .join(".") || "discord";
      return fieldError(field, issue?.message ?? "invalid configuration");
    }),
  );
  const idleTimeoutMs =
    config.browser?.idle_timeout === undefined
      ? 10_800_000
      : Duration.toMillis(config.browser.idle_timeout);
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    return yield* fieldError(
      "browser.idle_timeout",
      "expected a positive duration in whole milliseconds",
    );
  }
  const browser: BrowserConfig = {
    externalBrowser: config.browser?.external_browser ?? "off",
    idleTimeoutMs,
  };
  if (config.discord === undefined) return disabled(browser);

  const tokenPath = path.join(paths.secretsDir, "discord_bot_token");
  if (
    !(yield* fileSystem
      .exists(tokenPath)
      .pipe(Effect.mapError(platformError("Inspect Discord token file"))))
  ) {
    return disabled(browser);
  }

  const tokenValue = (yield* fileSystem
    .readFileString(tokenPath)
    .pipe(Effect.mapError(platformError("Read Discord token file")))).trim();
  const defaultCwd = config.discord.default_cwd.trim();
  const allowedGuildIds = config.discord.allowed_guild.map((guildId) => guildId.trim());

  if (tokenValue.length === 0) return disabled(browser);
  if (defaultCwd.length === 0 || !path.isAbsolute(defaultCwd)) {
    return yield* fieldError("discord.default_cwd", "expected an absolute, nonblank path");
  }
  const blankGuildIndex = allowedGuildIds.findIndex((guildId) => guildId.length === 0);
  if (blankGuildIndex !== -1) {
    return yield* fieldError(
      `discord.allowed_guild.${blankGuildIndex}`,
      "expected a nonblank guild ID",
    );
  }

  return {
    browser,
    discord: Option.some<DiscordConfig>({
      token: Redacted.make(tokenValue, { label: "discord_bot_token" }),
      allowedGuildIds,
      defaultCwd: AbsolutePath.make(path.normalize(defaultCwd)),
      showToolCalls: config.discord.show_tool_calls ?? false,
      showThinking: config.discord.show_thinking ?? false,
    }),
  } satisfies PicoConfig;
});
