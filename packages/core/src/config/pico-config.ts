import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Data, Effect, Layer, type ParseResult, Schema } from "effect";

export class ConfigFileInvalid extends Data.TaggedError("ConfigFileInvalid")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

export interface PicoConfigShape {
  readonly configRoot: string;
  readonly sessionsRoot: string;
  readonly dbPath: string;
  readonly section: <A, I>(
    name: string,
    schema: Schema.Schema<A, I>,
  ) => Effect.Effect<A, ParseResult.ParseError>;
}

const defaultConfigRoot = (): string => join(homedir(), ".pico");

const TomlTable = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

const readConfigToml = (
  configRoot: string,
): Effect.Effect<Record<string, unknown>, ConfigFileInvalid> =>
  Effect.gen(function* () {
    const path = join(configRoot, "config.toml");
    const text = yield* Effect.try({
      try: () => readFileSync(path, "utf8"),
      catch: (cause) => new ConfigFileInvalid({ path, cause }),
    }).pipe(
      Effect.catchIf(
        (error): boolean =>
          typeof error.cause === "object" &&
          error.cause !== null &&
          "code" in error.cause &&
          error.cause.code === "ENOENT",
        () => Effect.succeed<string | null>(null),
      ),
    );
    if (text === null) return {};
    const parsed = yield* Effect.try({
      try: () => Bun.TOML.parse(text),
      catch: (cause) => new ConfigFileInvalid({ path, cause }),
    });
    return yield* Schema.decodeUnknown(TomlTable)(parsed).pipe(
      Effect.mapError((cause) => new ConfigFileInvalid({ path, cause })),
    );
  });

const make = (
  configRoot: string,
): Effect.Effect<PicoConfigShape, ConfigFileInvalid> =>
  Effect.gen(function* () {
    const raw = yield* readConfigToml(configRoot);
    const section = <A, I>(
      name: string,
      schema: Schema.Schema<A, I>,
    ): Effect.Effect<A, ParseResult.ParseError> =>
      Schema.decodeUnknown(schema)(raw[name] ?? {});
    return {
      configRoot,
      sessionsRoot: join(configRoot, "sessions"),
      dbPath: join(configRoot, "pico2.db"),
      section,
    };
  });

export class PicoConfig extends Effect.Service<PicoConfig>()(
  "pico/PicoConfig",
  { effect: make(defaultConfigRoot()) },
) {}

export const layerPicoConfig = (
  configRoot: string,
): Layer.Layer<PicoConfig, ConfigFileInvalid> =>
  Layer.effect(PicoConfig, make(configRoot).pipe(Effect.map(PicoConfig.make)));
