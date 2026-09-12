import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export interface Storage {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly schedulesDir: string;
  readonly temporaryId: () => Effect.Effect<string, Schedule.ScheduleError>;
}

export interface SourceTree {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly directories: ReadonlyArray<string>;
}

export interface LoadedSchedule {
  readonly view: Schedule.ScheduleView;
  readonly ownerWorkspaceId: string | null;
  readonly directory: string | null;
}

const ownerSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), ownerWorkspaceId: Schema.String }),
);
const definitionJson = Schema.fromJsonString(Schedule.ScheduleDefinition);
const runJson = Schema.fromJsonString(Schedule.ScheduleRunLifecycle);
const updateTransactionJson = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Literal("update"),
    id: Schedule.ScheduleId,
    state: Schedule.ScheduleEnabledState,
    nextState: Schedule.ScheduleEnabledState,
    revision: Schedule.ScheduleRevision,
  }),
);
const decodeUpdateTransaction = Schema.decodeUnknownOption(updateTransactionJson, {
  onExcessProperty: "error",
});
const replaceTransactionJson = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Literal("replace"),
    id: Schedule.ScheduleId,
    state: Schedule.ScheduleEnabledState,
  }),
);
const decodeReplaceTransaction = Schema.decodeUnknownOption(replaceTransactionJson, {
  onExcessProperty: "error",
});
const decodeDefinition = Schema.decodeUnknownEffect(definitionJson, { onExcessProperty: "error" });
const decodeRun = Schema.decodeUnknownEffect(runJson, { onExcessProperty: "error" });
const decodeOwner = Schema.decodeUnknownOption(ownerSchema);
const decodeScheduleId = Schema.decodeUnknownOption(Schedule.ScheduleId);
const decodeRunId = Schema.decodeUnknownOption(Schedule.ScheduleRunId);

const io = (message: string, cause?: unknown) =>
  new Schedule.ScheduleError({
    kind: "io",
    message:
      cause instanceof PlatformError.PlatformError ? `${message}: ${cause.reason._tag}` : message,
  });

const invalid = (message: string) => new Schedule.ScheduleError({ kind: "invalid", message });
const mapIo = (message: string) => Effect.mapError((cause: unknown) => io(message, cause));

const ignoreCleanupFailure = <A, E, R>(
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

const ensureRegularDestination = Effect.fn("Schedules.ensureRegularDestination")(function* (
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

const readDirectFileString = Effect.fn("Schedules.readDirectFileString")(function* (
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
const inspectDirectory = Effect.fn("Schedules.inspectDirectory")(function* (
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

const createDirectory = Effect.fn("Schedules.createDirectory")(function* (
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

const prepareStagingDirectory = Effect.fn("Schedules.prepareStagingDirectory")(function* (
  storage: Storage,
  name: string,
  children: ReadonlyArray<string> = [],
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
  for (const directory of [
    transaction,
    ...children.map((child) => storage.path.join(transaction, child)),
  ]) {
    const exists = yield* storage.fileSystem
      .exists(directory)
      .pipe(mapIo("Failed to inspect schedule staging path"));
    if (exists) {
      return yield* new Schedule.ScheduleError({
        kind: "corrupt",
        message: "Schedule staging path must not already exist",
      });
    }
    yield* createDirectory(storage, directory, "schedule staging directory");
  }
  return transaction;
});

const reconcileUpdate = Effect.fn("Schedules.reconcileUpdate")(function* (
  storage: Storage,
  transaction: string,
  entries: ReadonlyArray<string>,
) {
  if (!entries.includes("transaction.json")) return;
  const journal = decodeUpdateTransaction(
    yield* readDirectFileString(
      storage,
      storage.path.join(transaction, "transaction.json"),
      "schedule update journal",
    ),
  );
  if (journal._tag === "None") {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: "Invalid schedule update journal",
    });
  }
  if (!entries.includes("next.json")) return;
  const value = roots(storage);
  const original = storage.path.join(value[journal.value.state], journal.value.id);
  const destination = storage.path.join(value[journal.value.nextState], journal.value.id);
  if (original !== destination) {
    yield* ensureDirectPath(storage, value[journal.value.state], "schedule state directory");
    yield* ensureDirectPath(storage, value[journal.value.nextState], "schedule state directory");
    const originalExists = yield* inspectDirectory(storage, original, "update origin");
    const destinationExists = yield* inspectDirectory(storage, destination, "update destination");
    if (originalExists && destinationExists) {
      return yield* new Schedule.ScheduleError({
        kind: "corrupt",
        message: "Schedule update exists in both enabled and disabled directories",
      });
    }
    if (!originalExists && destinationExists) {
      const definition = yield* decodeDefinition(
        yield* readDirectFileString(
          storage,
          storage.path.join(destination, "meta.json"),
          "updated schedule metadata",
        ),
      ).pipe(Effect.mapError(() => invalid("Invalid updated schedule metadata")));
      if (definition.revision !== journal.value.revision) {
        yield* storage.fileSystem
          .rename(destination, original)
          .pipe(mapIo("Failed to recover schedule state"));
        yield* Effect.logInfo("Schedule update recovered").pipe(
          Effect.annotateLogs({
            component: "schedule",
            operation: "update",
            phase: "update-recovery",
            scheduleId: journal.value.id,
            state: journal.value.state,
          }),
        );
      }
    }
  }
  yield* storage.fileSystem
    .remove(storage.path.join(transaction, "next.json"), { force: true })
    .pipe(mapIo("Failed to clear recovered schedule update"));
});

export const reconcileUpdates = Effect.fn("Schedules.reconcileUpdates")(function* (
  storage: Storage,
) {
  const staging = roots(storage).staging;
  yield* ensureDirectPath(storage, staging, "schedule staging directory");
  const names = yield* storage.fileSystem
    .readDirectory(staging)
    .pipe(mapIo("Failed to inspect schedule staging directory"));
  for (const name of names) {
    if (!name.startsWith("update-")) continue;
    const transaction = storage.path.join(staging, name);
    yield* ensureDirectPath(storage, transaction, "schedule staging transaction");
    const entries = yield* storage.fileSystem
      .readDirectory(transaction)
      .pipe(mapIo("Failed to inspect schedule staging transaction"));
    yield* reconcileUpdate(storage, transaction, entries);
  }
});

const recoverReplacement = Effect.fn("Schedules.recoverReplacement")(function* (
  storage: Storage,
  transaction: string,
  entries: ReadonlyArray<string>,
) {
  if (!entries.includes("transaction.json")) {
    if (entries.includes("previous")) {
      return yield* new Schedule.ScheduleError({
        kind: "corrupt",
        message: "Retained schedule definition has no replacement journal",
      });
    }
    return;
  }
  const journal = decodeReplaceTransaction(
    yield* readDirectFileString(
      storage,
      storage.path.join(transaction, "transaction.json"),
      "schedule replacement journal",
    ),
  );
  if (journal._tag === "None") {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: "Invalid schedule replacement journal",
    });
  }
  const value = roots(storage);
  const destination = storage.path.join(value[journal.value.state], journal.value.id);
  const other = storage.path.join(
    value[journal.value.state === "enabled" ? "disabled" : "enabled"],
    journal.value.id,
  );
  const previous = storage.path.join(transaction, "previous");
  const destinationExists = yield* inspectDirectory(
    storage,
    destination,
    "replacement destination",
  );
  const otherExists = yield* inspectDirectory(storage, other, "replacement destination");
  const previousExists = yield* inspectDirectory(storage, previous, "retained schedule definition");
  if (!destinationExists && !otherExists) {
    if (!previousExists) {
      return yield* new Schedule.ScheduleError({
        kind: "corrupt",
        message: "Schedule replacement has no canonical or retained definition",
      });
    }
    yield* storage.fileSystem
      .rename(previous, destination)
      .pipe(mapIo("Failed to recover retained schedule definition"));
    yield* Effect.logInfo("Schedule replacement recovered").pipe(
      Effect.annotateLogs({
        component: "schedule",
        operation: "bootstrap",
        phase: "replacement-recovery",
        scheduleId: journal.value.id,
        state: journal.value.state,
      }),
    );
  }
});

export const bootstrap = Effect.fn("Schedules.bootstrap")(function* (storage: Storage) {
  const value = roots(storage);
  if (!(yield* inspectDirectory(storage, storage.schedulesDir, "schedule storage directory"))) {
    yield* createDirectory(storage, storage.schedulesDir, "schedule storage directory");
  }
  const children = [value.enabled, value.disabled, value.runs, value.staging];
  const missing: Array<string> = [];
  for (const directory of children) {
    if (!(yield* inspectDirectory(storage, directory, "schedule storage directory"))) {
      missing.push(directory);
    }
  }
  for (const directory of missing) {
    yield* createDirectory(storage, directory, "schedule storage directory");
  }

  const staged = yield* storage.fileSystem
    .readDirectory(value.staging)
    .pipe(mapIo("Failed to inspect schedule staging directory"));
  for (const name of staged) {
    if (
      !(
        name.startsWith("definition-") ||
        name.startsWith("run-") ||
        name.startsWith("update-") ||
        name.startsWith("replace-")
      )
    ) {
      return yield* new Schedule.ScheduleError({
        kind: "corrupt",
        message:
          "Unrecognized schedule staging transaction; inspect retained data before removing it",
      });
    }
    const transaction = storage.path.join(value.staging, name);
    yield* ensureDirectPath(storage, transaction, "schedule staging transaction");
    const entries = yield* storage.fileSystem
      .readDirectory(transaction)
      .pipe(mapIo("Failed to inspect schedule staging transaction"));
    if (name.startsWith("update-")) {
      yield* reconcileUpdate(storage, transaction, entries);
    } else if (name.startsWith("replace-")) {
      yield* recoverReplacement(storage, transaction, entries);
    }
    yield* storage.fileSystem
      .remove(transaction, { recursive: true, force: true })
      .pipe(mapIo("Failed to remove abandoned schedule staging data"));
  }
});

const ensureDirectPath = Effect.fn("Schedules.ensureDirectPath")(function* (
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
});
export const ensureRunAsset = Effect.fn("Schedules.ensureRunAsset")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
  relative: string,
) {
  const base = runDirectory(storage, run.scheduleId, run.id);
  const candidate = storage.path.resolve(base, relative);
  const relativeToBase = storage.path.relative(base, candidate);
  if (
    relativeToBase.length === 0 ||
    relativeToBase === ".." ||
    relativeToBase.startsWith(`..${storage.path.sep}`) ||
    storage.path.isAbsolute(relativeToBase)
  ) {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: `Run asset path escapes its run: ${relative}`,
    });
  }
  yield* ensureDirectPath(storage, base, "run directory");
  yield* ensureDirectPath(storage, storage.path.dirname(candidate), "run asset directory");
  yield* ensureDirectPath(storage, candidate, `run asset ${relative}`);
});

const inspectSourceTree = Effect.fn("Schedules.inspectSourceTree")(function* (
  storage: Storage,
  directory: string,
  owned: boolean,
  files?: Map<string, Uint8Array>,
): Effect.fn.Return<ReadonlyArray<string>, Schedule.ScheduleError> {
  if (!storage.path.isAbsolute(directory)) {
    return yield* invalid("sourceDirectory must be an absolute path");
  }
  if (!(yield* inspectDirectory(storage, directory, "schedule source directory"))) {
    return yield* invalid("sourceDirectory must name an existing directory");
  }
  let hasEntrypoint = false;
  const directories: Array<string> = [];
  const pending = [""];
  for (const relativeDirectory of pending) {
    const current = storage.path.join(directory, relativeDirectory);
    yield* ensureDirectPath(storage, current, "schedule source directory");
    const names = yield* storage.fileSystem
      .readDirectory(current)
      .pipe(mapIo("Failed to read schedule source directory"));
    for (const name of names) {
      if (name === "." || name === ".." || storage.path.basename(name) !== name) {
        return yield* invalid(`Invalid source entry name: ${name}`);
      }
      if (relativeDirectory === "") {
        if (owned && name === "meta.json") continue;
        const rootName = name.toLowerCase();
        if (rootName === "meta.json") {
          return yield* invalid(
            "meta.json is reserved for Pico metadata; remove it from sourceDirectory",
          );
        }
        if (rootName === "definition.json") {
          return yield* invalid(
            "definition.json is reserved for run metadata; rename the source asset",
          );
        }
      }
      const relative = storage.path.join(relativeDirectory, name);
      const asset = storage.path.join(directory, relative);
      yield* ensureDirectPath(storage, asset, `Source asset ${relative}`).pipe(
        Effect.mapError(() =>
          invalid(`Cannot read source asset ${relative}; symbolic links are not supported`),
        ),
      );
      const info = yield* storage.fileSystem
        .stat(asset)
        .pipe(mapIo(`Failed to inspect source asset ${relative}`));
      const entrypoint = relative === "script.js" || relative === "prompt.md";
      if (entrypoint && info.type !== "File") {
        return yield* invalid(`${relative} must be a nonblank regular file`);
      }
      if (info.type === "Directory") {
        directories.push(relative);
        pending.push(relative);
      } else if (info.type === "File") {
        if (entrypoint || files !== undefined) {
          const content = yield* storage.fileSystem
            .readFile(asset)
            .pipe(mapIo(`Failed to read source asset ${relative}`));
          if (entrypoint) {
            if (new TextDecoder().decode(content).trim() === "") {
              return yield* invalid(`${relative} must be a nonblank regular file`);
            }
            hasEntrypoint = true;
          }
          files?.set(relative, content);
        }
      } else {
        return yield* invalid(
          `Source asset ${relative} must be a regular file or directory; links and special files are not supported`,
        );
      }
    }
  }
  if (!hasEntrypoint) {
    return yield* invalid("sourceDirectory requires script.js and/or prompt.md at its root");
  }
  return directories;
});

export const loadSourceTree = Effect.fn("Schedules.loadSourceTree")(function* (
  storage: Storage,
  directory: string,
  owned = false,
): Effect.fn.Return<SourceTree, Schedule.ScheduleError> {
  const files = new Map<string, Uint8Array>();
  const directories = yield* inspectSourceTree(storage, directory, owned, files);
  return { files, directories };
});

const writeSourceTree = Effect.fn("Schedules.writeSourceTree")(function* (
  storage: Storage,
  directory: string,
  source: SourceTree,
) {
  for (const relative of source.directories) {
    yield* createDirectory(
      storage,
      storage.path.join(directory, relative),
      "schedule source directory",
    );
  }
  for (const [relative, content] of source.files) {
    const file = storage.path.join(directory, relative);
    yield* ensureDirectPath(storage, storage.path.dirname(file), "schedule source directory");
    yield* storage.fileSystem
      .writeFile(file, content, { flag: "wx", mode: 0o600 })
      .pipe(mapIo("Failed to copy schedule source asset"));
  }
});

const ownerFromSource = (source: string) => {
  const decoded = decodeOwner(source);
  return decoded._tag === "Some" ? decoded.value.ownerWorkspaceId : null;
};

const invalidLoaded = (
  id: Schedule.ScheduleId,
  state: "enabled" | "disabled" | "conflicted",
  message: string,
  ownerWorkspaceId: string | null,
  directory: string | null,
): LoadedSchedule => ({
  view: {
    kind: "invalid",
    id,
    state,
    error: message,
    sourceDirectory: directory === null ? null : AbsolutePath.make(directory),
  },
  ownerWorkspaceId,
  directory,
});

export const loadSchedule = Effect.fn("Schedules.loadSchedule")(function* (
  storage: Storage,
  id: Schedule.ScheduleId,
): Effect.fn.Return<LoadedSchedule | undefined, Schedule.ScheduleError> {
  const value = roots(storage);
  const enabledDir = storage.path.join(value.enabled, id);
  const disabledDir = storage.path.join(value.disabled, id);
  const enabled = yield* storage.fileSystem
    .exists(enabledDir)
    .pipe(mapIo("Failed to inspect schedule"));
  const disabled = yield* storage.fileSystem
    .exists(disabledDir)
    .pipe(mapIo("Failed to inspect schedule"));
  if (!enabled && !disabled) return undefined;

  if (enabled && disabled) {
    yield* ensureDirectPath(storage, enabledDir, "enabled schedule directory");
    yield* ensureDirectPath(storage, disabledDir, "disabled schedule directory");
    const enabledMetadata = yield* readDirectFileString(
      storage,
      storage.path.join(enabledDir, "meta.json"),
      "enabled schedule metadata",
    ).pipe(Effect.result);
    const disabledMetadata = yield* readDirectFileString(
      storage,
      storage.path.join(disabledDir, "meta.json"),
      "disabled schedule metadata",
    ).pipe(Effect.result);
    const enabledOwner = Result.isSuccess(enabledMetadata)
      ? ownerFromSource(enabledMetadata.success)
      : null;
    const disabledOwner = Result.isSuccess(disabledMetadata)
      ? ownerFromSource(disabledMetadata.success)
      : null;
    return invalidLoaded(
      id,
      "conflicted",
      "Schedule exists in both enabled and disabled state directories",
      enabledOwner !== null && enabledOwner === disabledOwner ? enabledOwner : null,
      null,
    );
  }

  const state = enabled ? "enabled" : "disabled";
  const directory = enabled ? enabledDir : disabledDir;
  yield* ensureDirectPath(storage, directory, "schedule directory");
  const metaFile = storage.path.join(directory, "meta.json");
  const metadata = yield* readDirectFileString(storage, metaFile, "schedule metadata").pipe(
    Effect.result,
  );
  if (Result.isFailure(metadata)) {
    return invalidLoaded(id, state, metadata.failure.message, null, directory);
  }
  const metaSource = metadata.success;
  const loaded = yield* Effect.gen(function* () {
    const definition = yield* decodeDefinition(metaSource).pipe(
      Effect.mapError(() => invalid("Invalid schedule metadata")),
    );
    yield* inspectSourceTree(storage, directory, true);
    return {
      view: {
        kind: "ready",
        id,
        state,
        definition,
        sourceDirectory: AbsolutePath.make(directory),
      },
      ownerWorkspaceId: definition.ownerWorkspaceId,
      directory,
    } satisfies LoadedSchedule;
  }).pipe(Effect.result);

  if (Result.isSuccess(loaded)) return loaded.success;
  return invalidLoaded(id, state, loaded.failure.message, ownerFromSource(metaSource), directory);
});

export const scanSchedules = Effect.fn("Schedules.scanSchedules")(function* (storage: Storage) {
  const value = roots(storage);
  const names = new Set<string>();
  for (const stateDirectory of [value.enabled, value.disabled]) {
    yield* ensureDirectPath(storage, stateDirectory, "schedule state directory");
    const entries = yield* storage.fileSystem
      .readDirectory(stateDirectory)
      .pipe(mapIo("Failed to scan schedules"));
    for (const name of entries) names.add(name);
  }

  const loaded: Array<LoadedSchedule> = [];
  for (const name of [...names].sort()) {
    const decoded = decodeScheduleId(name);
    if (decoded._tag === "None") continue;
    const schedule = yield* loadSchedule(storage, decoded.value);
    if (schedule !== undefined) loaded.push(schedule);
  }
  return loaded;
});

const writeDefinitionDirectory = Effect.fn("Schedules.writeDefinitionDirectory")(function* (
  storage: Storage,
  directory: string,
  definition: Schedule.ScheduleDefinition,
  source: SourceTree,
) {
  yield* ensureDirectPath(storage, directory, "schedule staging directory");
  yield* storage.fileSystem
    .writeFileString(storage.path.join(directory, "meta.json"), JSON.stringify(definition), {
      flag: "wx",
      mode: 0o600,
    })
    .pipe(mapIo("Failed to stage schedule metadata"));
  yield* writeSourceTree(storage, directory, source);
});

export const publishDefinition = Effect.fn("Schedules.publishDefinition")(function* (
  storage: Storage,
  id: Schedule.ScheduleId,
  state: Schedule.ScheduleEnabledState,
  definition: Schedule.ScheduleDefinition,
  source: SourceTree,
  transactionId: string,
) {
  const value = roots(storage);
  const stage = yield* prepareStagingDirectory(storage, `definition-${transactionId}`);
  yield* writeDefinitionDirectory(storage, stage, definition, source);
  const destinationRoot = state === "enabled" ? value.enabled : value.disabled;
  if (!(yield* inspectDirectory(storage, destinationRoot, "schedule state directory"))) {
    return yield* invalid("Schedule state directory must exist before publication");
  }
  const destination = storage.path.join(destinationRoot, id);
  yield* storage.fileSystem.rename(stage, destination).pipe(mapIo("Failed to publish schedule"));
});

export const updateDefinition = Effect.fn("Schedules.updateDefinition")(function* (
  storage: Storage,
  current: LoadedSchedule,
  definition: Schedule.ScheduleDefinition,
  state: Schedule.ScheduleEnabledState,
  transactionId: string,
) {
  if (current.view.kind !== "ready" || current.directory === null) {
    return yield* invalid("Invalid schedules cannot be updated");
  }
  const original = current.directory;
  const originalState = current.view.state;
  const value = roots(storage);
  const transaction = yield* prepareStagingDirectory(storage, `update-${transactionId}`);
  const next = storage.path.join(transaction, "next.json");
  const destination = storage.path.join(value[state], current.view.id);
  let moved = false;
  yield* Effect.uninterruptibleMask((restore) =>
    restore(
      Effect.gen(function* () {
        yield* storage.fileSystem
          .writeFileString(next, JSON.stringify(definition), {
            flag: "wx",
            mode: 0o600,
          })
          .pipe(mapIo("Failed to stage schedule metadata"));
        yield* storage.fileSystem
          .writeFileString(
            storage.path.join(transaction, "transaction.json"),
            JSON.stringify({
              kind: "update",
              id: current.view.id,
              state: originalState,
              nextState: state,
              revision: definition.revision,
            }),
            { flag: "wx", mode: 0o600 },
          )
          .pipe(mapIo("Failed to stage schedule update journal"));
      }),
    ).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          yield* ensureDirectPath(storage, value[originalState], "schedule state directory");
          yield* moveDefinition(storage, current, state);
          moved = destination !== original;
          const metadata = storage.path.join(destination, "meta.json");
          yield* ensureRegularDestination(storage, metadata, "schedule metadata");
          yield* storage.fileSystem
            .rename(next, metadata)
            .pipe(mapIo("Failed to install schedule metadata"));
        }),
      ),
      Effect.onExit((exit) =>
        ignoreCleanupFailure(
          Exit.isFailure(exit)
            ? "Failed to roll back schedule update"
            : "Failed to remove schedule update staging",
          Effect.gen(function* () {
            if (Exit.isFailure(exit)) {
              if (moved) {
                yield* ensureDirectPath(storage, value[originalState], "schedule state directory");
                yield* storage.fileSystem.rename(destination, original);
              }
              yield* storage.fileSystem.remove(next, { force: true });
            }
            yield* storage.fileSystem.remove(transaction, { recursive: true, force: true });
          }),
          {
            operation: "update",
            phase: Exit.isFailure(exit) ? "rollback" : "cleanup",
            scheduleId: current.view.id,
            definitionRevision: definition.revision,
          },
        ),
      ),
    ),
  );
});

export const moveDefinition = Effect.fn("Schedules.moveDefinition")(function* (
  storage: Storage,
  loaded: LoadedSchedule,
  state: Schedule.ScheduleEnabledState,
) {
  if (loaded.directory === null || loaded.view.state === "conflicted") {
    return yield* new Schedule.ScheduleError({
      kind: "conflict",
      message: "Conflicted schedules cannot change state",
    });
  }
  yield* ensureDirectPath(storage, loaded.directory, "schedule directory");
  if (loaded.view.state === state) return;
  const value = roots(storage);
  const destinationRoot = state === "enabled" ? value.enabled : value.disabled;
  if (!(yield* inspectDirectory(storage, destinationRoot, "schedule state directory"))) {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: "Schedule state directory must exist before changing state",
    });
  }
  const destination = storage.path.join(destinationRoot, loaded.view.id);
  yield* storage.fileSystem
    .rename(loaded.directory, destination)
    .pipe(mapIo("Failed to change schedule state"));
});

export const removeDefinition = Effect.fn("Schedules.removeDefinition")(function* (
  storage: Storage,
  loaded: LoadedSchedule,
) {
  if (loaded.directory === null) {
    return yield* new Schedule.ScheduleError({
      kind: "invalid",
      message: "Invalid schedules cannot be deleted",
    });
  }
  yield* ensureDirectPath(storage, loaded.directory, "schedule directory");
  yield* storage.fileSystem
    .remove(loaded.directory, { recursive: true })
    .pipe(mapIo("Failed to delete schedule definition"));
});

export const runDirectory = (
  storage: Storage,
  scheduleId: Schedule.ScheduleId,
  runId: Schedule.ScheduleRunId,
) => storage.path.join(roots(storage).runs, scheduleId, runId);

export const publishRun = Effect.fn("Schedules.publishRun")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
  definition: Schedule.ScheduleDefinition,
  source: SourceTree,
  transactionId: string,
) {
  const value = roots(storage);
  const stage = yield* prepareStagingDirectory(storage, `run-${transactionId}`, ["input"]);
  const input = storage.path.join(stage, "input");
  yield* storage.fileSystem
    .writeFileString(storage.path.join(stage, "run.json"), JSON.stringify(run), {
      flag: "wx",
      mode: 0o600,
    })
    .pipe(mapIo("Failed to stage run lifecycle"));
  yield* storage.fileSystem
    .writeFileString(storage.path.join(input, "definition.json"), JSON.stringify(definition), {
      flag: "wx",
      mode: 0o600,
    })
    .pipe(mapIo("Failed to snapshot run definition"));
  yield* writeSourceTree(storage, input, source);
  const parent = storage.path.join(value.runs, run.scheduleId);
  yield* ensureDirectPath(storage, value.runs, "run storage directory");
  const parentExists = yield* storage.fileSystem
    .exists(parent)
    .pipe(mapIo("Failed to inspect run schedule directory"));
  if (!parentExists) {
    yield* storage.fileSystem
      .makeDirectory(parent, { mode: 0o700 })
      .pipe(mapIo("Failed to create run schedule directory"));
  }
  yield* ensureDirectPath(storage, parent, "run schedule directory");
  yield* storage.fileSystem
    .rename(stage, storage.path.join(parent, run.id))
    .pipe(mapIo("Failed to publish schedule run claim"));
});

const prepareRunFile = Effect.fn("Schedules.prepareRunFile")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
  relative: string,
) {
  const base = runDirectory(storage, run.scheduleId, run.id);
  const file = storage.path.resolve(base, relative);
  const relativeToBase = storage.path.relative(base, file);
  if (
    relativeToBase.length === 0 ||
    relativeToBase === ".." ||
    relativeToBase.startsWith(`..${storage.path.sep}`) ||
    storage.path.isAbsolute(relativeToBase)
  ) {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: `Run asset path escapes its run: ${relative}`,
    });
  }

  yield* ensureDirectPath(storage, base, "run directory");
  const parent = storage.path.dirname(file);
  const relativeParent = storage.path.relative(base, parent);
  let current = base;
  for (const segment of relativeParent === "" ? [] : relativeParent.split(storage.path.sep)) {
    current = storage.path.join(current, segment);
    const exists = yield* storage.fileSystem
      .exists(current)
      .pipe(mapIo("Failed to inspect run artifact directory"));
    if (!exists) {
      yield* storage.fileSystem
        .makeDirectory(current, { mode: 0o700 })
        .pipe(mapIo("Failed to create run artifact directory"));
    }
    yield* ensureDirectPath(storage, current, "run artifact directory");
    const info = yield* storage.fileSystem
      .stat(current)
      .pipe(mapIo("Failed to inspect run artifact directory"));
    if (info.type !== "Directory") {
      return yield* new Schedule.ScheduleError({
        kind: "corrupt",
        message: "Run artifact parent must be a directory",
      });
    }
  }
  return file;
});

const writeRunFile = Effect.fn("Schedules.writeRunFile")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
  relative: string,
  content: Uint8Array,
  temporaryId: string,
) {
  const file = yield* prepareRunFile(storage, run, relative);
  yield* ensureRegularDestination(storage, file, `run asset ${relative}`);
  const temporary = storage.path.join(
    storage.path.dirname(file),
    `.${storage.path.basename(file)}-${temporaryId}.tmp`,
  );
  yield* storage.fileSystem
    .writeFile(temporary, content, { flag: "wx", mode: 0o600 })
    .pipe(mapIo("Failed to write temporary run artifact"));
  yield* storage.fileSystem.rename(temporary, file).pipe(
    Effect.tapError(() =>
      ignoreCleanupFailure(
        "Failed to remove temporary run artifact",
        storage.fileSystem.remove(temporary, { force: true }),
        {
          operation: "write-artifact",
          phase: "temporary-cleanup",
          scheduleId: run.scheduleId,
          runId: run.id,
          artifact: relative,
        },
      ),
    ),
    mapIo("Failed to commit run artifact"),
  );
});

export const writeRun = Effect.fn("Schedules.writeRun")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
  transactionId: string,
) {
  yield* writeRunFile(
    storage,
    run,
    "run.json",
    new TextEncoder().encode(JSON.stringify(run)),
    transactionId,
  );
});

export const readRuns = Effect.fn("Schedules.readRuns")(function* (
  storage: Storage,
  scheduleId?: Schedule.ScheduleId,
) {
  const base = roots(storage).runs;
  yield* ensureDirectPath(storage, base, "run storage directory");
  const scheduleNames =
    scheduleId === undefined
      ? yield* storage.fileSystem.readDirectory(base).pipe(mapIo("Failed to scan runs"))
      : [scheduleId];
  const runs: Array<Schedule.ScheduleRunLifecycle> = [];
  for (const scheduleName of scheduleNames) {
    const directoryScheduleId = decodeScheduleId(scheduleName);
    if (directoryScheduleId._tag === "None") continue;
    const scheduleDirectory = storage.path.join(base, scheduleName);
    if (
      !(yield* storage.fileSystem.exists(scheduleDirectory).pipe(mapIo("Failed to inspect runs")))
    )
      continue;
    yield* ensureDirectPath(storage, scheduleDirectory, "run schedule directory");
    const names = yield* storage.fileSystem
      .readDirectory(scheduleDirectory)
      .pipe(mapIo("Failed to scan schedule runs"));
    for (const name of names) {
      const directoryRunId = decodeRunId(name);
      if (directoryRunId._tag === "None") continue;
      const runDirectoryPath = storage.path.join(scheduleDirectory, name);
      yield* ensureDirectPath(storage, runDirectoryPath, "run directory");
      const runFile = storage.path.join(runDirectoryPath, "run.json");
      const source = yield* readDirectFileString(storage, runFile, "run lifecycle");
      const run = yield* decodeRun(source).pipe(
        Effect.mapError(
          () =>
            new Schedule.ScheduleError({
              kind: "corrupt",
              message: "Invalid run lifecycle",
            }),
        ),
      );
      const expectedRunId = Schedule.ScheduleRunId.make(
        `scheduled-${run.source.scheduledFor}-${run.definitionRevision}`,
      );
      if (
        run.scheduleId !== directoryScheduleId.value ||
        run.id !== directoryRunId.value ||
        run.id !== expectedRunId
      ) {
        return yield* new Schedule.ScheduleError({
          kind: "corrupt",
          message: "Run lifecycle identity does not match its containing directories and source",
        });
      }
      runs.push(run);
    }
  }
  return runs;
});

export const readRunDefinition = Effect.fn("Schedules.readRunDefinition")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
) {
  const file = storage.path.join(
    runDirectory(storage, run.scheduleId, run.id),
    "input",
    "definition.json",
  );
  yield* ensureRunAsset(storage, run, "input/definition.json");
  const source = yield* readDirectFileString(storage, file, "run definition snapshot");
  return yield* decodeDefinition(source).pipe(
    Effect.mapError(
      () =>
        new Schedule.ScheduleError({
          kind: "corrupt",
          message: "Invalid run definition snapshot",
        }),
    ),
  );
});

export const writeArtifactString = Effect.fn("Schedules.writeArtifactString")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
  relative: string,
  content: string,
) {
  yield* writeRunFile(
    storage,
    run,
    relative,
    new TextEncoder().encode(content),
    yield* storage.temporaryId(),
  );
});

export const appendArtifactString = Effect.fn("Schedules.appendArtifactString")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
  relative: string,
  content: string,
) {
  const file = yield* prepareRunFile(storage, run, relative);
  const temporary = storage.path.join(
    storage.path.dirname(file),
    `.${storage.path.basename(file)}-${yield* storage.temporaryId()}.append`,
  );
  const cleanup = ignoreCleanupFailure(
    "Failed to remove temporary run append target",
    storage.fileSystem.remove(temporary, { force: true }),
    {
      operation: "append-artifact",
      phase: "temporary-cleanup",
      scheduleId: run.scheduleId,
      runId: run.id,
      artifact: relative,
    },
  );
  yield* Effect.uninterruptibleMask((restore) =>
    restore(
      Effect.gen(function* () {
        const source = yield* ensureRegularDestination(storage, file, `run asset ${relative}`);
        if (source === undefined) {
          return yield* io("Run append target disappeared before it could be copied");
        }
        yield* storage.fileSystem
          .copyFile(file, temporary)
          .pipe(mapIo("Failed to copy run append target"));
        const copiedSource = yield* ensureRegularDestination(
          storage,
          file,
          `run asset ${relative}`,
        );
        const expected = yield* ensureRegularDestination(
          storage,
          temporary,
          `temporary run asset ${relative}`,
        );
        const sourceInode = source.ino._tag === "Some" ? source.ino.value : undefined;
        const copiedSourceInode =
          copiedSource?.ino._tag === "Some" ? copiedSource.ino.value : undefined;
        if (
          copiedSource === undefined ||
          copiedSource.type !== "File" ||
          copiedSource.dev !== source.dev ||
          copiedSourceInode !== sourceInode ||
          copiedSource.size !== source.size ||
          expected === undefined
        ) {
          return yield* new Schedule.ScheduleError({
            kind: "corrupt",
            message: `Run asset ${relative} changed while preparing append`,
          });
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* storage.fileSystem
              .open(temporary, { flag: "r+", mode: 0o600 })
              .pipe(mapIo("Failed to open temporary run append target"));
            const actual = yield* handle.stat.pipe(
              mapIo("Failed to inspect opened run append target"),
            );
            const expectedInode = expected.ino._tag === "Some" ? expected.ino.value : undefined;
            const actualInode = actual.ino._tag === "Some" ? actual.ino.value : undefined;
            if (
              actual.type !== "File" ||
              actual.dev !== expected.dev ||
              expectedInode !== actualInode ||
              actual.size !== expected.size
            ) {
              return yield* new Schedule.ScheduleError({
                kind: "corrupt",
                message: `Run asset ${relative} changed before append`,
              });
            }
            yield* handle.seek(actual.size, "start");
            yield* handle
              .writeAll(new TextEncoder().encode(content))
              .pipe(mapIo("Failed to append run artifact"));
          }),
        );
        yield* storage.fileSystem
          .rename(temporary, file)
          .pipe(mapIo("Failed to commit run append"));
      }),
    ).pipe(Effect.ensuring(cleanup)),
  );
});

export const writeArtifact = Effect.fn("Schedules.writeArtifact")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
  relative: string,
  content: Uint8Array,
) {
  yield* writeRunFile(storage, run, relative, content, yield* storage.temporaryId());
});
