import * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

export interface Storage {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly schedulesDir: string;
  readonly temporaryId: () => Effect.Effect<string, Schedule.ScheduleError>;
}

export const io = (message: string, cause?: unknown) =>
  new Schedule.ScheduleError({
    kind: "io",
    message:
      cause instanceof PlatformError.PlatformError ? `${message}: ${cause.reason._tag}` : message,
  });

export const invalid = (message: string) =>
  new Schedule.ScheduleError({ kind: "invalid", message });

export const mapIo = (message: string) => Effect.mapError((cause: unknown) => io(message, cause));

export const ignoreCleanupFailure = <A, E, R>(
  message: string,
  effect: Effect.Effect<A, E, R>,
  annotations: Readonly<Record<string, string>>,
) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logError(message).pipe(
            Effect.annotateLogs({
              component: "schedule",
              ...annotations,
              category: cause.reasons.some(Cause.isDieReason) ? "defect" : "io",
            }),
          ),
    ),
  );

export const ensureRegularDestination = Effect.fn("Schedules.ensureRegularDestination")(function* (
  storage: Storage,
  file: string,
  label: string,
) {
  const exists = yield* storage.fileSystem.exists(file).pipe(mapIo(`Failed to inspect ${label}`));
  if (!exists) return undefined;
  yield* ensureDirectPath(storage, file, label);
  const info = yield* storage.fileSystem.stat(file).pipe(mapIo(`Failed to inspect ${label}`));
  if (info.type !== "File") {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: `${label} must be a regular file and must not be a symbolic link`,
    });
  }
  return info;
});

export const readDirectFileString = Effect.fn("Schedules.readDirectFileString")(function* (
  storage: Storage,
  file: string,
  label: string,
) {
  yield* ensureRegularDestination(storage, file, label);
  return yield* storage.fileSystem.readFileString(file).pipe(mapIo(`Failed to read ${label}`));
});

export const roots = (storage: Storage) => ({
  enabled: storage.path.join(storage.schedulesDir, "enabled"),
  disabled: storage.path.join(storage.schedulesDir, "disabled"),
  runs: storage.path.join(storage.schedulesDir, "runs"),
  staging: storage.path.join(storage.schedulesDir, ".staging"),
});

export const inspectDirectory = Effect.fn("Schedules.inspectDirectory")(function* (
  storage: Storage,
  directory: string,
  label: string,
) {
  const exists = yield* storage.fileSystem
    .exists(directory)
    .pipe(mapIo(`Failed to inspect ${label}`));
  if (!exists) return false;
  yield* ensureDirectPath(storage, directory, label);
  const info = yield* storage.fileSystem.stat(directory).pipe(mapIo(`Failed to inspect ${label}`));
  if (info.type !== "Directory") {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: `${label} must be a directory and must not be a symbolic link`,
    });
  }
  return true;
});

export const createDirectory = Effect.fn("Schedules.createDirectory")(function* (
  storage: Storage,
  directory: string,
  label: string,
) {
  const parent = storage.path.dirname(directory);
  if (!(yield* inspectDirectory(storage, parent, `${label} parent`))) {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: `${label} parent must exist before the directory is created`,
    });
  }
  yield* storage.fileSystem
    .makeDirectory(directory, { mode: 0o700 })
    .pipe(mapIo(`Failed to create ${label}`));
  yield* inspectDirectory(storage, directory, label);
});

export const prepareStagingDirectory = Effect.fn("Schedules.prepareStagingDirectory")(function* (
  storage: Storage,
  name: string,
) {
  const staging = roots(storage).staging;
  for (const entry of [
    { directory: storage.schedulesDir, label: "schedule storage directory" },
    { directory: staging, label: "schedule staging directory" },
  ]) {
    if (!(yield* inspectDirectory(storage, entry.directory, entry.label))) {
      return yield* new Schedule.ScheduleError({
        kind: "corrupt",
        message: `${entry.label} must exist before staging`,
      });
    }
  }

  const transaction = storage.path.join(staging, name);
  const exists = yield* storage.fileSystem
    .exists(transaction)
    .pipe(mapIo("Failed to inspect schedule staging path"));
  if (exists) {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: "Schedule staging path must not already exist",
    });
  }
  return yield* Effect.acquireUseRelease(
    storage.fileSystem
      .makeDirectory(transaction, { mode: 0o700 })
      .pipe(mapIo("Failed to create schedule staging directory"), Effect.as(transaction)),
    (directory) =>
      inspectDirectory(storage, directory, "schedule staging directory").pipe(Effect.as(directory)),
    (directory, exit) =>
      Exit.isFailure(exit)
        ? ignoreCleanupFailure(
            "Failed to roll back schedule staging directory",
            storage.fileSystem.remove(directory, { recursive: true, force: true }),
            { operation: "staging", phase: "rollback" },
          )
        : Effect.void,
  );
});

export const ensureDirectPath = Effect.fn("Schedules.ensureDirectPath")(function* (
  storage: Storage,
  candidate: string,
  label: string,
) {
  const [resolved, resolvedParent] = yield* Effect.all([
    storage.fileSystem.realPath(candidate),
    storage.fileSystem.realPath(storage.path.dirname(candidate)),
  ]).pipe(mapIo(`Failed to resolve ${label}`));
  const expected = storage.path.join(resolvedParent, storage.path.basename(candidate));
  if (storage.path.normalize(resolved) !== storage.path.normalize(expected)) {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: `${label} must not be a symbolic link`,
    });
  }
  return resolved;
});
