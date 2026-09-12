import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { PicoRoot } from "@pico/contract/config";
import { ConfigError } from "@pico/contract/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { open } from "./root.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

describe("ConfigRoot.open", () => {
  it.effect("derives and exclusively owns an explicit root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-config-",
      });
      const root = PicoRoot.make(path.join(temporaryDirectory, "root"));

      const paths = yield* Effect.scoped(
        Effect.gen(function* () {
          const paths = yield* open(root);
          const canonicalRoot = PicoRoot.make(yield* fileSystem.realPath(root));
          const lockFile = path.join(canonicalRoot, ".pico.lock");

          assert.deepStrictEqual(paths, {
            root: canonicalRoot,
            configFile: path.join(canonicalRoot, "config.toml"),
            storeFile: path.join(canonicalRoot, "store.db"),
            sessionsDir: path.join(canonicalRoot, "sessions"),
            secretsDir: path.join(canonicalRoot, "secrets"),
            worktreesDir: path.join(canonicalRoot, "worktrees"),
            logsDir: path.join(canonicalRoot, "logs"),
            schedulesDir: path.join(canonicalRoot, "schedules"),
          });
          assert.isTrue(yield* fileSystem.exists(lockFile));
          assert.isFalse(yield* fileSystem.exists(paths.configFile));

          const conflict = yield* Effect.scoped(open(root)).pipe(Effect.flip);
          assert.instanceOf(conflict, ConfigError);
          assert.include(conflict.message, ".pico.lock");

          return paths;
        }),
      );

      assert.isFalse(yield* fileSystem.exists(path.join(paths.root, ".pico.lock")));
      assert.isFalse(yield* fileSystem.exists(paths.configFile));
    }).pipe(Effect.provide(platformLayer)),
  );
});
