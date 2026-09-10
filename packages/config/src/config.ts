import type { PicoPaths } from "@pico/contract/config";
import { ConfigError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const DiscordSection = Schema.Struct({
  allowed_guild: Schema.Array(Schema.NonEmptyString),
  default_cwd: Schema.NonEmptyString,
  show_tool_calls: Schema.optionalKey(Schema.Boolean),
  show_thinking: Schema.optionalKey(Schema.Boolean),
});

const PicoConfigFile = Schema.Struct({
  discord: Schema.optionalKey(DiscordSection),
});

export interface DiscordConfig {
  readonly token: Redacted.Redacted<string>;
  readonly allowedGuildIds: readonly [string, ...Array<string>];
  readonly defaultCwd: AbsolutePath;
  readonly showToolCalls: boolean;
  readonly showThinking: boolean;
}

export interface PicoConfig {
  readonly discord: Option.Option<DiscordConfig>;
}

const platformError = (error: PlatformError.PlatformError) =>
  new ConfigError({ message: error.message });

const parseError = () => new ConfigError({ message: "Failed to parse config.toml" });

const disabled = (): PicoConfig => ({ discord: Option.none() });

export const load = Effect.fn("PicoConfig.load")(function* (paths: PicoPaths) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!(yield* fileSystem.exists(paths.configFile).pipe(Effect.mapError(platformError)))) {
    return disabled();
  }

  const source = yield* fileSystem
    .readFileString(paths.configFile)
    .pipe(Effect.mapError(platformError));
  const input = yield* Effect.try({
    try: () => Bun.TOML.parse(source),
    catch: parseError,
  });
  const config = yield* Schema.decodeUnknownEffect(PicoConfigFile)(input).pipe(
    Effect.mapError(parseError),
  );
  if (config.discord === undefined) return disabled();

  const tokenPath = path.join(paths.secretsDir, "discord_bot_token");
  if (!(yield* fileSystem.exists(tokenPath).pipe(Effect.mapError(platformError)))) {
    return disabled();
  }

  const tokenValue = (yield* fileSystem
    .readFileString(tokenPath)
    .pipe(Effect.mapError(platformError))).trim();
  const defaultCwd = config.discord.default_cwd.trim();
  const allowedGuildIds = config.discord.allowed_guild.map((guildId) => guildId.trim());

  if (tokenValue.length === 0 || allowedGuildIds.length === 0) return disabled();
  if (
    defaultCwd.length === 0 ||
    !path.isAbsolute(defaultCwd) ||
    allowedGuildIds.some((guildId) => guildId.length === 0)
  ) {
    return yield* Effect.fail(parseError());
  }

  const [firstGuildId, ...restGuildIds] = allowedGuildIds;
  if (firstGuildId === undefined) return disabled();

  return {
    discord: Option.some<DiscordConfig>({
      token: Redacted.make(tokenValue, { label: "discord_bot_token" }),
      allowedGuildIds: [firstGuildId, ...restGuildIds],
      defaultCwd: AbsolutePath.make(path.normalize(defaultCwd)),
      showToolCalls: config.discord.show_tool_calls ?? false,
      showThinking: config.discord.show_thinking ?? false,
    }),
  } satisfies PicoConfig;
});
