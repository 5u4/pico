import * as Schedule from "@pico/contract/schedule";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeDefinition, decodeScheduleId } from "./definition-storage.ts";
import { inspectSource } from "./source-files.ts";
import {
  createDirectory,
  ensureDirectPath,
  ensureRegularDestination,
  ignoreCleanupFailure,
  inspectDirectory,
  io,
  mapIo,
  prepareStagingDirectory,
  readDirectFileString,
  roots,
  type Storage,
} from "./storage.ts";

const runJson = Schema.fromJsonString(Schedule.ScheduleRunLifecycle);

const decodeRun = Schema.decodeUnknownEffect(runJson, { onExcessProperty: "error" });

const decodeRunId = Schema.decodeUnknownOption(Schedule.ScheduleRunId);

const snapshotLayout = Schema.Struct({
  version: Schema.Literal(1),
  layout: Schema.Literal("run-root"),
});
const snapshotLayoutSource = JSON.stringify(
  snapshotLayout.make({ version: 1, layout: "run-root" }),
);
const decodeSnapshotLayout = Schema.decodeUnknownEffect(Schema.fromJsonString(snapshotLayout), {
  onExcessProperty: "error",
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

export const runDirectory = (
  storage: Storage,
  scheduleId: Schedule.ScheduleId,
  runId: Schedule.ScheduleRunId,
) => storage.path.join(roots(storage).runs, scheduleId, runId);

export const publishRun = Effect.fn("Schedules.publishRun")(function* (
  storage: Storage,
  run: Schedule.ScheduleRunLifecycle,
  definition: Schedule.ScheduleDefinition,
  sourceDirectory: string,
  transactionId: string,
  onPublished: Effect.Effect<void>,
) {
  const value = roots(storage);
  return yield* Effect.acquireUseRelease(
    prepareStagingDirectory(storage, `run-${transactionId}`),
    (stage) =>
      Effect.gen(function* () {
        const input = storage.path.join(stage, "input");
        yield* inspectDirectory(storage, input, "run input directory");
        yield* createDirectory(storage, input, "run input directory");
        yield* storage.fileSystem
          .writeFileString(storage.path.join(stage, "run.json"), JSON.stringify(run), {
            flag: "wx",
            mode: 0o600,
          })
          .pipe(mapIo("Failed to stage run lifecycle"));
        yield* storage.fileSystem
          .writeFileString(
            storage.path.join(stage, "definition.json"),
            JSON.stringify(definition),
            {
              flag: "wx",
              mode: 0o600,
            },
          )
          .pipe(mapIo("Failed to snapshot run definition"));
        yield* storage.fileSystem
          .writeFileString(storage.path.join(stage, "snapshot-layout.json"), snapshotLayoutSource, {
            flag: "wx",
            mode: 0o600,
          })
          .pipe(mapIo("Failed to stage run snapshot layout"));
        const execution = yield* inspectSource(storage, sourceDirectory, true, input);
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
          .pipe(
            mapIo("Failed to publish schedule run claim"),
            Effect.andThen(onPublished),
            Effect.uninterruptible,
          );
        return execution;
      }),
    (stage) =>
      ignoreCleanupFailure(
        "Failed to remove schedule run staging",
        storage.fileSystem.remove(stage, { recursive: true, force: true }),
        { operation: "claim", phase: "cleanup", scheduleId: run.scheduleId, runId: run.id },
      ),
  );
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
  const directory = runDirectory(storage, run.scheduleId, run.id);
  yield* ensureDirectPath(storage, directory, "run directory");
  const entries = yield* storage.fileSystem
    .readDirectory(directory)
    .pipe(mapIo("Failed to inspect run snapshot layout"));
  const marked = entries.includes("snapshot-layout.json");
  let relative = "definition.json";
  if (marked) {
    yield* ensureRunAsset(storage, run, "snapshot-layout.json");
    const marker = yield* readDirectFileString(
      storage,
      storage.path.join(directory, "snapshot-layout.json"),
      "run snapshot layout",
    );
    yield* decodeSnapshotLayout(marker).pipe(
      Effect.mapError(
        () =>
          new Schedule.ScheduleError({
            kind: "corrupt",
            message: "Invalid run snapshot layout",
          }),
      ),
    );
  } else {
    let legacyExists = false;
    if (entries.includes("input")) {
      const input = storage.path.join(directory, "input");
      yield* ensureDirectPath(storage, input, "run input directory");
      const inputEntries = yield* storage.fileSystem
        .readDirectory(input)
        .pipe(mapIo("Failed to inspect legacy run snapshot"));
      legacyExists = inputEntries.includes("definition.json");
    }
    if (entries.includes("definition.json") && legacyExists) {
      return yield* new Schedule.ScheduleError({
        kind: "corrupt",
        message: "Run has both canonical and legacy definition snapshots",
      });
    }
    if (legacyExists) relative = "input/definition.json";
  }
  yield* ensureRunAsset(storage, run, relative);
  const file = storage.path.join(directory, relative);
  const source = yield* readDirectFileString(storage, file, "run definition snapshot");
  const definition = yield* decodeDefinition(source).pipe(
    Effect.mapError(
      () =>
        new Schedule.ScheduleError({
          kind: "corrupt",
          message: "Invalid run definition snapshot",
        }),
    ),
  );
  if (definition.revision !== run.definitionRevision) {
    return yield* new Schedule.ScheduleError({
      kind: "corrupt",
      message: "Run definition snapshot revision does not match its lifecycle",
    });
  }
  if (!marked) {
    yield* Effect.gen(function* () {
      if (relative === "input/definition.json") {
        yield* storage.fileSystem
          .rename(file, storage.path.join(directory, "definition.json"))
          .pipe(mapIo("Failed to migrate run definition snapshot"));
      }
      yield* writeRunFile(
        storage,
        run,
        "snapshot-layout.json",
        new TextEncoder().encode(snapshotLayoutSource),
        yield* storage.temporaryId(),
      );
    }).pipe(Effect.uninterruptible);
  }
  return definition;
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
