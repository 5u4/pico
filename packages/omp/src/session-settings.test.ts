import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { AbsolutePath } from "@pico/contract/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { prepareSessionOptions } from "./session-settings.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const makeProject = Effect.fn("OmpSessionSettingsTest.makeProject")(function* (
  renderMermaid: boolean,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = AbsolutePath.make(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-omp-settings-" }),
  );
  const configDir = path.join(cwd, ".omp");
  yield* fileSystem.makeDirectory(configDir, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(configDir, "config.yml"),
    `tui:\n  renderMermaid: ${renderMermaid}\n`,
  );
  return cwd;
});

const testEffect = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(platformLayer));

describe("OMP session settings", () => {
  it.effect("preserves configured Mermaid false without a platform restriction", () =>
    testEffect(
      Effect.gen(function* () {
        const cwd = yield* makeProject(false);
        const { settings } = yield* prepareSessionOptions(cwd, null);

        assert.strictEqual(settings.get("tui.renderMermaid"), false);
      }),
    ),
  );

  it.effect("preserves configured Mermaid true without a platform restriction", () =>
    testEffect(
      Effect.gen(function* () {
        const cwd = yield* makeProject(true);
        const { settings } = yield* prepareSessionOptions(cwd, null);

        assert.strictEqual(settings.get("tui.renderMermaid"), true);
      }),
    ),
  );

  it.effect("forces configured Mermaid true to false for Discord", () =>
    testEffect(
      Effect.gen(function* () {
        const cwd = yield* makeProject(true);
        const { settings } = yield* prepareSessionOptions(cwd, "discord");

        assert.strictEqual(settings.get("tui.renderMermaid"), false);
      }),
    ),
  );

  it.effect("keeps settings instances isolated and applies runtime overrides", () =>
    testEffect(
      Effect.gen(function* () {
        const cwd = yield* makeProject(true);
        const { settings: first } = yield* prepareSessionOptions(cwd, null);
        first.override("tui.renderMermaid", false);
        const { settings: second } = yield* prepareSessionOptions(cwd, null);

        assert.notStrictEqual(first, second);
        assert.strictEqual(first.get("tui.renderMermaid"), false);
        assert.strictEqual(second.get("tui.renderMermaid"), true);
        assert.strictEqual(first.get("async.enabled"), false);
        assert.strictEqual(second.get("async.enabled"), false);
        assert.strictEqual(first.get("title.refreshOnReplan"), false);
        assert.strictEqual(second.get("title.refreshOnReplan"), false);
      }),
    ),
  );
});
