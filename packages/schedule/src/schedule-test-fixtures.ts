import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as Agent from "@pico/contract/agent-message";
import * as Chat from "@pico/contract/chat-model";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

export const platformLayer = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);

export const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");

export const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");

export const caller: Schedule.ScheduleCaller = { workspaceId, chatId };

export const resolveTarget: Schedule.ScheduleRunHost["resolveTarget"] = (target) =>
  target.kind === "chat" || target.kind === "workspace"
    ? Effect.succeed(target)
    : Effect.fail(new Schedule.ScheduleHostError({ message: "Unexpected external test target" }));

export const textPrompt = (text: string) => Agent.AgentPrompt.make({ text, attachments: [] });

export const decodeRun = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schedule.ScheduleRunLifecycle),
);

export const decodeDefinition = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schedule.ScheduleDefinition),
);

export const decodeScriptResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ timeoutMillis: Schema.Int })),
);

export const prepareSource = Effect.fn("Schedules.test.prepareSource")(function* (
  files: Readonly<Record<string, string | Uint8Array>>,
  directories: ReadonlyArray<string> = [],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-source-" });
  for (const name of directories) {
    yield* fileSystem.makeDirectory(path.join(directory, name), { recursive: true });
  }
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(directory, name);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFile(
      file,
      typeof contents === "string" ? new TextEncoder().encode(contents) : contents,
    );
  }
  return AbsolutePath.make(directory);
});

export const awaitFinished = Effect.fn("Schedules.test.awaitFinished")(function* (
  fileSystem: FileSystem.FileSystem,
  runFile: string,
  attempts = 1_000,
): Effect.fn.Return<Schedule.ScheduleRunLifecycle> {
  if (attempts === 0) return yield* Effect.die("Schedule run did not finish");
  if (yield* fileSystem.exists(runFile).pipe(Effect.orDie)) {
    const source = yield* fileSystem.readFileString(runFile).pipe(Effect.orDie);
    const run = yield* decodeRun(source).pipe(Effect.orDie);
    if (run.state.kind === "finished") return run;
  }
  yield* Effect.yieldNow;
  return yield* awaitFinished(fileSystem, runFile, attempts - 1);
});

export const awaitExists = Effect.fn("Schedules.test.awaitExists")(function* (
  fileSystem: FileSystem.FileSystem,
  path: string,
  attempts = 1_000,
): Effect.fn.Return<void> {
  if (attempts === 0) return yield* Effect.die(`Path did not appear: ${path}`);
  if (yield* fileSystem.exists(path).pipe(Effect.orDie)) return;
  yield* Effect.yieldNow;
  return yield* awaitExists(fileSystem, path, attempts - 1);
});

export const permissionDenied = (method: string, path: string) =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
    }),
  );

export interface ScheduleLog {
  readonly level: Logger.Options<unknown>["logLevel"];
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly message: unknown;
}

export const captureLogs = Effect.fn("Schedules.test.captureLogs")(function* () {
  const events = yield* Queue.unbounded<ScheduleLog>();
  const entries: Array<ScheduleLog> = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      const entry: ScheduleLog = {
        level: options.logLevel,
        annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
        message: options.message,
      };
      entries.push(entry);
      Queue.offerUnsafe(events, entry);
    }),
  ]);
  return { events, entries, layer };
});
