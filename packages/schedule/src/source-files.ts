import type * as Schedule from "@pico/contract/schedule";
import * as Effect from "effect/Effect";
import {
  createDirectory,
  ensureDirectPath,
  inspectDirectory,
  invalid,
  io,
  mapIo,
  type Storage,
} from "./storage.ts";

export interface ExecutionInput {
  readonly hasScript: boolean;
  readonly prompt: string | null;
}

export const inspectSource = Effect.fn("Schedules.inspectSource")(function* (
  storage: Storage,
  directory: string,
  owned: boolean,
  destination?: string,
): Effect.fn.Return<ExecutionInput, Schedule.ScheduleError> {
  if (!storage.path.isAbsolute(directory)) {
    return yield* invalid("sourceDirectory must be an absolute path");
  }
  if (!(yield* inspectDirectory(storage, directory, "schedule source directory"))) {
    return yield* invalid("sourceDirectory must name an existing directory");
  }
  const resolvedDestination =
    destination === undefined
      ? undefined
      : yield* storage.fileSystem
          .realPath(destination)
          .pipe(mapIo("Failed to resolve schedule source destination"));
  let hasScript = false;
  let hasPrompt = false;
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
      const resolvedAsset = yield* ensureDirectPath(
        storage,
        asset,
        `Source asset ${relative}`,
      ).pipe(
        Effect.mapError((error) =>
          error.kind === "corrupt"
            ? invalid(`Cannot read source asset ${relative}; symbolic links are not supported`)
            : error,
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
        if (resolvedAsset === resolvedDestination) continue;
        if (destination !== undefined) {
          yield* createDirectory(
            storage,
            storage.path.join(destination, relative),
            "schedule source directory",
          );
        }
        pending.push(relative);
      } else if (info.type === "File") {
        if (destination !== undefined) {
          const copied = storage.path.join(destination, relative);
          yield* ensureDirectPath(
            storage,
            storage.path.dirname(copied),
            "schedule source directory",
          );
          const exists = yield* storage.fileSystem
            .exists(copied)
            .pipe(mapIo(`Failed to inspect source asset destination ${relative}`));
          if (exists) return yield* io(`Source asset destination already exists: ${relative}`);
          yield* storage.fileSystem.copyFile(asset, copied).pipe(
            mapIo(`Failed to copy source asset ${relative}`),
            // Interrupting the callback cannot cancel the native copy racing staging cleanup.
            Effect.uninterruptible,
          );
          yield* storage.fileSystem
            .chmod(copied, 0o600)
            .pipe(mapIo(`Failed to set source asset permissions ${relative}`));
        }
        if (relative === "script.js") hasScript = true;
        if (relative === "prompt.md") hasPrompt = true;
      } else {
        return yield* invalid(
          `Source asset ${relative} must be a regular file or directory; links and special files are not supported`,
        );
      }
    }
  }
  if (!hasScript && !hasPrompt) {
    return yield* invalid("sourceDirectory requires script.js and/or prompt.md at its root");
  }
  const captured = destination ?? directory;
  if (hasScript) yield* readEntrypoint(storage, captured, "script.js");
  const prompt = hasPrompt ? yield* readEntrypoint(storage, captured, "prompt.md") : null;
  return { hasScript, prompt };
});

const readEntrypoint = Effect.fn("Schedules.readEntrypoint")(function* (
  storage: Storage,
  directory: string,
  name: "script.js" | "prompt.md",
) {
  const content = yield* storage.fileSystem
    .readFile(storage.path.join(directory, name))
    .pipe(mapIo(`Failed to read source asset ${name}`));
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(content),
    catch: () => invalid(`${name} must contain valid UTF-8 text`),
  });
  if (text.trim() === "") {
    return yield* invalid(`${name} must be a nonblank regular file`);
  }
  return text;
});
