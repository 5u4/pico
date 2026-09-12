import { LoggingError } from "@pico/contract/errors";
import type { AbsolutePath } from "@pico/contract/path";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

interface DailyLogEntry {
  readonly day: string;
  readonly retainedFrom: string;
  readonly line: string;
}

const dailyLogName = /^pico-\d{4}-\d{2}-\d{2}\.log$/;

const loggingError = (error: PlatformError.PlatformError) =>
  new LoggingError({ message: `Log filesystem operation failed (${error.reason._tag})` });

const isNotSymlink = (error: PlatformError.PlatformError) => {
  const cause = "cause" in error.reason ? error.reason.cause : undefined;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
};

const prune = Effect.fn("Logging.prune")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  logsDir: AbsolutePath,
  retainedFrom: string,
) {
  const names = yield* fileSystem.readDirectory(logsDir);

  for (const name of names) {
    if (!dailyLogName.test(name)) {
      continue;
    }

    const candidateDay = name.slice(5, -4);
    const candidateDate = DateTime.make(`${candidateDay}T00:00:00.000Z`);
    if (
      Option.isNone(candidateDate) ||
      DateTime.formatIsoDateUtc(candidateDate.value) !== candidateDay ||
      candidateDay >= retainedFrom
    ) {
      continue;
    }

    const candidate = path.join(logsDir, name);
    const isSymlink = yield* fileSystem.readLink(candidate).pipe(
      Effect.as(true),
      Effect.catch((error) => (isNotSymlink(error) ? Effect.succeed(false) : Effect.fail(error))),
    );
    if (isSymlink) {
      continue;
    }

    if ((yield* fileSystem.stat(candidate)).type === "File") {
      yield* fileSystem.remove(candidate);
    }
  }
});

const consoleLoggers = new Set([Logger.consolePretty()]);

const reportSinkFailure = (
  error: PlatformError.PlatformError,
  operation: "append" | "prune",
  day: string,
) =>
  Effect.logError("pico.logging.failed", Cause.fail(loggingError(error))).pipe(
    Effect.annotateLogs({ component: "logging", operation, day }),
    Effect.provideService(Logger.CurrentLoggers, consoleLoggers),
    Effect.provideService(Logger.LogToStderr, true),
  );

export const make = Effect.fn("Logging.make")(function* (logsDir: AbsolutePath) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fileSystem
    .makeDirectory(logsDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(loggingError));

  const now = yield* DateTime.now;
  let lastPrunedDay = DateTime.formatIsoDateUtc(now);
  yield* prune(
    fileSystem,
    path,
    logsDir,
    DateTime.formatIsoDateUtc(DateTime.subtract(now, { days: 29 })),
  ).pipe(Effect.mapError(loggingError));

  const dailyLogger = Logger.make<unknown, DailyLogEntry>((options) => {
    const date = DateTime.makeUnsafe(options.date);
    return {
      day: DateTime.formatIsoDateUtc(date),
      retainedFrom: DateTime.formatIsoDateUtc(DateTime.subtract(date, { days: 29 })),
      line: Logger.formatJson.log(options),
    };
  });

  const flush = Effect.fn("Logging.flush")(function* (entries: Array<DailyLogEntry>) {
    const byDay = new Map<string, Array<string>>();
    let latest: DailyLogEntry | undefined;

    for (const entry of entries) {
      const lines = byDay.get(entry.day);
      if (lines === undefined) {
        byDay.set(entry.day, [entry.line]);
      } else {
        lines.push(entry.line);
      }
      if (latest === undefined || entry.day > latest.day) {
        latest = entry;
      }
    }

    yield* Effect.forEach(
      byDay,
      ([day, lines]) =>
        fileSystem
          .writeFileString(path.join(logsDir, `pico-${day}.log`), `${lines.join("\n")}\n`, {
            flag: "a",
            mode: 0o600,
          })
          .pipe(Effect.catch((error) => reportSinkFailure(error, "append", day))),
      { discard: true },
    );

    if (latest === undefined || latest.day <= lastPrunedDay) {
      return;
    }

    yield* prune(fileSystem, path, logsDir, latest.retainedFrom).pipe(
      Effect.tap(
        Effect.sync(() => {
          lastPrunedDay = latest.day;
        }),
      ),
      Effect.catch((error) => reportSinkFailure(error, "prune", latest.day)),
    );
  });

  return yield* Logger.batched(dailyLogger, { window: "1 second", flush });
});
