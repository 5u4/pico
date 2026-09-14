import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { inspectSource } from "./source-files.ts";
import {
  createDirectory,
  ensureDirectPath,
  ensureRegularDestination,
  ignoreCleanupFailure,
  inspectDirectory,
  invalid,
  mapIo,
  prepareStagingDirectory,
  readDirectFileString,
  roots,
  type Storage,
} from "./storage.ts";

export interface LoadedSchedule {
  readonly view: Schedule.ScheduleView;
  readonly ownerWorkspaceId: string | null;
  readonly directory: string | null;
}

const ownerSchema = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literals([1, 2]), ownerWorkspaceId: Schema.String }),
);

const legacyDefinition = Schema.Struct({
  ...Schedule.ScheduleDefinition.fields,
  version: Schema.Literal(1),
  replyTarget: Schema.optional(
    Schema.Struct({
      platform: Schema.Literal("discord"),
      conversationId: Schema.NonEmptyString,
      messageId: Schema.NonEmptyString,
    }),
  ),
});
const storedDefinition = Schema.Union([Schedule.ScheduleDefinition, legacyDefinition]);
const definitionJson = Schema.fromJsonString(storedDefinition);

const currentDefinition = (stored: typeof storedDefinition.Type): Schedule.ScheduleDefinition => {
  if (stored.version === 2) return stored;
  const { version: _version, replyTarget: _replyTarget, ...definition } = stored;
  return { ...definition, version: 2 };
};

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

const decodeStoredDefinition = Schema.decodeUnknownEffect(definitionJson, {
  onExcessProperty: "error",
});

export const decodeDefinition = (source: string) =>
  decodeStoredDefinition(source).pipe(Effect.map(currentDefinition));

const decodeOwner = Schema.decodeUnknownOption(ownerSchema);

export const decodeScheduleId = Schema.decodeUnknownOption(Schedule.ScheduleId);

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
  if (destinationExists && otherExists) {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: "Schedule replacement exists in both enabled and disabled directories",
    });
  }
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
    const loaded = {
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
    yield* inspectSource(storage, directory, true);
    return loaded;
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

export const publishDefinition = Effect.fn("Schedules.publishDefinition")(function* (
  storage: Storage,
  id: Schedule.ScheduleId,
  state: Schedule.ScheduleEnabledState,
  definition: Schedule.ScheduleDefinition,
  sourceDirectory: string,
  transactionId: string,
) {
  const value = roots(storage);
  yield* Effect.acquireUseRelease(
    prepareStagingDirectory(storage, `definition-${transactionId}`),
    (stage) =>
      Effect.gen(function* () {
        yield* storage.fileSystem
          .writeFileString(storage.path.join(stage, "meta.json"), JSON.stringify(definition), {
            flag: "wx",
            mode: 0o600,
          })
          .pipe(mapIo("Failed to stage schedule metadata"));
        yield* inspectSource(storage, sourceDirectory, false, stage);
        const destinationRoot = state === "enabled" ? value.enabled : value.disabled;
        if (!(yield* inspectDirectory(storage, destinationRoot, "schedule state directory"))) {
          return yield* invalid("Schedule state directory must exist before publication");
        }
        const destination = storage.path.join(destinationRoot, id);
        yield* storage.fileSystem
          .rename(stage, destination)
          .pipe(mapIo("Failed to publish schedule"));
      }),
    (stage) =>
      ignoreCleanupFailure(
        "Failed to remove schedule definition staging",
        storage.fileSystem.remove(stage, { recursive: true, force: true }),
        { operation: "create", phase: "cleanup", scheduleId: id },
      ),
  );
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
