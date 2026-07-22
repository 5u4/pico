import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { layerPicoConfig, PicoConfig } from "../src/config/pico-config.ts";

const WebSchema = Schema.Struct({
  port: Schema.optionalWith(Schema.Number, { default: () => 4141 }),
});

const withRoot = <A, E>(
  root: string,
  program: Effect.Effect<A, E, PicoConfig>,
): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(layerPicoConfig(root))));

const makeRoot = (): string => mkdtempSync(join(tmpdir(), "pico-config-"));

describe("PicoConfig", () => {
  it("derives sessionsRoot and dbPath from configRoot", async () => {
    const root = makeRoot();
    try {
      const paths = await withRoot(
        root,
        Effect.gen(function* () {
          const config = yield* PicoConfig;
          return {
            configRoot: config.configRoot,
            sessionsRoot: config.sessionsRoot,
            dbPath: config.dbPath,
          };
        }),
      );
      expect(paths.configRoot).toBe(root);
      expect(paths.sessionsRoot).toBe(join(root, "sessions"));
      expect(paths.dbPath).toBe(join(root, "pico2.db"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a missing config.toml as an empty table", async () => {
    const root = makeRoot();
    try {
      const web = await withRoot(
        root,
        Effect.gen(function* () {
          const config = yield* PicoConfig;
          return yield* config.section("web", WebSchema);
        }),
      );
      expect(web.port).toBe(4141);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("decodes a present section over its schema default", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "config.toml"), "[web]\nport = 4242\n");
    try {
      const web = await withRoot(
        root,
        Effect.gen(function* () {
          const config = yield* PicoConfig;
          return yield* config.section("web", WebSchema);
        }),
      );
      expect(web.port).toBe(4242);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces a malformed section as a ParseError in the error channel", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "config.toml"), '[web]\nport = "nope"\n');
    try {
      const result = await withRoot(
        root,
        Effect.gen(function* () {
          const config = yield* PicoConfig;
          return yield* config.section("web", WebSchema);
        }).pipe(Effect.either),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("ParseError");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails construction on syntactically invalid TOML", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "config.toml"), "this = = broken\n");
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return (yield* PicoConfig).configRoot;
        }).pipe(Effect.provide(layerPicoConfig(root)), Effect.either),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("ConfigFileInvalid");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults configRoot to ~/.pico", async () => {
    const configRoot = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* PicoConfig).configRoot;
      }).pipe(Effect.provide(PicoConfig.Default)),
    );
    expect(configRoot).toBe(join(homedir(), ".pico"));
  });
});
