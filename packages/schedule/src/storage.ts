import * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export interface Storage {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly schedulesDir: string;
  readonly temporaryId: () => Effect.Effect<string, Schedule.ScheduleError>;
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
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });

const invalid = (message: string) => new Schedule.ScheduleError({ kind: "invalid", message });
const mapIo = (message: string) => Effect.mapError((cause: unknown) => io(message, cause));

const ignoreCleanupFailure = <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logError(message, Cause.pretty(cause))),
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
    const transaction = storage.path.join(value.staging, name);
    yield* ensureDirectPath(storage, transaction, "schedule staging transaction");
    const journalFile = storage.path.join(transaction, "transaction.json");
    const journalSource = yield* readDirectFileString(
      storage,
      journalFile,
      "schedule replacement journal",
    ).pipe(
      Effect.catch((error) =>
        Effect.logError("Failed to read schedule replacement journal", {
          message: error.message,
          kind: error.kind,
        }).pipe(Effect.as("")),
      ),
    );
    const journal = decodeReplaceTransaction(journalSource);
    if (journal._tag === "Some") {
      const destination = storage.path.join(
        journal.value.state === "enabled" ? value.enabled : value.disabled,
        journal.value.id,
      );
      const previous = storage.path.join(transaction, "previous");
      const destinationExists = yield* storage.fileSystem
        .exists(destination)
        .pipe(mapIo("Failed to inspect replacement destination"));
      const previousExists = yield* storage.fileSystem
        .exists(previous)
        .pipe(mapIo("Failed to inspect retained schedule definition"));
      if (!destinationExists && previousExists) {
        yield* storage.fileSystem
          .rename(previous, destination)
          .pipe(mapIo("Failed to recover retained schedule definition"));
      }
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

const definitionFiles = new Set(["meta.json", "script.js", "prompt.md"]);

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
  view: { kind: "invalid", id, state, error: message },
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
      Effect.mapError((cause) => invalid(`Invalid schedule metadata: ${cause}`)),
    );
    const names = yield* storage.fileSystem
      .readDirectory(directory)
      .pipe(mapIo("Failed to inspect schedule assets"));
    const present = new Set(names);
    if (
      names.some((name: string) => !definitionFiles.has(name)) ||
      !present.has("meta.json") ||
      (!present.has("script.js") && !present.has("prompt.md"))
    ) {
      return yield* invalid(
        "Schedule definitions require meta.json and at least one of script.js or prompt.md, with no other files",
      );
    }
    const script = present.has("script.js")
      ? yield* readDirectFileString(
          storage,
          storage.path.join(directory, "script.js"),
          "schedule script",
        )
      : null;
    const prompt = present.has("prompt.md")
      ? yield* readDirectFileString(
          storage,
          storage.path.join(directory, "prompt.md"),
          "schedule prompt",
        )
      : null;
    return {
      view: {
        kind: "ready",
        id,
        state,
        definition,
        source: { script, prompt },
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
  source: Schedule.ScheduleSource,
) {
  yield* storage.fileSystem
    .makeDirectory(directory, { recursive: true, mode: 0o700 })
    .pipe(mapIo("Failed to stage schedule directory"));
  yield* storage.fileSystem
    .writeFileString(storage.path.join(directory, "meta.json"), JSON.stringify(definition), {
      flag: "wx",
      mode: 0o600,
    })
    .pipe(mapIo("Failed to stage schedule metadata"));
  if (source.script !== null) {
    yield* storage.fileSystem
      .writeFileString(storage.path.join(directory, "script.js"), source.script, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(mapIo("Failed to stage schedule script"));
  }
  if (source.prompt !== null) {
    yield* storage.fileSystem
      .writeFileString(storage.path.join(directory, "prompt.md"), source.prompt, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(mapIo("Failed to stage schedule prompt"));
  }
});

export const publishDefinition = Effect.fn("Schedules.publishDefinition")(function* (
  storage: Storage,
  id: Schedule.ScheduleId,
  state: Schedule.ScheduleEnabledState,
  definition: Schedule.ScheduleDefinition,
  source: Schedule.ScheduleSource,
  transactionId: string,
) {
  const value = roots(storage);
  const stage = storage.path.join(value.staging, `definition-${transactionId}`);
  const destination = storage.path.join(state === "enabled" ? value.enabled : value.disabled, id);
  yield* writeDefinitionDirectory(storage, stage, definition, source);
  yield* storage.fileSystem.rename(stage, destination).pipe(mapIo("Failed to publish schedule"));
});

export const replaceDefinition = Effect.fn("Schedules.replaceDefinition")(function* (
  storage: Storage,
  current: LoadedSchedule,
  definition: Schedule.ScheduleDefinition,
  source: Schedule.ScheduleSource,
  transactionId: string,
) {
  if (current.view.kind !== "ready" || current.directory === null) {
    return yield* new Schedule.ScheduleError({
      kind: "invalid",
      message: "Invalid schedules cannot be updated",
    });
  }
  const currentDirectory = current.directory;
  const value = roots(storage);
  const transaction = storage.path.join(value.staging, `replace-${transactionId}`);
  const next = storage.path.join(transaction, "next");
  const previous = storage.path.join(transaction, "previous");
  yield* storage.fileSystem
    .makeDirectory(transaction, { recursive: true, mode: 0o700 })
    .pipe(mapIo("Failed to stage schedule replacement"));
  yield* storage.fileSystem
    .writeFileString(
      storage.path.join(transaction, "transaction.json"),
      JSON.stringify({ kind: "replace", id: current.view.id, state: current.view.state }),
      { flag: "wx", mode: 0o600 },
    )
    .pipe(mapIo("Failed to stage schedule replacement journal"));
  yield* writeDefinitionDirectory(storage, next, definition, source);
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      yield* storage.fileSystem
        .rename(currentDirectory, previous)
        .pipe(mapIo("Failed to retain previous schedule definition"));
      const destination = storage.path.join(
        current.view.state === "enabled" ? value.enabled : value.disabled,
        current.view.id,
      );
      yield* storage.fileSystem.rename(next, destination).pipe(
        Effect.tapError(() =>
          ignoreCleanupFailure(
            "Failed to restore retained schedule definition",
            storage.fileSystem.rename(previous, destination),
          ),
        ),
        mapIo("Failed to install schedule replacement"),
      );
    }),
  );
  yield* storage.fileSystem
    .remove(transaction, { recursive: true, force: true })
    .pipe(mapIo("Failed to clean schedule replacement"));
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
  const destination = storage.path.join(
    state === "enabled" ? value.enabled : value.disabled,
    loaded.view.id,
  );
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
  source: Schedule.ScheduleSource,
  transactionId: string,
) {
  const value = roots(storage);
  const stage = storage.path.join(value.staging, `run-${transactionId}`);
  const input = storage.path.join(stage, "input");
  yield* storage.fileSystem
    .makeDirectory(input, { recursive: true, mode: 0o700 })
    .pipe(mapIo("Failed to stage run"));
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
  if (source.script !== null) {
    yield* storage.fileSystem
      .writeFileString(storage.path.join(input, "script.js"), source.script, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(mapIo("Failed to snapshot run script"));
  }
  if (source.prompt !== null) {
    yield* storage.fileSystem
      .writeFileString(storage.path.join(input, "prompt.md"), source.prompt, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(mapIo("Failed to snapshot run prompt"));
  }
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
          (cause) =>
            new Schedule.ScheduleError({
              kind: "corrupt",
              message: `Invalid run lifecycle: ${cause}`,
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
      (cause) =>
        new Schedule.ScheduleError({
          kind: "corrupt",
          message: `Invalid run definition snapshot: ${cause}`,
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
