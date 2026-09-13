import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as Chat from "@pico/contract/chat-model";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { bootstrap } from "./definition-storage.ts";
import { publishRun, runDirectory } from "./run-storage.ts";
import { runScript, ScriptRunError } from "./script.ts";
import type { Storage } from "./storage.ts";

const platformLayer = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);
const scheduleId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000001");
const runId = Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000004");
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000003");
const decodeResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      timeoutMillis: Schema.Int,
      timedOut: Schema.Boolean,
      stdout: Schema.Struct({ totalBytes: Schema.Natural, truncated: Schema.Boolean }),
    }),
  ),
);
const decodeFailedDecision = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String })),
);

const prepareSource = Effect.fn("Schedules.test.prepareSource")(function* (
  files: Readonly<Record<string, string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-script-source-" });
  for (const [name, contents] of Object.entries(files)) {
    yield* fileSystem.writeFileString(path.join(directory, name), contents);
  }
  return directory;
});

const awaitExists = Effect.fn("Schedules.test.awaitExists")(function* (
  fileSystem: FileSystem.FileSystem,
  path: string,
  attempts = 500,
): Effect.fn.Return<void> {
  if (yield* fileSystem.exists(path).pipe(Effect.orDie)) return;
  if (attempts === 0) return yield* Effect.die(`Path did not appear: ${path}`);
  yield* Effect.promise(() => Bun.sleep(10));
  return yield* awaitExists(fileSystem, path, attempts - 1);
});

describe("schedule script runner", () => {
  it.effect("records decisions for script failures and stops interrupted children", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-script-runner-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () =>
          crypto.randomUUIDv7.pipe(
            Effect.mapError(
              (error) => new Schedule.ScheduleError({ kind: "io", message: error.message }),
            ),
          ),
      };
      yield* bootstrap(storage);
      const definition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000004"),
        name: "invalid protocol",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const run: Schedule.ScheduleRunLifecycle = {
        version: 1,
        id: runId,
        scheduleId,
        definitionRevision: definition.revision,
        source: { kind: "scheduled", scheduledFor: 1_000 },
        plannedTarget: { kind: "existing-chat", ownerWorkspaceId: workspaceId, chatId },
        claimedAt: 1_000,
        state: { kind: "claimed" },
      };
      yield* publishRun(
        storage,
        run,
        definition,
        yield* prepareSource({
          "script.js": 'process.stdout.write(JSON.stringify({agent:false})+" trailing")',
        }),
        "018f47a0-0000-7000-8000-000000000010",
        Effect.void,
      );
      const target: Schedule.ResolvedScheduleRunTarget = { chatId, workspaceId, cwd };
      const readFailedDecision = (id: Schedule.ScheduleRunId) =>
        fileSystem
          .readFileString(path.join(runDirectory(storage, scheduleId, id), "decision.json"))
          .pipe(Effect.map(decodeFailedDecision));
      const error = yield* runScript(storage, process.execPath, run, target).pipe(Effect.flip);
      assert.instanceOf(error, ScriptRunError);
      if (!(error instanceof ScriptRunError)) return;
      assert.strictEqual(error.stage, "protocol");
      const directory = runDirectory(storage, scheduleId, runId);
      assert.isTrue(yield* fileSystem.exists(path.join(directory, "script", "stdout.bin")));
      const result = decodeResult(
        yield* fileSystem.readFileString(path.join(directory, "script", "result.json")),
      );
      assert.isAbove(result.stdout.totalBytes, 0);
      assert.isFalse(result.stdout.truncated);
      assert.strictEqual(result.timeoutMillis, Schedule.DEFAULT_SCRIPT_TIMEOUT_MS);
      assert.strictEqual((yield* readFailedDecision(runId)).kind, "failed");

      const artifactFailureRun: Schedule.ScheduleRunLifecycle = {
        ...run,
        id: Schedule.ScheduleRunId.make("scheduled-1500-018f47a0-0000-7000-8000-000000000004"),
        source: { kind: "scheduled", scheduledFor: 1_500 },
      };
      yield* publishRun(
        storage,
        artifactFailureRun,
        definition,
        yield* prepareSource({ "script.js": 'process.stdout.write("private invalid decision")' }),
        "018f47a0-0000-7000-8000-000000000025",
        Effect.void,
      );
      const failureLogs: Array<{
        readonly level: Logger.Options<unknown>["logLevel"];
        readonly annotations: Readonly<Record<string, unknown>>;
        readonly message: unknown;
      }> = [];
      const primaryError = yield* runScript(
        {
          ...storage,
          fileSystem: FileSystem.FileSystem.of({
            ...fileSystem,
            writeFile: (file, data, options) =>
              path.basename(file).startsWith(".decision.json-")
                ? Effect.fail(
                    new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "writeFile",
                        pathOrDescriptor: file,
                      }),
                    ),
                  )
                : fileSystem.writeFile(file, data, options),
          }),
        },
        process.execPath,
        artifactFailureRun,
        target,
      ).pipe(
        Effect.flip,
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              failureLogs.push({
                level: options.logLevel,
                annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
                message: options.message,
              });
            }),
          ]),
        ),
      );
      assert.instanceOf(primaryError, ScriptRunError);
      if (!(primaryError instanceof ScriptRunError)) return;
      assert.strictEqual(primaryError.stage, "protocol");
      assert.strictEqual(failureLogs.length, 1);
      assert.strictEqual(failureLogs[0]?.level, "Error");
      assert.strictEqual(failureLogs[0]?.annotations.phase, "failure-artifact");
      assert.strictEqual(failureLogs[0]?.annotations.runId, artifactFailureRun.id);
      assert.notInclude(JSON.stringify(failureLogs), "private");
      assert.notInclude(primaryError.message, "private");

      const failedRun: Schedule.ScheduleRunLifecycle = {
        ...run,
        id: Schedule.ScheduleRunId.make("scheduled-2000-018f47a0-0000-7000-8000-000000000004"),
        source: { kind: "scheduled", scheduledFor: 2_000 },
      };
      yield* publishRun(
        storage,
        failedRun,
        definition,
        yield* prepareSource({ "script.js": "process.exit(2)" }),
        "018f47a0-0000-7000-8000-000000000012",
        Effect.void,
      );
      const executionError = yield* runScript(storage, process.execPath, failedRun, target).pipe(
        Effect.flip,
      );
      assert.instanceOf(executionError, ScriptRunError);
      if (!(executionError instanceof ScriptRunError)) return;
      assert.strictEqual(executionError.stage, "script");
      assert.strictEqual((yield* readFailedDecision(failedRun.id)).kind, "failed");

      const signalRun: Schedule.ScheduleRunLifecycle = {
        ...run,
        id: Schedule.ScheduleRunId.make("scheduled-3000-018f47a0-0000-7000-8000-000000000004"),
        source: { kind: "scheduled", scheduledFor: 3_000 },
      };
      yield* publishRun(
        storage,
        signalRun,
        definition,
        yield* prepareSource({ "script.js": 'process.kill(process.pid,"SIGTERM")' }),
        "018f47a0-0000-7000-8000-000000000014",
        Effect.void,
      );
      const signalError = yield* runScript(storage, process.execPath, signalRun, target).pipe(
        Effect.flip,
      );
      assert.instanceOf(signalError, ScriptRunError);
      if (!(signalError instanceof ScriptRunError)) return;
      assert.notInclude(signalError.message, "timed out");
      assert.strictEqual((yield* readFailedDecision(signalRun.id)).kind, "failed");

      const timeoutRun: Schedule.ScheduleRunLifecycle = {
        ...run,
        id: Schedule.ScheduleRunId.make("scheduled-4000-018f47a0-0000-7000-8000-000000000004"),
        source: { kind: "scheduled", scheduledFor: 4_000 },
      };
      yield* publishRun(
        storage,
        timeoutRun,
        definition,
        yield* prepareSource({
          "script.js": 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
        }),
        "018f47a0-0000-7000-8000-000000000016",
        Effect.void,
      );
      const timeoutError = yield* runScript(storage, process.execPath, timeoutRun, target, 10).pipe(
        Effect.flip,
      );
      assert.instanceOf(timeoutError, ScriptRunError);
      if (!(timeoutError instanceof ScriptRunError)) return;
      assert.strictEqual(timeoutError.stage, "script");
      assert.include(timeoutError.message, "timed out after 10 milliseconds");
      assert.strictEqual((yield* readFailedDecision(timeoutRun.id)).kind, "failed");
      const inheritedPipeRun: Schedule.ScheduleRunLifecycle = {
        ...run,
        id: Schedule.ScheduleRunId.make("scheduled-4500-018f47a0-0000-7000-8000-000000000004"),
        source: { kind: "scheduled", scheduledFor: 4_500 },
      };
      yield* publishRun(
        storage,
        inheritedPipeRun,
        definition,
        yield* prepareSource({
          "script.js": `
              const descendant = Bun.spawn({
        cmd: [process.execPath, "-e", "await Bun.sleep(2000)"],
        stdout: "inherit",
        stderr: "inherit",
              });
              descendant.unref();
              process.stdout.write(JSON.stringify({ agent: false }));
              `,
        }),
        "018f47a0-0000-7000-8000-000000000017",
        Effect.void,
      );
      const inheritedPipe = yield* runScript(
        storage,
        process.execPath,
        inheritedPipeRun,
        target,
        60_000,
      ).pipe(Effect.timeout("750 millis"));
      assert.deepStrictEqual(inheritedPipe.decision, { agent: false });
      const inheritedPipeResult = decodeResult(
        yield* fileSystem.readFileString(
          path.join(
            runDirectory(storage, scheduleId, inheritedPipeRun.id),
            "script",
            "result.json",
          ),
        ),
      );
      assert.strictEqual(inheritedPipeResult.timeoutMillis, 60_000);
      assert.isFalse(inheritedPipeResult.timedOut);

      const incompletePipeRun: Schedule.ScheduleRunLifecycle = {
        ...run,
        id: Schedule.ScheduleRunId.make("scheduled-4750-018f47a0-0000-7000-8000-000000000004"),
        source: { kind: "scheduled", scheduledFor: 4_750 },
      };
      yield* publishRun(
        storage,
        incompletePipeRun,
        definition,
        yield* prepareSource({
          "script.js": `
              const descendant = Bun.spawn({
        cmd: [process.execPath, "-e", "await Bun.sleep(2000)"],
        stdout: "inherit",
        stderr: "inherit",
              });
              descendant.unref();
              process.stdout.write("{");
              `,
        }),
        "018f47a0-0000-7000-8000-0000000000175",
        Effect.void,
      );
      const incompletePipeError = yield* runScript(
        storage,
        process.execPath,
        incompletePipeRun,
        target,
        60_000,
      ).pipe(Effect.timeout("750 millis"), Effect.flip);
      assert.instanceOf(incompletePipeError, ScriptRunError);
      if (!(incompletePipeError instanceof ScriptRunError)) return;
      assert.strictEqual(incompletePipeError.stage, "protocol");
      const incompletePipeResult = decodeResult(
        yield* fileSystem.readFileString(
          path.join(
            runDirectory(storage, scheduleId, incompletePipeRun.id),
            "script",
            "result.json",
          ),
        ),
      );
      assert.isFalse(incompletePipeResult.timedOut);

      const spawnRun: Schedule.ScheduleRunLifecycle = {
        ...run,
        id: Schedule.ScheduleRunId.make("scheduled-5000-018f47a0-0000-7000-8000-000000000004"),
        source: { kind: "scheduled", scheduledFor: 5_000 },
      };
      yield* publishRun(
        storage,
        spawnRun,
        definition,
        yield* prepareSource({ "script.js": "process.exit(0)" }),
        "018f47a0-0000-7000-8000-000000000018",
        Effect.void,
      );
      const spawnError = yield* runScript(
        storage,
        path.join(root, "private-missing-executable"),
        spawnRun,
        target,
      ).pipe(Effect.flip);
      assert.instanceOf(spawnError, ScriptRunError);
      if (!(spawnError instanceof ScriptRunError)) return;
      const spawnDecision = yield* readFailedDecision(spawnRun.id);
      assert.strictEqual(spawnDecision.kind, "failed");
      const spawnResult = yield* fileSystem.readFileString(
        path.join(runDirectory(storage, scheduleId, spawnRun.id), "script", "result.json"),
      );
      for (const diagnostic of [spawnError.message, spawnDecision.message, spawnResult]) {
        assert.include(diagnostic, "ENOENT");
        assert.notInclude(diagnostic, root);
        assert.notInclude(diagnostic, "private-missing-executable");
      }

      const oversizedRun: Schedule.ScheduleRunLifecycle = {
        ...run,
        id: Schedule.ScheduleRunId.make("scheduled-6000-018f47a0-0000-7000-8000-000000000004"),
        source: { kind: "scheduled", scheduledFor: 6_000 },
      };
      yield* publishRun(
        storage,
        oversizedRun,
        definition,
        yield* prepareSource({ "script.js": 'process.stdout.write("x".repeat(256*1024+1))' }),
        "018f47a0-0000-7000-8000-000000000020",
        Effect.void,
      );
      const oversizedError = yield* runScript(storage, process.execPath, oversizedRun, target).pipe(
        Effect.flip,
      );
      assert.instanceOf(oversizedError, ScriptRunError);
      assert.strictEqual((yield* readFailedDecision(oversizedRun.id)).kind, "failed");

      const invalidVariantRun: Schedule.ScheduleRunLifecycle = {
        ...run,
        id: Schedule.ScheduleRunId.make("scheduled-7000-018f47a0-0000-7000-8000-000000000004"),
        source: { kind: "scheduled", scheduledFor: 7_000 },
      };
      yield* publishRun(
        storage,
        invalidVariantRun,
        definition,
        yield* prepareSource({
          "script.js": 'process.stdout.write(JSON.stringify({agent:false,kind:"unknown"}))',
        }),
        "018f47a0-0000-7000-8000-000000000022",
        Effect.void,
      );
      const invalidVariantError = yield* runScript(
        storage,
        process.execPath,
        invalidVariantRun,
        target,
      ).pipe(Effect.flip);
      assert.instanceOf(invalidVariantError, ScriptRunError);
      assert.strictEqual((yield* readFailedDecision(invalidVariantRun.id)).kind, "failed");

      const emptyOutputRun: Schedule.ScheduleRunLifecycle = {
        ...run,
        id: Schedule.ScheduleRunId.make("scheduled-7500-018f47a0-0000-7000-8000-000000000004"),
        source: { kind: "scheduled", scheduledFor: 7_500 },
      };
      yield* publishRun(
        storage,
        emptyOutputRun,
        definition,
        yield* prepareSource({ "script.js": "void 0;" }),
        "018f47a0-0000-7000-8000-000000000023",
        Effect.void,
      );
      const emptyOutputError = yield* runScript(
        storage,
        process.execPath,
        emptyOutputRun,
        target,
      ).pipe(Effect.flip);
      assert.instanceOf(emptyOutputError, ScriptRunError);
      if (!(emptyOutputError instanceof ScriptRunError)) return;
      assert.strictEqual(emptyOutputError.stage, "protocol");
      assert.strictEqual((yield* readFailedDecision(emptyOutputRun.id)).kind, "failed");
      const interruptedRun: Schedule.ScheduleRunLifecycle = {
        ...run,
        id: Schedule.ScheduleRunId.make("scheduled-8000-018f47a0-0000-7000-8000-000000000004"),
        source: { kind: "scheduled", scheduledFor: 8_000 },
      };
      const childReady = path.join(root, "child-ready");
      const childStopped = path.join(root, "child-stopped");
      yield* publishRun(
        storage,
        interruptedRun,
        definition,
        yield* prepareSource({
          "script.js": `
              const descendant = Bun.spawn({
        cmd: [process.execPath, "-e", "await Bun.sleep(2000)"],
        stdout: "inherit",
        stderr: "inherit",
              });
              descendant.unref();
              process.on("SIGTERM", async () => {
        await Bun.write(${JSON.stringify(childStopped)}, "stopped");
        process.exit(0);
              });
              await Bun.write(${JSON.stringify(childReady)}, "ready");
              setInterval(() => {}, 1000);
              `,
        }),
        "018f47a0-0000-7000-8000-000000000024",
        Effect.void,
      );
      const interrupted = yield* runScript(storage, process.execPath, interruptedRun, target).pipe(
        Effect.forkChild,
      );
      yield* awaitExists(fileSystem, childReady);
      yield* Fiber.interrupt(interrupted).pipe(Effect.timeout("750 millis"));
      yield* awaitExists(fileSystem, childStopped);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
