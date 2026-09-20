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

const TelegramSection = Schema.Struct({
  allowed_chat: Schema.Array(Schema.NonEmptyString),
  allowed_user: Schema.Array(Schema.NonEmptyString),
});

const PicoConfigFile = Schema.Struct({
  discord: Schema.optionalKey(DiscordSection),
  telegram: Schema.optionalKey(TelegramSection),
  browser: Schema.optionalKey(
    Schema.Struct({
      external_browser: Schema.optionalKey(ExternalBrowser),
      idle_timeout: Schema.optionalKey(
        Schema.Union([Schema.DurationFromString, Schema.DurationFromMillis]),
      ),
    }),
  ),
  web: Schema.optionalKey(
    Schema.Struct({
      port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
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

export interface TelegramConfig {
  readonly token: Redacted.Redacted<string>;
  readonly allowedChatIds: ReadonlyArray<string>;
  readonly allowedUserIds: ReadonlyArray<string>;
}

export interface PicoConfig {
  readonly discord: Option.Option<DiscordConfig>;
  readonly telegram: Option.Option<TelegramConfig>;
  readonly browser: BrowserConfig;
  readonly web: { readonly port: number };
}

const canonicalSignedId = /^-?(?:0|[1-9][0-9]*)$/u;
const canonicalPositiveId = /^[1-9][0-9]*$/u;

const platformError = (operation: string) => (error: PlatformError.PlatformError) =>
  new ConfigError({ message: `${operation} failed (${error.reason._tag})` });

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "MissingKey" ? "required field is missing" : "invalid field type",
  checkHook: () => "invalid field value",
});

const fieldError = (field: string, expected: string) =>
  new ConfigError({ message: `Invalid config.toml field ${field}; ${expected}` });

const defaultWeb: PicoConfig["web"] = { port: 7426 };

const disabled = (
  browser: BrowserConfig = { externalBrowser: "off", idleTimeoutMs: 10_800_000 },
  web: PicoConfig["web"] = defaultWeb,
): PicoConfig => ({
  discord: Option.none(),
  telegram: Option.none(),
  browser,
  web,
});

const readSecret = Effect.fn("PicoConfig.readSecret")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  paths: PicoPaths,
  name: string,
  inspectOperation: string,
  readOperation: string,
) {
  const secretPath = path.join(paths.secretsDir, name);
  const exists = yield* fileSystem
    .exists(secretPath)
    .pipe(Effect.mapError(platformError(inspectOperation)));
  if (!exists) return Option.none<string>();
  const value = (yield* fileSystem
    .readFileString(secretPath)
    .pipe(Effect.mapError(platformError(readOperation)))).trim();
  return value.length === 0 ? Option.none<string>() : Option.some(value);
});

const loadDiscord = Effect.fn("PicoConfig.loadDiscord")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  paths: PicoPaths,
  section: typeof DiscordSection.Type | undefined,
) {
  if (section === undefined) return Option.none<DiscordConfig>();

  const token = yield* readSecret(
    fileSystem,
    path,
    paths,
    "discord_bot_token",
    "Inspect Discord token file",
    "Read Discord token file",
  );
  if (Option.isNone(token)) return Option.none<DiscordConfig>();

  const defaultCwd = section.default_cwd.trim();
  const allowedGuildIds = section.allowed_guild.map((guildId) => guildId.trim());
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

  return Option.some<DiscordConfig>({
    token: Redacted.make(token.value, { label: "discord_bot_token" }),
    allowedGuildIds,
    defaultCwd: AbsolutePath.make(path.normalize(defaultCwd)),
    showToolCalls: section.show_tool_calls ?? false,
    showThinking: section.show_thinking ?? false,
  });
});

const loadTelegram = Effect.fn("PicoConfig.loadTelegram")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  paths: PicoPaths,
  section: typeof TelegramSection.Type | undefined,
) {
  if (section === undefined) return Option.none<TelegramConfig>();

  const token = yield* readSecret(
    fileSystem,
    path,
    paths,
    "telegram_bot_token",
    "Inspect Telegram token file",
    "Read Telegram token file",
  );
  if (Option.isNone(token)) return Option.none<TelegramConfig>();

  const allowedChatIds = section.allowed_chat.map((chatId) => chatId.trim());
  const allowedUserIds = section.allowed_user.map((userId) => userId.trim());

  for (let index = 0; index < allowedChatIds.length; index += 1) {
    const value = allowedChatIds[index] ?? "";
    if (value.length === 0 || value === "-0" || !canonicalSignedId.test(value)) {
      return yield* fieldError(
        `telegram.allowed_chat.${index}`,
        "expected a canonical signed decimal chat ID",
      );
    }
  }

  for (let index = 0; index < allowedUserIds.length; index += 1) {
    const value = allowedUserIds[index] ?? "";
    if (!canonicalPositiveId.test(value)) {
      return yield* fieldError(
        `telegram.allowed_user.${index}`,
        "expected a canonical positive decimal user ID",
      );
    }
  }

  return Option.some<TelegramConfig>({
    token: Redacted.make(token.value, { label: "telegram_bot_token" }),
    allowedChatIds,
    allowedUserIds,
  });
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
          .join(".") || "config";
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
  const web = { port: config.web?.port ?? defaultWeb.port };

  const discord = yield* loadDiscord(fileSystem, path, paths, config.discord);
  const telegram = yield* loadTelegram(fileSystem, path, paths, config.telegram);

  return {
    browser,
    web,
    discord,
    telegram,
  } satisfies PicoConfig;
});
