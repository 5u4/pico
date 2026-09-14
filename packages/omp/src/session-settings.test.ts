import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { AbsolutePath } from "@pico/contract/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { prepareSessionSettings } from "./session-settings.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const makeProject = Effect.fn("OmpSessionSettingsTest.makeProject")(function* (
  renderMermaid: boolean,
  nativeBrowser = true,
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
    `tui:\n  renderMermaid: ${renderMermaid}\nsecrets:\n  enabled: false\nbrowser:\n  enabled: ${nativeBrowser}\n`,
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
        const settings = yield* prepareSessionSettings(cwd, "web", "off");

        assert.strictEqual(settings.get("tui.renderMermaid"), false);
      }),
    ),
  );

  it.effect("preserves configured Mermaid true without a platform restriction", () =>
    testEffect(
      Effect.gen(function* () {
        const cwd = yield* makeProject(true);
        const settings = yield* prepareSessionSettings(cwd, "web", "off");

        assert.strictEqual(settings.get("tui.renderMermaid"), true);
      }),
    ),
  );

  it.effect("forces configured Mermaid true to false for Discord", () =>
    testEffect(
      Effect.gen(function* () {
        const cwd = yield* makeProject(true);
        const settings = yield* prepareSessionSettings(cwd, "discord", "off");

        assert.strictEqual(settings.get("tui.renderMermaid"), false);
      }),
    ),
  );

  it.effect("keeps settings instances isolated and applies runtime overrides", () =>
    testEffect(
      Effect.gen(function* () {
        const cwd = yield* makeProject(true);
        const first = yield* prepareSessionSettings(cwd, "web", "off");
        first.override("tui.renderMermaid", false);
        const second = yield* prepareSessionSettings(cwd, "web", "off");

        assert.notStrictEqual(first, second);
        assert.strictEqual(first.get("tui.renderMermaid"), false);
        assert.strictEqual(second.get("tui.renderMermaid"), true);
        assert.strictEqual(first.get("async.enabled"), false);
        assert.strictEqual(second.get("async.enabled"), false);
        assert.strictEqual(first.get("title.refreshOnReplan"), false);
        assert.strictEqual(second.get("title.refreshOnReplan"), false);
        assert.strictEqual(first.get("secrets.enabled"), true);
        assert.strictEqual(second.get("secrets.enabled"), true);
      }),
    ),
  );

  it.effect("preserves native browser on and off unless agent-browser is selected", () =>
    testEffect(
      Effect.gen(function* () {
        for (const nativeBrowser of [true, false]) {
          const cwd = yield* makeProject(true, nativeBrowser);
          const off = yield* prepareSessionSettings(cwd, "web", "off");
          assert.strictEqual(off.get("browser.enabled"), nativeBrowser);

          const enabled = yield* prepareSessionSettings(cwd, "web", "agent-browser");
          assert.strictEqual(enabled.get("browser.enabled"), false);
          assert.strictEqual(off.get("browser.enabled"), nativeBrowser);

          const disabledAgain = yield* prepareSessionSettings(cwd, "web", "off");
          assert.strictEqual(disabledAgain.get("browser.enabled"), nativeBrowser);
        }
      }),
    ),
  );
});
