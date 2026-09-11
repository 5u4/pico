import { type PicoPaths, PicoRoot, type PicoRoot as PicoRootType } from "@pico/contract/config";
import { ConfigError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

const configError = (error: PlatformError.PlatformError) =>
  new ConfigError({ message: error.message });

export const open = Effect.fn("ConfigRoot.open")(function* (root: PicoRootType) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fileSystem
    .makeDirectory(root, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(configError));

  const canonicalRoot = PicoRoot.make(
    yield* fileSystem.realPath(root).pipe(Effect.mapError(configError)),
  );
  const child = (name: string) => AbsolutePath.make(path.join(canonicalRoot, name));
  const paths: PicoPaths = {
    root: canonicalRoot,
    configFile: child("config.toml"),
    storeFile: child("store.db"),
    sessionsDir: child("sessions"),
    secretsDir: child("secrets"),
    worktreesDir: child("worktrees"),
    logsDir: child("logs"),
    schedulesDir: child("schedules"),
  };
  const lockFile = child(".pico.lock");

  // ponytail: crashes leave a stale file; use an OS lock when automatic recovery matters.
  yield* Effect.acquireRelease(
    fileSystem
      .writeFileString(lockFile, "", { flag: "wx", mode: 0o600 })
      .pipe(Effect.mapError(configError)),
    () =>
      fileSystem.remove(lockFile, { force: true }).pipe(Effect.mapError(configError), Effect.orDie),
  );

  return paths;
});
