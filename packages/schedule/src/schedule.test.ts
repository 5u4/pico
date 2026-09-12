import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import * as Agent from "@pico/contract/agent-message";
import type { CapturedAgentRun } from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { make, open } from "./schedule.ts";
import {
  appendArtifactString,
  bootstrap,
  loadSchedule,
  moveDefinition,
  publishDefinition,
  publishRun,
  readRuns,
  runDirectory,
  type Storage,
  updateDefinition,
  writeArtifactString,
} from "./storage.ts";

const platformLayer = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);
const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const otherWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000099");
const caller: Schedule.ScheduleCaller = { workspaceId, chatId };
const textPrompt = (text: string) => Agent.AgentPrompt.make({ text, attachments: [] });
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(Schedule.ScheduleRunLifecycle));
const decodeDefinition = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schedule.ScheduleDefinition),
);
const decodeScriptResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ timeoutMillis: Schema.Int })),
);

const prepareSource = Effect.fn("Schedules.test.prepareSource")(function* (
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

const awaitFinished = Effect.fn("Schedules.test.awaitFinished")(function* (
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

const awaitExists = Effect.fn("Schedules.test.awaitExists")(function* (
  fileSystem: FileSystem.FileSystem,
  path: string,
  attempts = 1_000,
): Effect.fn.Return<void> {
  if (attempts === 0) return yield* Effect.die(`Path did not appear: ${path}`);
  if (yield* fileSystem.exists(path).pipe(Effect.orDie)) return;
  yield* Effect.yieldNow;
  return yield* awaitExists(fileSystem, path, attempts - 1);
});
const permissionDenied = (method: string, path: string) =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
    }),
  );

interface ScheduleLog {
  readonly level: Logger.Options<unknown>["logLevel"];
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly message: unknown;
}

const captureLogs = Effect.fn("Schedules.test.captureLogs")(function* () {
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

const awaitLog = Effect.fn("Schedules.test.awaitLog")(function* (
  events: Queue.Queue<ScheduleLog>,
  phase: string,
) {
  for (;;) {
    const entry = yield* Queue.take(events);
    if (entry.annotations.phase === phase) return entry;
  }
});

describe("Schedules", () => {
  it.effect("opens usable schedule storage before the runner starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedules-open-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir);

        assert.deepStrictEqual(yield* schedules.list(caller), []);
        const created = yield* schedules.create(caller, {
          name: "ready before start",
          enabled: false,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "ship it" }),
        });
        assert.strictEqual(created.kind, "ready");
        assert.deepStrictEqual(yield* schedules.list(caller), [created]);
      }).pipe(Effect.provide(platformLayer)),
    ),
  );

  it.effect("initializes direct construction when the runner starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedules-start-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* make(schedulesDir);
        const cwd = AbsolutePath.make(root);
        yield* schedules.start({
          prepare: () => Effect.succeed({ chatId, workspaceId, cwd }),
          deliver: () => Effect.void,
          publish: () => Effect.void,
          runPrompt: () => Effect.die("unexpected scheduled prompt"),
        });

        assert.deepStrictEqual(yield* schedules.list(caller), []);
      }).pipe(Effect.provide(platformLayer)),
    ),
  );

  it.effect(
    "runs same-slot revisions independently, records artifacts, disables them, and retains history",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedules-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const cwd = AbsolutePath.make(path.join(root, "workspace"));
        yield* fileSystem.makeDirectory(cwd);
        const published = yield* Queue.unbounded<string>();
        const schedules = yield* make(schedulesDir);
        const host: Schedule.ScheduleRunHost = {
          prepare: (target) =>
            Effect.succeed({
              chatId: target.chatId,
              workspaceId: target.ownerWorkspaceId,
              cwd,
            }),
          deliver: () => Effect.die("script-only schedules must not deliver agent output"),
          publish: (_targetChatId, content) => Queue.offer(published, content).pipe(Effect.asVoid),
          runPrompt: () => Effect.die("script-only schedules must not invoke OMP"),
        };

        yield* TestClock.setTime(1_000);
        yield* schedules.start(host);
        const created = yield* schedules.create(caller, {
          name: "one shot",
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({
            "script.js":
              'let input="";for await(const chunk of Bun.stdin.stream())input+=new TextDecoder().decode(chunk);JSON.parse(input);process.stdout.write(JSON.stringify({agent:false,content:"done"}));',
          }),
          scriptTimeoutMs: 12_345,
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        assert.strictEqual(created.definition.scriptTimeoutMs, 12_345);
        const persistedDefinition = yield* decodeDefinition(
          yield* fileSystem.readFileString(
            path.join(schedulesDir, "enabled", created.id, "meta.json"),
          ),
        );
        assert.strictEqual(persistedDefinition.scriptTimeoutMs, 12_345);

        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(yield* Queue.take(published), "done");
        const runId = Schedule.ScheduleRunId.make(`scheduled-1000-${created.definition.revision}`);
        const runDirectory = path.join(schedulesDir, "runs", created.id, runId);
        const run = yield* awaitFinished(fileSystem, path.join(runDirectory, "run.json"));
        assert.deepStrictEqual(run.state.kind === "finished" && run.state.outcome, {
          kind: "published",
          content: "done",
        });
        assert.isTrue(
          yield* fileSystem.exists(path.join(runDirectory, "input", "definition.json")),
        );
        assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, "input", "script.js")));
        for (const artifact of [
          "script/stdin.json",
          "script/stdout.bin",
          "script/stderr.bin",
          "script/result.json",
          "decision.json",
        ]) {
          assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, artifact)), artifact);
        }
        const scriptResult = yield* decodeScriptResult(
          yield* fileSystem.readFileString(path.join(runDirectory, "script", "result.json")),
        );
        assert.strictEqual(scriptResult.timeoutMillis, 12_345);
        const disabledMetadata = path.join(schedulesDir, "disabled", created.id, "meta.json");
        yield* awaitExists(fileSystem, disabledMetadata);
        const disabled = yield* schedules.get(caller, created.id);
        if (disabled.kind !== "ready") return yield* Effect.die("Completed schedule disappeared");
        yield* fileSystem.writeFileString(
          path.join(disabled.sourceDirectory, "script.js"),
          'process.stdout.write(JSON.stringify({agent:false,content:"done again"}));',
        );
        const replaced = yield* schedules.update(caller, created.id, {
          name: "one shot updated",
        });
        assert.strictEqual(replaced.kind, "ready");
        if (replaced.kind !== "ready") return;
        assert.notStrictEqual(replaced.definition.revision, created.definition.revision);
        yield* schedules.update(caller, created.id, { enabled: true });
        assert.strictEqual(yield* Queue.take(published), "done again");
        const replacementRunId = Schedule.ScheduleRunId.make(
          `scheduled-1000-${replaced.definition.revision}`,
        );
        const replacementRunDirectory = path.join(
          schedulesDir,
          "runs",
          created.id,
          replacementRunId,
        );
        yield* awaitFinished(fileSystem, path.join(replacementRunDirectory, "run.json"));
        assert.deepStrictEqual(
          (yield* fileSystem.readDirectory(path.join(schedulesDir, "runs", created.id))).sort(),
          [runId, replacementRunId].sort(),
        );

        yield* schedules.remove(caller, created.id);
        assert.isFalse(yield* fileSystem.exists(path.join(schedulesDir, "disabled", created.id)));
        assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, "run.json")));
        assert.isTrue(yield* fileSystem.exists(path.join(replacementRunDirectory, "run.json")));
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "copies prepared sources and preserves source bytes and omitted metadata across updates",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-schedule-storage-",
        });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir);
        const script = 'import { content } from "./lib/helper.js";process.stdout.write(content);';
        const helper = 'export const content = "original";';
        const asset = new Uint8Array([0, 255, 128, 10]);
        const nestedMetadata = {
          "lib/meta.json": '{"helper":1}',
          "lib/definition.json": '{"helper":2}',
          "assets/Meta.json": '{"helper":3}',
          "assets/Definition.json": '{"helper":4}',
        };
        const sourceDirectory = yield* prepareSource(
          {
            "script.js": script,
            "prompt.md": "Run the update.",
            "lib/helper.js": helper,
            "assets/data.bin": asset,
            ...nestedMetadata,
          },
          ["cache/empty"],
        );
        const created = yield* schedules.create(caller, {
          name: "editable",
          enabled: false,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 10_000 },
          sourceDirectory,
          scriptTimeoutMs: 5_000,
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        const directory = AbsolutePath.make(path.join(schedulesDir, "disabled", created.id));
        assert.strictEqual(created.sourceDirectory, directory);
        assert.notStrictEqual(created.sourceDirectory, sourceDirectory);
        yield* fileSystem.writeFileString(path.join(sourceDirectory, "script.js"), "changed input");
        yield* fileSystem.remove(path.join(sourceDirectory, "lib"), { recursive: true });

        const updated = yield* schedules.update(caller, created.id, { name: "updated" });
        assert.strictEqual(updated.kind, "ready");
        if (updated.kind !== "ready") return;
        assert.deepStrictEqual(updated.definition, {
          ...created.definition,
          name: "updated",
          revision: updated.definition.revision,
        });
        assert.notStrictEqual(updated.definition.revision, created.definition.revision);
        assert.strictEqual(updated.sourceDirectory, directory);
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "script.js")),
          script,
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "lib/helper.js")),
          helper,
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "prompt.md")),
          "Run the update.",
        );
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(directory, "assets/data.bin")),
          asset,
        );
        assert.deepStrictEqual(
          yield* fileSystem.readDirectory(path.join(directory, "cache/empty")),
          [],
        );
        for (const [name, contents] of Object.entries(nestedMetadata)) {
          assert.strictEqual(
            yield* fileSystem.readFileString(path.join(directory, name)),
            contents,
          );
        }

        const enabled = yield* schedules.update(caller, created.id, { enabled: true });
        assert.strictEqual(enabled.kind, "ready");
        if (enabled.kind !== "ready") return;
        assert.strictEqual(enabled.sourceDirectory, path.join(schedulesDir, "enabled", created.id));
        assert.strictEqual(enabled.definition.revision, updated.definition.revision);
        assert.isFalse(yield* fileSystem.exists(directory));
        assert.deepStrictEqual(yield* schedules.get(caller, created.id), enabled);
        assert.deepStrictEqual(yield* schedules.list(caller), [enabled]);

        yield* fileSystem.writeFileString(
          path.join(enabled.sourceDirectory, "prompt.md"),
          "Edited in place.",
        );
        const disabled = yield* schedules.update(caller, created.id, { enabled: false });
        assert.strictEqual(disabled.kind, "ready");
        if (disabled.kind !== "ready") return;
        assert.strictEqual(disabled.sourceDirectory, directory);
        assert.strictEqual(disabled.definition.revision, updated.definition.revision);
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(disabled.sourceDirectory, "prompt.md")),
          "Edited in place.",
        );
        assert.deepStrictEqual(yield* schedules.get(caller, created.id), disabled);
        assert.deepStrictEqual(yield* schedules.list(caller), [disabled]);
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("clears a timeout override and runs with the default after a partial update", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-timeout-reset-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir);
      const created = yield* schedules.create(caller, {
        name: "custom timeout",
        enabled: false,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": 'process.stdout.write(JSON.stringify({agent:false,content:"default"}));',
        }),
        scriptTimeoutMs: 5_000,
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const input = yield* Schema.decodeUnknownEffect(Schedule.UpdateSchedule)({
        scriptTimeoutMs: null,
      });
      const reset = yield* schedules.update(caller, created.id, input);
      if (reset.kind !== "ready") return yield* Effect.die("Reset schedule is invalid");
      assert.isFalse(Object.hasOwn(reset.definition, "scriptTimeoutMs"));
      assert.notStrictEqual(reset.definition.revision, created.definition.revision);
      const persisted = yield* decodeDefinition(
        yield* fileSystem.readFileString(path.join(reset.sourceDirectory, "meta.json")),
      );
      assert.isFalse(Object.hasOwn(persisted, "scriptTimeoutMs"));
      const renamed = yield* schedules.update(caller, created.id, { name: "default timeout" });
      if (renamed.kind !== "ready") return yield* Effect.die("Renamed schedule is invalid");
      assert.isFalse(Object.hasOwn(renamed.definition, "scriptTimeoutMs"));
      assert.deepStrictEqual(renamed.definition.trigger, created.definition.trigger);
      assert.deepStrictEqual(renamed.definition.target, created.definition.target);
      yield* schedules.update(caller, created.id, { enabled: true });
      yield* TestClock.setTime(1_000);
      const published = yield* Queue.unbounded<string>();
      yield* schedules.start({
        prepare: () => Effect.succeed({ chatId, workspaceId, cwd: AbsolutePath.make(root) }),
        deliver: () => Effect.die("Script must publish without OMP"),
        publish: (_chatId, content) => Queue.offer(published, content).pipe(Effect.asVoid),
        runPrompt: () => Effect.die("Script must not invoke OMP"),
      });
      assert.strictEqual(yield* Queue.take(published), "default");
      const runId = `scheduled-1000-${renamed.definition.revision}`;
      const directory = path.join(schedulesDir, "runs", created.id, runId);
      yield* awaitFinished(fileSystem, path.join(directory, "run.json"));
      const result = yield* decodeScriptResult(
        yield* fileSystem.readFileString(path.join(directory, "script", "result.json")),
      );
      assert.strictEqual(result.timeoutMillis, Schedule.DEFAULT_SCRIPT_TIMEOUT_MS);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "copies assets without whole-file reads and captures prompts before script writes",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-native-copy-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const guardedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          readFile: (file) =>
            file.endsWith("helper.js") || file.endsWith("data.bin")
              ? Effect.die("Assets must not be buffered by the scheduler")
              : fileSystem.readFile(file),
        });
        const schedules = yield* open(schedulesDir).pipe(
          Effect.provideService(FileSystem.FileSystem, guardedFileSystem),
        );
        const asset = new Uint8Array([0, 255, 128, 10]);
        const created = yield* schedules.create(caller, {
          name: "native copying",
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({
            "script.js": [
              'import { content } from "./lib/helper.js";',
              'import { readFileSync, writeFileSync } from "node:fs";',
              'const bytes = readFileSync(new URL("./assets/data.bin", import.meta.url));',
              'writeFileSync(new URL("./prompt.md", import.meta.url), "script changed prompt");',
              'process.stdout.write(JSON.stringify({agent:true,content:content+":"+[...bytes]}));',
            ].join("\n"),
            "prompt.md": "original prompt",
            "lib/helper.js": 'export const content = "helper";',
            "assets/data.bin": asset,
          }),
        });
        if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
        const requests = yield* Queue.unbounded<Agent.AgentPrompt>();
        yield* TestClock.setTime(1_000);
        yield* schedules.start({
          prepare: () => Effect.succeed({ chatId, workspaceId, cwd: AbsolutePath.make(root) }),
          deliver: () => Effect.void,
          publish: () => Effect.die("Expected an agent request"),
          runPrompt: (_chatId, runId, request) =>
            Queue.offer(requests, request).pipe(
              Effect.as({ runId, outcome: "completed", events: [], finalAssistantText: "done" }),
            ),
        });
        assert.deepStrictEqual(
          yield* Queue.take(requests),
          textPrompt("helper:0,255,128,10\n\noriginal prompt"),
        );
        const runId = `scheduled-1000-${created.definition.revision}`;
        const directory = path.join(schedulesDir, "runs", created.id, runId);
        const finished = yield* awaitFinished(fileSystem, path.join(directory, "run.json"));
        assert.strictEqual(
          finished.state.kind === "finished" && finished.state.outcome.kind,
          "completed",
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "input", "prompt.md")),
          "script changed prompt",
        );
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(directory, "input", "assets/data.bin")),
          asset,
        );
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("skips its staging directory through an ancestor path alias", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-alias-" });
      const parent = path.join(root, "parent");
      const alias = path.join(root, "alias");
      const sourceDirectory = AbsolutePath.make(path.join(parent, "source"));
      yield* fileSystem.makeDirectory(sourceDirectory, { recursive: true });
      yield* fileSystem.writeFileString(path.join(sourceDirectory, "prompt.md"), "aliased source");
      yield* fileSystem.symlink(parent, alias);
      const schedulesDir = AbsolutePath.make(path.join(alias, "source", "schedules"));
      const schedules = yield* open(schedulesDir);
      const created = yield* schedules.create(caller, {
        name: "source contains aliased storage",
        enabled: false,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory,
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(created.sourceDirectory, "prompt.md")),
        "aliased source",
      );
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(
          path.join(created.sourceDirectory, "schedules", ".staging"),
        ),
        [],
      );
      assert.deepStrictEqual(yield* schedules.list(caller), [created]);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects case-folded destination collisions without overwriting or merging", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const kinds: ReadonlyArray<"file" | "directory"> = ["file", "directory"];
      for (const first of kinds) {
        for (const second of kinds) {
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "pico-source-collision-",
          });
          const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
          const sourceDirectory = yield* prepareSource({
            "prompt.md": "colliding assets",
            [first === "file" ? "A.js" : "A.js/first"]: "first asset",
            [second === "file" ? "other.js" : "other.js/second"]: "second asset",
          });
          const canonicalSource = yield* fileSystem.realPath(sourceDirectory);
          const lowerSource = path.join(sourceDirectory, "a.js");
          const resolveFile = (file: string) => {
            if (file === lowerSource || file.startsWith(`${lowerSource}${path.sep}`)) {
              return path.join(sourceDirectory, "other.js") + file.slice(lowerSource.length);
            }
            if (file.startsWith(`${schedulesDir}${path.sep}`)) {
              return path.join(
                schedulesDir,
                ...path
                  .relative(schedulesDir, file)
                  .split(path.sep)
                  .map((name) => (name === "a.js" ? "A.js" : name)),
              );
            }
            return file;
          };
          const collisionFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            readDirectory: (directory) =>
              fileSystem
                .readDirectory(resolveFile(directory))
                .pipe(
                  Effect.map((names) =>
                    directory === sourceDirectory
                      ? names.map((name) => (name === "other.js" ? "a.js" : name)).sort()
                      : names,
                  ),
                ),
            realPath: (file) =>
              fileSystem
                .realPath(resolveFile(file))
                .pipe(
                  Effect.map((resolved) =>
                    resolved.replace(
                      path.join(canonicalSource, "other.js"),
                      path.join(canonicalSource, "a.js"),
                    ),
                  ),
                ),
            stat: (file) => fileSystem.stat(resolveFile(file)),
            exists: (file) => fileSystem.exists(resolveFile(file)),
            makeDirectory: (file, options) => fileSystem.makeDirectory(resolveFile(file), options),
            copyFile: (from, to) => fileSystem.copyFile(resolveFile(from), resolveFile(to)),
            chmod: (file, mode) => fileSystem.chmod(resolveFile(file), mode),
          });
          const schedules = yield* open(schedulesDir).pipe(
            Effect.provideService(FileSystem.FileSystem, collisionFileSystem),
          );
          const error = yield* schedules
            .create(caller, {
              name: `${first} collides with ${second}`,
              enabled: false,
              target: { kind: "current-chat" },
              trigger: { kind: "once", at: 1_000 },
              sourceDirectory,
            })
            .pipe(Effect.flip);
          assert.strictEqual(error.kind, "io");
          for (const state of ["enabled", "disabled", ".staging"]) {
            assert.deepStrictEqual(
              yield* fileSystem.readDirectory(path.join(schedulesDir, state)),
              [],
            );
          }
        }
      }
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("validates staged entrypoints and rolls back failed definition and run captures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-staged-entrypoint-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      let corruptCopy = true;
      let rejectCleanup = true;
      const stagedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        copyFile: (from, to) =>
          fileSystem
            .copyFile(from, to)
            .pipe(
              Effect.andThen(
                corruptCopy && path.basename(to) === "prompt.md"
                  ? fileSystem.writeFile(to, new Uint8Array([0xc3, 0x28]))
                  : Effect.void,
              ),
            ),
        remove: (file, options) =>
          rejectCleanup && path.dirname(file) === path.join(schedulesDir, ".staging")
            ? Effect.fail(permissionDenied("remove", file))
            : fileSystem.remove(file, options),
      });
      const schedules = yield* open(schedulesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, stagedFileSystem),
      );
      const sourceDirectory = yield* prepareSource({ "prompt.md": "valid original prompt" });
      const input: Schedule.CreateSchedule = {
        name: "staged validation",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory,
      };
      const error = yield* schedules.create(caller, input).pipe(Effect.flip);
      assert.strictEqual(error.kind, "invalid");
      assert.deepStrictEqual(yield* schedules.list(caller), []);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(sourceDirectory, "prompt.md")),
        "valid original prompt",
      );
      rejectCleanup = false;
      yield* fileSystem.remove(path.join(schedulesDir, ".staging"), { recursive: true });
      yield* fileSystem.makeDirectory(path.join(schedulesDir, ".staging"), { mode: 0o700 });
      const rolledBack = yield* schedules.create(caller, input).pipe(Effect.flip);
      assert.strictEqual(rolledBack.kind, "invalid");
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, ".staging")),
        [],
      );
      corruptCopy = false;
      const created = yield* schedules.create(caller, input);
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      corruptCopy = true;
      const requests = yield* Queue.unbounded<Agent.AgentPrompt>();
      yield* TestClock.setTime(1_000);
      yield* schedules.start({
        prepare: () => Effect.succeed({ chatId, workspaceId, cwd: AbsolutePath.make(root) }),
        deliver: () => Effect.void,
        publish: () => Effect.die("Expected an agent request"),
        runPrompt: (_chatId, runId, request) =>
          Queue.offer(requests, request).pipe(
            Effect.as({ runId, outcome: "completed", events: [], finalAssistantText: "done" }),
          ),
      });
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, ".staging")),
        [],
      );
      assert.deepStrictEqual(yield* fileSystem.readDirectory(path.join(schedulesDir, "runs")), []);
      assert.strictEqual((yield* schedules.get(caller, created.id)).state, "enabled");
      corruptCopy = false;
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(yield* Queue.take(requests), textPrompt("valid original prompt"));
      const runId = `scheduled-1000-${created.definition.revision}`;
      yield* awaitFinished(
        fileSystem,
        path.join(schedulesDir, "runs", created.id, runId, "run.json"),
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("removes staging when its post-creation inspection fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-staging-acquisition-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        stat: (file) =>
          path.dirname(file) === path.join(schedulesDir, ".staging") &&
          path.basename(file).startsWith("definition-")
            ? Effect.fail(permissionDenied("stat", file))
            : fileSystem.stat(file),
      });
      const schedules = yield* open(schedulesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
      const error = yield* schedules
        .create(caller, {
          name: "staging inspection",
          enabled: false,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "valid" }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.kind, "io");
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, ".staging")),
        [],
      );
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, "disabled")),
        [],
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "copies sources containing the storage root without recursing into their own staging",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-ancestor-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        yield* fileSystem.writeFileString(path.join(root, "prompt.md"), "ancestor source");
        const schedules = yield* open(schedulesDir);
        const created = yield* schedules.create(caller, {
          name: "ancestor source",
          enabled: false,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: AbsolutePath.make(root),
        });
        if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(created.sourceDirectory, "prompt.md")),
          "ancestor source",
        );
        assert.deepStrictEqual(
          yield* fileSystem.readDirectory(
            path.join(created.sourceDirectory, "schedules", ".staging"),
          ),
          [],
        );
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("checks source structure without reading helpers during get, list, or idle scans", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-inspection-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const assetReads: Array<string> = [];
      let observeReads = false;
      const observedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readFile: (file) => {
          if (observeReads && (file.endsWith("helper.js") || file.endsWith("data.bin"))) {
            assetReads.push(file);
          }
          return fileSystem.readFile(file);
        },
        copyFile: (from, to) => {
          if (observeReads && (from.endsWith("helper.js") || from.endsWith("data.bin"))) {
            assetReads.push(from);
          }
          return fileSystem.copyFile(from, to);
        },
      });
      const schedules = yield* open(schedulesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, observedFileSystem),
      );
      const sourceDirectory = yield* prepareSource({
        "prompt.md": "Run when due.",
        "lib/helper.js": "export const value = 1;",
        "assets/data.bin": new Uint8Array([0, 255, 128]),
      });
      const created: Array<Schedule.ReadyScheduleView> = [];
      for (const enabled of [false, true]) {
        const view = yield* schedules.create(caller, {
          name: enabled ? "not due" : "disabled",
          enabled,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: enabled ? 1_000_000 : 0 },
          sourceDirectory,
        });
        if (view.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
        created.push(view);
      }
      observeReads = true;
      for (const view of created) {
        assert.deepStrictEqual(yield* schedules.get(caller, view.id), view);
      }
      assert.sameDeepMembers([...(yield* schedules.list(caller))], created);
      yield* TestClock.setTime(1_000);
      yield* schedules.start({
        prepare: () => Effect.die("Disabled and non-due schedules must not execute"),
        deliver: () => Effect.die("Unexpected delivery"),
        publish: () => Effect.die("Unexpected publication"),
        runPrompt: () => Effect.die("Unexpected prompt"),
      });
      assert.deepStrictEqual(assetReads, []);
      assert.deepStrictEqual(yield* fileSystem.readDirectory(path.join(schedulesDir, "runs")), []);

      for (const view of created) {
        const prompt = path.join(view.sourceDirectory, "prompt.md");
        yield* fileSystem.writeFileString(prompt, " \n\t");
        assert.strictEqual((yield* schedules.get(caller, view.id)).kind, "invalid");
        yield* fileSystem.writeFileString(prompt, "Repaired entrypoint.");
        const helper = path.join(view.sourceDirectory, "lib/helper.js");
        yield* fileSystem.remove(helper);
        yield* fileSystem.symlink(path.join(sourceDirectory, "lib/helper.js"), helper);
        assert.strictEqual((yield* schedules.get(caller, view.id)).kind, "invalid");
        yield* fileSystem.remove(helper);
        yield* fileSystem.writeFileString(helper, "export const value = 2;");
        const fifo = path.join(view.sourceDirectory, "assets/pipe");
        const made = Bun.spawnSync(["mkfifo", fifo]);
        assert.strictEqual(made.exitCode, 0);
        assert.strictEqual((yield* schedules.get(caller, view.id)).kind, "invalid");
        yield* fileSystem.remove(fifo);
        assert.deepStrictEqual(yield* schedules.get(caller, view.id), view);
      }
      assert.deepStrictEqual(assetReads, []);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("preserves source resolution io failures while rejecting actual symbolic links", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-realpath-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const sourceDirectory = yield* prepareSource({ "prompt.md": "Readable prompt." });
      const prompt = path.join(sourceDirectory, "prompt.md");
      let failResolution = true;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        realPath: (file) =>
          failResolution && file === prompt
            ? Effect.fail(permissionDenied("realPath", file))
            : fileSystem.realPath(file),
      });
      const schedules = yield* open(schedulesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
      const input: Schedule.CreateSchedule = {
        name: "source resolution",
        enabled: false,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory,
      };
      const ioFailure = yield* schedules.create(caller, input).pipe(Effect.flip);
      assert.strictEqual(ioFailure.kind, "io");
      failResolution = false;
      const outside = path.join(root, "outside.md");
      yield* fileSystem.rename(prompt, outside);
      yield* fileSystem.symlink(outside, prompt);
      const invalidLink = yield* schedules.create(caller, input).pipe(Effect.flip);
      assert.strictEqual(invalidLink.kind, "invalid");
      assert.strictEqual(yield* fileSystem.readFileString(outside), "Readable prompt.");
      assert.deepStrictEqual(yield* schedules.list(caller), []);
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, ".staging")),
        [],
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("isolates unreadable source captures and retries them after repair", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-capture-isolation-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      let unreadableHelper: string | undefined;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        copyFile: (from, to) =>
          from === unreadableHelper
            ? Effect.fail(permissionDenied("copyFile", from))
            : fileSystem.copyFile(from, to),
      });
      const schedules = yield* open(schedulesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
      const created: Array<Schedule.ReadyScheduleView> = [];
      for (const name of ["one", "two", "three"]) {
        const view = yield* schedules.create(caller, {
          name,
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({
            "script.js":
              'import { content } from "./lib/helper.js";process.stdout.write(JSON.stringify({agent:false,content}));',
            "lib/helper.js": `export const content = ${JSON.stringify(name)};`,
          }),
        });
        if (view.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
        created.push(view);
      }
      const [first, blocked, last] = created.sort((a, b) => a.id.localeCompare(b.id));
      if (first === undefined || blocked === undefined || last === undefined) {
        return yield* Effect.die("Expected three schedules");
      }
      unreadableHelper = path.join(blocked.sourceDirectory, "lib/helper.js");
      const published: Array<string> = [];
      const publishedEvents = yield* Queue.unbounded<void>();
      yield* TestClock.setTime(1_000);
      yield* schedules.start({
        prepare: () => Effect.succeed({ chatId, workspaceId, cwd: AbsolutePath.make(root) }),
        deliver: () => Effect.die("Script must publish without OMP"),
        publish: (_chatId, content) =>
          Effect.sync(() => void published.push(content)).pipe(
            Effect.andThen(Queue.offer(publishedEvents, undefined)),
            Effect.asVoid,
          ),
        runPrompt: () => Effect.die("Script must not invoke OMP"),
      });
      yield* Queue.take(publishedEvents);
      yield* Queue.take(publishedEvents);
      for (const view of [first, last]) {
        const runId = `scheduled-1000-${view.definition.revision}`;
        const run = yield* awaitFinished(
          fileSystem,
          path.join(schedulesDir, "runs", view.id, runId, "run.json"),
        );
        assert.deepStrictEqual(run.state.kind === "finished" && run.state.outcome, {
          kind: "published",
          content: view.definition.name,
        });
      }
      assert.sameMembers(published, [first.definition.name, last.definition.name]);
      // Wait for the queued creation wake's retry to release the capture lock.
      assert.strictEqual((yield* schedules.get(caller, blocked.id)).state, "enabled");
      assert.isFalse(yield* fileSystem.exists(path.join(schedulesDir, "runs", blocked.id)));
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, ".staging")),
        [],
      );
      unreadableHelper = undefined;
      yield* TestClock.adjust("30 seconds");
      yield* Queue.take(publishedEvents);
      const recoveredId = `scheduled-1000-${blocked.definition.revision}`;
      const recovered = yield* awaitFinished(
        fileSystem,
        path.join(schedulesDir, "runs", blocked.id, recoveredId, "run.json"),
      );
      assert.deepStrictEqual(recovered.state.kind === "finished" && recovered.state.outcome, {
        kind: "published",
        content: blocked.definition.name,
      });
      assert.sameMembers(published, ["one", "two", "three"]);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("returns repair paths for invalid metadata and entrypoints across state changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-invalid-" });
      const schedules = yield* open(AbsolutePath.make(path.join(root, "schedules")));
      const created = yield* schedules.create(caller, {
        name: "editable",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Run the update." }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      const directory = created.sourceDirectory;
      yield* fileSystem.writeFileString(
        path.join(directory, "meta.json"),
        JSON.stringify({
          ...created.definition,
          target: { kind: "workspace", workspaceId: otherWorkspaceId },
        }),
      );
      const invalidTarget = yield* schedules.get(caller, created.id);
      assert.strictEqual(invalidTarget.kind, "invalid");
      assert.strictEqual(invalidTarget.sourceDirectory, directory);
      yield* fileSystem.writeFileString(
        path.join(directory, "meta.json"),
        JSON.stringify({ ...created.definition, name: "" }),
      );
      const listed = yield* schedules.list(caller);
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0]?.kind, "invalid");
      assert.strictEqual(listed[0]?.sourceDirectory, directory);
      yield* fileSystem.writeFileString(
        path.join(directory, "meta.json"),
        JSON.stringify(created.definition),
      );
      yield* fileSystem.writeFileString(path.join(directory, "extra.txt"), "helper");
      assert.strictEqual((yield* schedules.list(caller))[0]?.kind, "ready");
      yield* fileSystem.remove(path.join(directory, "prompt.md"));
      const missingEntrypoint = yield* schedules.get(caller, created.id);
      assert.strictEqual(missingEntrypoint.kind, "invalid");
      assert.strictEqual(missingEntrypoint.sourceDirectory, directory);
      const paused = yield* schedules.update(caller, created.id, { enabled: false });
      assert.strictEqual(paused.kind, "invalid");
      assert.strictEqual(paused.state, "disabled");
      assert.strictEqual(
        paused.sourceDirectory,
        path.join(root, "schedules", "disabled", created.id),
      );
      assert.deepStrictEqual(yield* schedules.get(caller, created.id), paused);
      if (paused.sourceDirectory === null) return yield* Effect.die("Missing repair directory");
      assert.isFalse(yield* fileSystem.exists(directory));
      yield* fileSystem.writeFileString(path.join(paused.sourceDirectory, "prompt.md"), " \n\t");
      const blankEntrypoint = yield* schedules.get(caller, created.id);
      assert.strictEqual(blankEntrypoint.kind, "invalid");
      assert.strictEqual(blankEntrypoint.sourceDirectory, paused.sourceDirectory);
      yield* fileSystem.writeFileString(
        path.join(paused.sourceDirectory, "prompt.md"),
        "Repaired.",
      );
      const resumed = yield* schedules.update(caller, created.id, { enabled: true });
      assert.strictEqual(resumed.kind, "ready");
      assert.strictEqual(resumed.sourceDirectory, directory);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(directory, "prompt.md")),
        "Repaired.",
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("returns no single repair directory for conflicting owned definitions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-conflict-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir);
      const created = yield* schedules.create(caller, {
        name: "conflicted",
        enabled: false,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Retain both definitions." }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const duplicate = path.join(schedulesDir, "enabled", created.id);
      yield* fileSystem.makeDirectory(duplicate);
      yield* fileSystem.writeFileString(
        path.join(duplicate, "meta.json"),
        JSON.stringify(created.definition),
      );
      const conflicted = yield* schedules.get(caller, created.id);
      assert.strictEqual(conflicted.kind, "invalid");
      assert.strictEqual(conflicted.state, "conflicted");
      assert.strictEqual(conflicted.sourceDirectory, null);
      assert.deepStrictEqual(yield* schedules.list(caller), [conflicted]);
      const error = yield* schedules
        .update(caller, created.id, { enabled: false })
        .pipe(Effect.flip);
      assert.strictEqual(error.kind, "conflict");
      assert.isTrue(yield* fileSystem.exists(duplicate));
      assert.isTrue(yield* fileSystem.exists(created.sourceDirectory));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("repairs an invalid cron and enables the proposed definition in one update", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-schedule-repair-cron-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir);
      const created = yield* schedules.create(caller, {
        name: "repair cron",
        enabled: false,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Check the schedule." }),
        scriptTimeoutMs: 5_000,
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      yield* fileSystem.writeFileString(
        path.join(created.sourceDirectory, "meta.json"),
        JSON.stringify({
          ...created.definition,
          trigger: { kind: "cron", expression: "99 * * * *", timeZone: "UTC" },
        }),
      );
      const invalid = yield* schedules.get(caller, created.id);
      assert.strictEqual(invalid.kind, "invalid");
      assert.strictEqual(invalid.sourceDirectory, created.sourceDirectory);
      const unchangedTrigger = yield* schedules
        .update(caller, created.id, {
          name: "still invalid",
          enabled: true,
        })
        .pipe(Effect.flip);
      assert.strictEqual(unchangedTrigger.kind, "invalid");
      assert.deepStrictEqual(yield* schedules.get(caller, created.id), invalid);
      const trigger = {
        kind: "cron",
        expression: "0 9 * * *",
        timeZone: "UTC",
      } satisfies Schedule.ScheduleTrigger;
      const repaired = yield* schedules.update(caller, created.id, { trigger, enabled: true });
      assert.strictEqual(repaired.kind, "ready");
      if (repaired.kind !== "ready") return yield* Effect.die("Repaired schedule is invalid");
      assert.strictEqual(repaired.state, "enabled");
      assert.strictEqual(repaired.sourceDirectory, path.join(schedulesDir, "enabled", created.id));
      assert.deepStrictEqual(repaired.definition, {
        ...created.definition,
        trigger,
        revision: repaired.definition.revision,
      });
      assert.notStrictEqual(repaired.definition.revision, created.definition.revision);
      const restarted = yield* open(schedulesDir);
      assert.deepStrictEqual(yield* restarted.get(caller, created.id), repaired);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects misplaced and tampered run identities", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-run-id-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
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
      const definition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000004"),
        name: "identity",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const run: Schedule.ScheduleRunLifecycle = {
        version: 1,
        id: Schedule.ScheduleRunId.make(`scheduled-1000-${definition.revision}`),
        scheduleId: Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000005"),
        definitionRevision: definition.revision,
        source: { kind: "scheduled", scheduledFor: 1_000 },
        plannedTarget: { kind: "existing-chat", ownerWorkspaceId: workspaceId, chatId },
        claimedAt: 1_000,
        state: { kind: "claimed" },
      };
      yield* bootstrap(storage);
      yield* publishRun(
        storage,
        run,
        definition,
        yield* prepareSource({ "prompt.md": "identity" }),
        "018f47a0-0000-7000-8000-000000000006",
        Effect.void,
      );
      assert.deepStrictEqual(yield* readRuns(storage), [run]);

      const runsRoot = path.join(schedulesDir, "runs");
      const scheduleDirectory = path.join(runsRoot, run.scheduleId);
      const otherScheduleId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000007");
      const misplacedScheduleDirectory = path.join(runsRoot, otherScheduleId);
      yield* fileSystem.rename(scheduleDirectory, misplacedScheduleDirectory);
      const misplacedSchedule = yield* readRuns(storage).pipe(Effect.flip);
      assert.strictEqual(misplacedSchedule.kind, "corrupt");
      yield* fileSystem.rename(misplacedScheduleDirectory, scheduleDirectory);

      const originalRunDirectory = runDirectory(storage, run.scheduleId, run.id);
      const otherRunId = Schedule.ScheduleRunId.make(`scheduled-2000-${definition.revision}`);
      const misplacedRunDirectory = runDirectory(storage, run.scheduleId, otherRunId);
      yield* fileSystem.rename(originalRunDirectory, misplacedRunDirectory);
      const misplacedRun = yield* readRuns(storage).pipe(Effect.flip);
      assert.strictEqual(misplacedRun.kind, "corrupt");
      yield* fileSystem.rename(misplacedRunDirectory, originalRunDirectory);

      yield* fileSystem.writeFileString(
        path.join(originalRunDirectory, "run.json"),
        JSON.stringify({ ...run, source: { kind: "scheduled", scheduledFor: 2_000 } }),
      );
      const tamperedRun = yield* readRuns(storage).pipe(Effect.flip);
      assert.strictEqual(tamperedRun.kind, "corrupt");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("captures prompt artifacts and collapses cron downtime to the latest slot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-cron-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const invoked = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<string>();
      const schedules = yield* make(schedulesDir);
      const host: Schedule.ScheduleRunHost = {
        prepare: () => Effect.succeed({ chatId, workspaceId, cwd }),
        deliver: (_target, content) => Deferred.succeed(delivered, content).pipe(Effect.asVoid),
        publish: () => Effect.die("agent output must not be persisted twice"),
        runPrompt: (_target, runId, prompt, onEvent) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(prompt, textPrompt("Inspect the workspace."));
            yield* onEvent({ type: "run-started" });
            yield* onEvent({
              type: "message-settled",
              message: {
                role: "assistant",
                status: "completed",
                stopReason: "stop",
                content: [{ type: "text", text: "finished" }],
                model: "test",
                timestamp: 1,
              },
            });
            yield* onEvent({ type: "run-finished", outcome: "completed" });
            yield* Deferred.succeed(invoked, undefined);
            return {
              runId,
              outcome: "completed",
              events: [],
              finalAssistantText: "finished",
            };
          }),
      };

      yield* TestClock.setTime(0);
      yield* schedules.start(host);
      const created = yield* schedules.create(caller, {
        name: "hourly",
        enabled: false,
        target: { kind: "current-chat" },
        trigger: { kind: "cron", expression: "0 * * * *", timeZone: "UTC" },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Inspect the workspace." }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      yield* TestClock.setTime(3 * 60 * 60 * 1_000 + 30_000);
      yield* schedules.update(caller, created.id, { enabled: true });
      const scheduleRuns = path.join(schedulesDir, "runs", created.id);
      yield* awaitExists(fileSystem, scheduleRuns);
      yield* Deferred.await(invoked);
      assert.strictEqual(yield* Deferred.await(delivered), "finished");
      const runNames = yield* fileSystem.readDirectory(scheduleRuns);
      const runDirectory = path.join(scheduleRuns, runNames[0] ?? "missing");
      assert.deepStrictEqual(runNames, [
        `scheduled-${3 * 60 * 60 * 1_000}-${created.definition.revision}`,
      ]);
      const run = yield* awaitFinished(fileSystem, path.join(runDirectory, "run.json"));
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(runDirectory, "decision.json")),
        JSON.stringify({ agent: true }),
      );
      assert.strictEqual(run.state.kind, "finished");
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(runDirectory, "omp", "final.md")),
        "finished",
      );
      assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, "omp", "events.jsonl")));
      assert.isTrue(yield* fileSystem.exists(path.join(runDirectory, "omp", "result.json")));
      assert.isTrue(yield* fileSystem.exists(path.join(schedulesDir, "enabled", created.id)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("derives script behavior and agent input from source files and decisions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-schedule-decisions-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const requests = new Map<Schedule.ScheduleRunId, Agent.AgentPrompt>();
      let deliveries = 0;
      const schedules = yield* make(schedulesDir);
      const host: Schedule.ScheduleRunHost = {
        prepare: (target) =>
          Effect.succeed({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
        deliver: () =>
          Effect.sync(() => {
            deliveries += 1;
          }),
        publish: () => Effect.die("agent output must not be persisted twice"),
        runPrompt: (_target, runId, prompt) =>
          Effect.sync(() => requests.set(runId, prompt)).pipe(
            Effect.as({
              runId,
              outcome: "completed",
              events: [],
              finalAssistantText: "finished",
            }),
          ),
      };

      yield* TestClock.setTime(1_000);
      yield* schedules.start(host);
      const skip = yield* schedules.create(caller, {
        name: "skip",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": "process.stdout.write(JSON.stringify({agent:false}))",
        }),
      });
      const composed = yield* schedules.create(caller, {
        name: "composed",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js":
            'process.stdout.write(JSON.stringify({agent:true,content:"generated input"}))',
          "prompt.md": "stored prompt",
        }),
      });
      const scriptOnly = yield* schedules.create(caller, {
        name: "script only",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": 'process.stdout.write(JSON.stringify({agent:true,content:"script input"}))',
        }),
      });
      const storedPrompt = yield* schedules.create(caller, {
        name: "stored prompt",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": "process.stdout.write(JSON.stringify({agent:true}))",
          "prompt.md": "prompt input",
        }),
      });
      const missingInput = yield* schedules.create(caller, {
        name: "missing input",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": "process.stdout.write(JSON.stringify({agent:true}))",
        }),
      });
      for (const created of [skip, composed, scriptOnly, storedPrompt, missingInput]) {
        assert.strictEqual(created.kind, "ready");
      }
      if (
        skip.kind !== "ready" ||
        composed.kind !== "ready" ||
        scriptOnly.kind !== "ready" ||
        storedPrompt.kind !== "ready" ||
        missingInput.kind !== "ready"
      ) {
        return;
      }

      yield* TestClock.adjust("30 seconds");
      const finishedRun = (schedule: Schedule.ReadyScheduleView) =>
        awaitFinished(
          fileSystem,
          path.join(
            schedulesDir,
            "runs",
            schedule.id,
            `scheduled-1000-${schedule.definition.revision}`,
            "run.json",
          ),
        );
      const skipRun = yield* finishedRun(skip);
      const composedRun = yield* finishedRun(composed);
      const scriptOnlyRun = yield* finishedRun(scriptOnly);
      const storedPromptRun = yield* finishedRun(storedPrompt);
      const missingInputRun = yield* finishedRun(missingInput);

      assert.deepStrictEqual(skipRun.state.kind === "finished" && skipRun.state.outcome, {
        kind: "skipped",
      });
      assert.deepStrictEqual(
        requests.get(composedRun.id),
        textPrompt("generated input\n\nstored prompt"),
      );
      assert.deepStrictEqual(requests.get(scriptOnlyRun.id), textPrompt("script input"));
      assert.deepStrictEqual(requests.get(storedPromptRun.id), textPrompt("prompt input"));
      assert.isFalse(requests.has(skipRun.id));
      assert.isFalse(requests.has(missingInputRun.id));
      assert.deepInclude(
        missingInputRun.state.kind === "finished" ? missingInputRun.state.outcome : {},
        { kind: "failed", stage: "protocol" },
      );
      assert.strictEqual(deliveries, 3);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect(
    "executes claimed helper imports from an unchanged source snapshot after live edits",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-snapshot-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const prepareStarted = yield* Deferred.make<void>();
        const releasePrepare = yield* Deferred.make<void>();
        const published = yield* Queue.unbounded<string>();
        const schedules = yield* open(schedulesDir);
        yield* TestClock.setTime(1_000);
        yield* schedules.start({
          prepare: () =>
            Deferred.succeed(prepareStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releasePrepare)),
              Effect.as({ chatId, workspaceId, cwd: AbsolutePath.make(root) }),
            ),
          deliver: () => Effect.die("Script decisions must publish without OMP"),
          publish: (_chatId, content) => Queue.offer(published, content).pipe(Effect.asVoid),
          runPrompt: () => Effect.die("Script decisions must not run OMP"),
        });
        const script =
          'import { content } from "./lib/helper.js";process.stdout.write(JSON.stringify({agent:false,content}));';
        const helper = 'export const content = "original helper";';
        const asset = new Uint8Array([0, 255, 10, 128]);
        const created = yield* schedules.create(caller, {
          name: "snapshot",
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource(
            {
              "script.js": script,
              "prompt.md": "original prompt",
              "lib/helper.js": helper,
              "assets/data.bin": asset,
            },
            ["cache/empty"],
          ),
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(prepareStarted);
        yield* fileSystem.writeFileString(
          path.join(created.sourceDirectory, "lib/helper.js"),
          'export const content = "edited helper";',
        );
        yield* fileSystem.writeFile(
          path.join(created.sourceDirectory, "assets/data.bin"),
          new Uint8Array([42]),
        );
        yield* fileSystem.writeFileString(
          path.join(created.sourceDirectory, "prompt.md"),
          "edited prompt",
        );
        const updated = yield* schedules.update(caller, created.id, {
          name: "edited metadata",
          enabled: false,
        });
        assert.strictEqual(updated.kind, "ready");
        if (updated.kind !== "ready") return;
        assert.notStrictEqual(updated.definition.revision, created.definition.revision);
        yield* Deferred.succeed(releasePrepare, undefined);
        assert.strictEqual(yield* Queue.take(published), "original helper");
        const runId = `scheduled-1000-${created.definition.revision}`;
        const directory = path.join(schedulesDir, "runs", created.id, runId);
        const finished = yield* awaitFinished(fileSystem, path.join(directory, "run.json"));
        assert.deepStrictEqual(finished.state.kind === "finished" && finished.state.outcome, {
          kind: "published",
          content: "original helper",
        });
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "input", "lib/helper.js")),
          helper,
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "input", "script.js")),
          script,
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "input", "prompt.md")),
          "original prompt",
        );
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(directory, "input", "assets/data.bin")),
          asset,
        );
        assert.deepStrictEqual(
          yield* fileSystem.readDirectory(path.join(directory, "input", "cache/empty")),
          [],
        );
        assert.deepStrictEqual(
          yield* decodeDefinition(
            yield* fileSystem.readFileString(path.join(directory, "input", "definition.json")),
          ),
          created.definition,
        );
        yield* schedules.update(caller, created.id, { enabled: true });
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(yield* Queue.take(published), "edited helper");
        const nextRunId = `scheduled-1000-${updated.definition.revision}`;
        const nextDirectory = path.join(schedulesDir, "runs", created.id, nextRunId);
        yield* awaitFinished(fileSystem, path.join(nextDirectory, "run.json"));
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(nextDirectory, "input", "assets/data.bin")),
          new Uint8Array([42]),
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(nextDirectory, "input", "prompt.md")),
          "edited prompt",
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(directory, "input", "lib/helper.js")),
          helper,
        );
        assert.deepStrictEqual(
          yield* fileSystem.readFile(path.join(directory, "input", "assets/data.bin")),
          asset,
        );
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("does not let an old run disable an updated definition", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-revision-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const prepareStarted = yield* Deferred.make<void>();
      const releasePrepare = yield* Deferred.make<void>();
      const schedules = yield* make(schedulesDir);
      const host: Schedule.ScheduleRunHost = {
        prepare: (target) =>
          Deferred.succeed(prepareStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releasePrepare)),
            Effect.as({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
          ),
        deliver: () => Effect.void,
        publish: () => Effect.void,
        runPrompt: (_target, runId) =>
          Effect.succeed({
            runId,
            outcome: "completed",
            events: [],
            finalAssistantText: "old run",
          }),
      };

      yield* TestClock.setTime(1_000);
      yield* schedules.start(host);
      const created = yield* schedules.create(caller, {
        name: "old once",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "old prompt" }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(prepareStarted);

      yield* fileSystem.writeFileString(
        path.join(created.sourceDirectory, "prompt.md"),
        "new prompt",
      );
      const replaced = yield* schedules.update(caller, created.id, {
        name: "new cron",
        trigger: { kind: "cron", expression: "* * * * *", timeZone: "UTC" },
      });
      assert.strictEqual(replaced.kind, "ready");
      if (replaced.kind !== "ready") return;
      assert.notStrictEqual(replaced.definition.revision, created.definition.revision);
      yield* Deferred.succeed(releasePrepare, undefined);

      const runFile = path.join(
        schedulesDir,
        "runs",
        created.id,
        `scheduled-1000-${created.definition.revision}`,
        "run.json",
      );
      yield* awaitFinished(fileSystem, runFile);
      assert.isTrue(yield* fileSystem.exists(path.join(schedulesDir, "enabled", created.id)));
      const current = yield* schedules.get(caller, created.id);
      assert.strictEqual(current.kind, "ready");
      if (current.kind === "ready") {
        assert.strictEqual(current.definition.revision, replaced.definition.revision);
        assert.strictEqual(current.definition.trigger.kind, "cron");
      }
      const restarted = yield* make(schedulesDir);
      yield* restarted.start(host);
      assert.isTrue(yield* fileSystem.exists(path.join(schedulesDir, "enabled", created.id)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("continues scheduling after a scan failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-recovery-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const invoked = yield* Deferred.make<void>();
      const schedules = yield* make(schedulesDir);
      const host: Schedule.ScheduleRunHost = {
        prepare: (target) =>
          Effect.succeed({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
        deliver: () => Effect.void,
        publish: () => Effect.void,
        runPrompt: (_target, runId) =>
          Deferred.succeed(invoked, undefined).pipe(
            Effect.as({
              runId,
              outcome: "completed",
              events: [],
              finalAssistantText: "recovered",
            }),
          ),
      };

      yield* TestClock.setTime(0);
      yield* schedules.start(host);
      const enabledDirectory = path.join(schedulesDir, "enabled");
      yield* fileSystem.remove(enabledDirectory, { recursive: true });
      yield* fileSystem.writeFileString(enabledDirectory, "not a directory");
      yield* TestClock.adjust("30 seconds");
      yield* fileSystem.remove(enabledDirectory);
      yield* fileSystem.makeDirectory(enabledDirectory, { mode: 0o700 });

      const created = yield* schedules.create(caller, {
        name: "after scan failure",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 30_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "still alive" }),
      });
      assert.strictEqual(created.kind, "ready");
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(invoked);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "rejects authored source symlinks, reserved names, and missing or blank entrypoints",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-unsafe-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir);
        const outside = path.join(root, "outside.txt");
        yield* fileSystem.writeFileString(outside, "unchanged");
        const outsideDirectory = yield* prepareSource({
          "prompt.md": "valid external source",
          "helper.js": "export const value = 1;",
        });
        const invalidSources = [
          yield* prepareSource({ "lib/helper.js": "export const value = 1;" }),
          yield* prepareSource({ "prompt.md": " \n\t" }),
          yield* prepareSource({ "script.js": "\n" }),
          yield* prepareSource({ "prompt.md": "valid", "meta.json": "{}" }),
          yield* prepareSource({ "script.js": "void 0;", "definition.json": "{}" }),
          yield* prepareSource({ "prompt.md": "valid" }, ["meta.json"]),
          yield* prepareSource({ "prompt.md": "valid" }, ["definition.json"]),
          yield* prepareSource({}, ["prompt.md"]),
        ];
        for (const link of [
          { entry: "prompt.md", target: outside },
          { entry: "lib/helper.js", target: outside },
          { entry: "lib/dangling.js", target: path.join(root, "missing.js") },
          { entry: "lib", target: outsideDirectory },
        ]) {
          const directory = yield* prepareSource({ "prompt.md": "valid" });
          const destination = path.join(directory, link.entry);
          yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
          if (link.entry === "prompt.md") yield* fileSystem.remove(destination);
          yield* fileSystem.symlink(link.target, destination);
          invalidSources.push(directory);
        }
        const linkedRoot = AbsolutePath.make(path.join(root, "linked-source"));
        yield* fileSystem.symlink(outsideDirectory, linkedRoot);
        invalidSources.push(linkedRoot);
        for (const sourceDirectory of invalidSources) {
          const error = yield* schedules
            .create(caller, {
              name: "unsafe source",
              enabled: false,
              target: { kind: "current-chat" },
              trigger: { kind: "once", at: 1_000 },
              sourceDirectory,
            })
            .pipe(Effect.flip);
          assert.instanceOf(error, Schedule.ScheduleError);
        }
        assert.deepStrictEqual(yield* schedules.list(caller), []);
        assert.strictEqual(yield* fileSystem.readFileString(outside), "unchanged");
        assert.deepStrictEqual((yield* fileSystem.readDirectory(outsideDirectory)).sort(), [
          "helper.js",
          "prompt.md",
        ]);
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect.each(["script.js", "prompt.md"])(
    "rejects malformed UTF-8 in authored %s",
    (entrypoint) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-utf8-" });
        const schedules = yield* open(AbsolutePath.make(path.join(root, "schedules")));
        const error = yield* schedules
          .create(caller, {
            name: "malformed entrypoint",
            enabled: false,
            target: { kind: "current-chat" },
            trigger: { kind: "once", at: 1_000 },
            sourceDirectory: yield* prepareSource({
              "script.js": "process.stdout.write(JSON.stringify({agent:false}));",
              "prompt.md": "Check the workspace.",
              [entrypoint]: new Uint8Array([0xc3, 0x28]),
            }),
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, Schedule.ScheduleError);
        assert.strictEqual(error.kind, "invalid");
        assert.deepStrictEqual(yield* schedules.list(caller), []);
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect.each(["script.js", "prompt.md"])(
    "lists managed %s with malformed UTF-8 as invalid until repaired",
    (entrypoint) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-owned-utf8-" });
        const schedules = yield* open(AbsolutePath.make(path.join(root, "schedules")));
        const created = yield* schedules.create(caller, {
          name: "repairable entrypoint",
          enabled: false,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({
            "script.js": "process.stdout.write(JSON.stringify({agent:false}));",
            "prompt.md": "Check the workspace.",
          }),
        });
        if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
        const entrypointPath = path.join(created.sourceDirectory, entrypoint);
        yield* fileSystem.writeFile(entrypointPath, new Uint8Array([0xc3, 0x28]));
        const invalid = yield* schedules.get(caller, created.id);
        assert.strictEqual(invalid.kind, "invalid");
        assert.strictEqual(invalid.sourceDirectory, created.sourceDirectory);
        assert.deepStrictEqual(
          (yield* schedules.list(caller)).map((view) => view.kind),
          ["invalid"],
        );
        const error = yield* schedules
          .update(caller, created.id, { enabled: true })
          .pipe(Effect.flip);
        assert.strictEqual(error.kind, "invalid");
        yield* fileSystem.writeFileString(entrypointPath, "/* Repaired café. */");
        const repaired = yield* schedules.update(caller, created.id, { enabled: true });
        assert.strictEqual(repaired.kind, "ready");
        assert.strictEqual(repaired.state, "enabled");
        assert.deepStrictEqual(yield* schedules.list(caller), [repaired]);
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect.each(["Meta.json", "Definition.json"])(
    "rejects authored %s before publishing metadata",
    (name) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-reserved-" });
        const schedules = yield* open(AbsolutePath.make(path.join(root, "schedules")));
        const error = yield* schedules
          .create(caller, {
            name: "reserved source",
            enabled: false,
            target: { kind: "current-chat" },
            trigger: { kind: "once", at: 1_000 },
            sourceDirectory: yield* prepareSource({ "prompt.md": "valid", [name]: "{}" }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.kind, "invalid");
        assert.deepStrictEqual(yield* schedules.list(caller), []);
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects mixed-case metadata rather than skipping it in managed sources", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-managed-case-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir);
      const created = yield* schedules.create(caller, {
        name: "managed metadata",
        enabled: false,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "valid" }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("case-check"),
      };
      const run: Schedule.ScheduleRunLifecycle = {
        version: 1,
        id: Schedule.ScheduleRunId.make(`scheduled-1000-${created.definition.revision}`),
        scheduleId: created.id,
        definitionRevision: created.definition.revision,
        source: { kind: "scheduled", scheduledFor: 1_000 },
        plannedTarget: { kind: "existing-chat", ownerWorkspaceId: workspaceId, chatId },
        claimedAt: 1_000,
        state: { kind: "claimed" },
      };
      const error = yield* publishRun(
        storage,
        run,
        created.definition,
        yield* prepareSource({ "prompt.md": "valid", "Meta.json": "{}" }),
        "case-check",
        Effect.void,
      ).pipe(Effect.flip);
      assert.strictEqual(error.kind, "invalid");
      assert.deepStrictEqual(yield* readRuns(storage), []);
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, ".staging")),
        [],
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "rejects dangling helper links and reserved snapshot names added to owned sources",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-owned-source-unsafe-",
        });
        const schedules = yield* open(AbsolutePath.make(path.join(root, "schedules")));
        const created = yield* schedules.create(caller, {
          name: "owned source",
          enabled: false,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "valid" }, ["lib"]),
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        const dangling = path.join(created.sourceDirectory, "lib/helper.js");
        yield* fileSystem.symlink(path.join(root, "missing.js"), dangling);
        const invalid = yield* schedules.get(caller, created.id);
        assert.strictEqual(invalid.kind, "invalid");
        assert.strictEqual(invalid.sourceDirectory, created.sourceDirectory);
        const error = yield* schedules
          .update(caller, created.id, {
            enabled: true,
            trigger: { kind: "cron", expression: "0 9 * * *", timeZone: "UTC" },
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.kind, "invalid");
        assert.deepStrictEqual(
          yield* decodeDefinition(
            yield* fileSystem.readFileString(path.join(created.sourceDirectory, "meta.json")),
          ),
          created.definition,
        );
        yield* fileSystem.remove(dangling);
        for (const name of ["definition.json", "Definition.json"]) {
          const asset = path.join(created.sourceDirectory, name);
          yield* fileSystem.writeFileString(asset, "{}", { flag: "wx" });
          assert.strictEqual((yield* schedules.get(caller, created.id)).kind, "invalid");
          assert.strictEqual((yield* schedules.list(caller))[0]?.kind, "invalid");
          yield* fileSystem.remove(asset);
          assert.strictEqual((yield* schedules.get(caller, created.id)).kind, "ready");
        }
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects symlinked metadata and append destinations", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-symlink-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const outside = path.join(root, "outside.txt");
      yield* fileSystem.writeFileString(outside, "unchanged");
      let scheduleId: Schedule.ScheduleId | undefined;
      const schedules = yield* make(schedulesDir);
      const host: Schedule.ScheduleRunHost = {
        prepare: (target) =>
          Effect.succeed({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
        deliver: () => Effect.void,
        publish: () => Effect.void,
        runPrompt: (_target, runId, _prompt, onEvent) =>
          Effect.gen(function* () {
            if (scheduleId === undefined) return yield* Effect.die("Schedule identity missing");
            const eventsFile = path.join(
              schedulesDir,
              "runs",
              scheduleId,
              runId,
              "omp",
              "events.jsonl",
            );
            yield* fileSystem.remove(eventsFile).pipe(Effect.orDie);
            yield* fileSystem.symlink(outside, eventsFile).pipe(Effect.orDie);
            yield* onEvent({ type: "run-started" });
            return {
              runId,
              outcome: "completed",
              events: [],
              finalAssistantText: "must not publish",
            };
          }),
      };

      yield* TestClock.setTime(1_000);
      yield* schedules.start(host);
      const created = yield* schedules.create(caller, {
        name: "symlink defense",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "capture" }),
      });
      assert.strictEqual(created.kind, "ready");
      if (created.kind !== "ready") return;
      scheduleId = created.id;
      yield* TestClock.adjust("30 seconds");
      const run = yield* awaitFinished(
        fileSystem,
        path.join(
          schedulesDir,
          "runs",
          created.id,
          `scheduled-1000-${created.definition.revision}`,
          "run.json",
        ),
      );
      assert.deepInclude(run.state.kind === "finished" ? run.state.outcome : {}, {
        kind: "failed",
        stage: "omp",
      });
      assert.strictEqual(yield* fileSystem.readFileString(outside), "unchanged");
      yield* awaitExists(fileSystem, path.join(schedulesDir, "disabled", created.id, "meta.json"));

      const metadata = path.join(schedulesDir, "disabled", created.id, "meta.json");
      const externalMetadata = path.join(root, "external-meta.json");
      yield* fileSystem.writeFileString(externalMetadata, JSON.stringify(created.definition));
      yield* fileSystem.remove(metadata);
      yield* fileSystem.symlink(externalMetadata, metadata);
      const listed = yield* schedules.list(caller);
      assert.deepStrictEqual(listed, []);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("rejects a symlinked schedule root before writing through it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-schedule-root-" });
      const outside = path.join(root, "outside");
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.symlink(outside, schedulesDir);
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000040"),
      };

      const error = yield* bootstrap(storage).pipe(Effect.flip);
      assert.strictEqual(error.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), []);

      const childSchedulesDir = AbsolutePath.make(path.join(root, "child-schedules"));
      const childOutside = path.join(root, "child-outside");
      yield* fileSystem.makeDirectory(childSchedulesDir);
      yield* fileSystem.makeDirectory(childOutside);
      yield* fileSystem.symlink(childOutside, path.join(childSchedulesDir, "enabled"));
      const childError = yield* bootstrap({
        ...storage,
        schedulesDir: childSchedulesDir,
      }).pipe(Effect.flip);
      assert.strictEqual(childError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(childOutside), []);
      assert.deepStrictEqual(yield* fileSystem.readDirectory(childSchedulesDir), ["enabled"]);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("rejects symlinked definition destination parents before publishing or updating", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-definition-root-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const outside = path.join(root, "outside");
      const sentinel = path.join(outside, "sentinel");
      const enabled = path.join(schedulesDir, "enabled");
      const retainedEnabled = path.join(root, "retained-enabled");
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000090"),
      };
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000091");
      const definition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000092"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const source = yield* prepareSource({ "prompt.md": "original" });
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.writeFileString(sentinel, "unchanged");
      yield* bootstrap(storage);

      yield* fileSystem.remove(enabled, { recursive: true });
      yield* fileSystem.symlink(outside, enabled);
      const createError = yield* publishDefinition(
        storage,
        id,
        "enabled",
        definition,
        source,
        "symlinked-create-parent",
      ).pipe(Effect.flip);
      assert.strictEqual(createError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);

      yield* fileSystem.remove(enabled);
      yield* fileSystem.makeDirectory(enabled, { mode: 0o700 });
      yield* publishDefinition(storage, id, "enabled", definition, source, "original");
      const current = yield* loadSchedule(storage, id);
      if (current === undefined) return yield* Effect.die("Published definition disappeared");
      const replacement: Schedule.ScheduleDefinition = {
        ...definition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000093"),
        name: "replacement",
      };
      const transaction = path.join(schedulesDir, ".staging", "update-symlinked-update-parent");
      const nextMetadata = path.join(transaction, "next.json");
      const swappedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (file, contents, options) =>
          fileSystem
            .writeFileString(file, contents, options)
            .pipe(
              Effect.tap(() =>
                file === nextMetadata
                  ? fileSystem
                      .rename(enabled, retainedEnabled)
                      .pipe(Effect.andThen(fileSystem.symlink(outside, enabled)))
                  : Effect.void,
              ),
            ),
      });
      const updateError = yield* updateDefinition(
        { ...storage, fileSystem: swappedFileSystem },
        current,
        replacement,
        "enabled",
        "symlinked-update-parent",
      ).pipe(Effect.flip);
      assert.strictEqual(updateError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      const retained = yield* decodeDefinition(
        yield* fileSystem.readFileString(path.join(retainedEnabled, id, "meta.json")),
      );
      assert.strictEqual(retained.revision, definition.revision);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("rejects a symlinked state destination when moving a definition", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-move-root-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const outside = path.join(root, "outside");
      const sentinel = path.join(outside, "sentinel");
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000094"),
      };
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000095");
      const definition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000096"),
        name: "move destination",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.writeFileString(sentinel, "unchanged");
      yield* bootstrap(storage);
      yield* publishDefinition(
        storage,
        id,
        "enabled",
        definition,
        yield* prepareSource({ "prompt.md": "move me" }),
        "move-source",
      );
      const loaded = yield* loadSchedule(storage, id);
      if (loaded === undefined) return yield* Effect.die("Published definition disappeared");
      const disabled = path.join(schedulesDir, "disabled");
      yield* fileSystem.remove(disabled, { recursive: true });
      yield* fileSystem.symlink(outside, disabled);

      const error = yield* moveDefinition(storage, loaded, "disabled").pipe(Effect.flip);
      assert.strictEqual(error.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      assert.isTrue(yield* fileSystem.exists(path.join(schedulesDir, "enabled", id, "meta.json")));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("keeps metadata and source canonical when an update is interrupted during commit", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-update-interrupt-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000041"),
      };
      yield* bootstrap(storage);
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000042");
      const original: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000043"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      yield* publishDefinition(
        storage,
        id,
        "enabled",
        original,
        yield* prepareSource({ "prompt.md": "original" }),
        "018f47a0-0000-7000-8000-000000000044",
      );
      const current = yield* loadSchedule(storage, id);
      if (current === undefined) return yield* Effect.die("Published definition disappeared");
      const replacement: Schedule.ScheduleDefinition = {
        ...original,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000045"),
        name: "replacement",
      };
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      const destination = path.join(schedulesDir, "disabled", id);
      const next = path.join(
        schedulesDir,
        ".staging",
        "update-018f47a0-0000-7000-8000-000000000046",
        "next.json",
      );
      const interruptedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          from === next && to === path.join(destination, "meta.json")
            ? Deferred.succeed(commitStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCommit)),
                Effect.andThen(fileSystem.rename(from, to)),
              )
            : fileSystem.rename(from, to),
      });
      const interruptedStorage: Storage = { ...storage, fileSystem: interruptedFileSystem };
      const fiber = yield* updateDefinition(
        interruptedStorage,
        current,
        replacement,
        "disabled",
        "018f47a0-0000-7000-8000-000000000046",
      ).pipe(Effect.forkChild);
      yield* Deferred.await(commitStarted);
      assert.deepStrictEqual(
        yield* decodeDefinition(
          yield* fileSystem.readFileString(path.join(destination, "meta.json")),
        ),
        original,
      );
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(destination, "prompt.md")),
        "original",
      );
      const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(interruption);

      const loaded = yield* loadSchedule(storage, id);
      assert.strictEqual(loaded?.view.kind, "ready");
      if (loaded?.view.kind !== "ready") return;
      assert.strictEqual(loaded.view.definition.revision, replacement.revision);
      assert.strictEqual(loaded.view.definition.name, "replacement");
      assert.strictEqual(loaded.view.state, "disabled");
      assert.strictEqual(loaded.view.sourceDirectory, destination);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(destination, "prompt.md")),
        "original",
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect(
    "retains a committed metadata update when cleanup fails and recovers it on restart",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-update-cleanup-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const staging = path.join(schedulesDir, ".staging");
        const logs = yield* captureLogs();
        let retainedTransaction: string | undefined;
        const failingFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          remove: (file, options) => {
            if (path.dirname(file) !== staging || !path.basename(file).startsWith("update-")) {
              return fileSystem.remove(file, options);
            }
            retainedTransaction = file;
            return Effect.fail(permissionDenied("remove", "private cleanup cause"));
          },
        });
        const schedules = yield* open(schedulesDir).pipe(
          Effect.provideService(FileSystem.FileSystem, failingFileSystem),
        );
        const created = yield* schedules.create(caller, {
          name: "private original",
          enabled: false,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 10_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "private original prompt" }),
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        const updated = yield* schedules
          .update(caller, created.id, {
            name: "private updated",
            enabled: true,
            trigger: { kind: "once", at: 20_000 },
          })
          .pipe(Effect.provide(logs.layer));
        assert.strictEqual(updated.kind, "ready");
        if (updated.kind !== "ready") return;
        assert.notStrictEqual(updated.definition.revision, created.definition.revision);
        assert.strictEqual(updated.definition.name, "private updated");
        assert.deepStrictEqual(yield* schedules.list(caller), [updated]);
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(updated.sourceDirectory, "prompt.md")),
          "private original prompt",
        );
        if (retainedTransaction === undefined) {
          return yield* Effect.die("Update cleanup was not attempted");
        }
        assert.isTrue(yield* fileSystem.exists(path.join(retainedTransaction, "transaction.json")));
        const errors = logs.entries.filter((entry) => entry.level === "Error");
        assert.strictEqual(errors.length, 1);
        assert.deepInclude(errors[0]?.annotations, {
          component: "schedule",
          operation: "update",
          phase: "cleanup",
          scheduleId: created.id,
          definitionRevision: updated.definition.revision,
          category: "io",
        });
        assert.notInclude(JSON.stringify(logs.entries), "private");
        assert.notInclude(JSON.stringify(logs.entries), root);
        const latest = yield* schedules.update(caller, created.id, { name: "latest" });
        assert.strictEqual(latest.kind, "ready");
        if (latest.kind !== "ready") return;
        assert.strictEqual(latest.state, "enabled");
        const restarted = yield* open(schedulesDir);
        assert.deepStrictEqual(yield* restarted.get(caller, created.id), latest);
        assert.isFalse(yield* fileSystem.exists(retainedTransaction));
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("keeps a later pause after an earlier metadata state move fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-update-move-failure-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const enabled = path.join(schedulesDir, "enabled");
      const disabled = path.join(schedulesDir, "disabled");
      let rejectMove = true;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          rejectMove && path.dirname(from) === enabled && path.dirname(to) === disabled
            ? Effect.fail(permissionDenied("rename", from))
            : fileSystem.rename(from, to),
      });
      const schedules = yield* open(schedulesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
      const created = yield* schedules.create(caller, {
        name: "keep paused",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Original source." }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const error = yield* schedules
        .update(caller, created.id, {
          name: "not committed",
          enabled: false,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.kind, "io");
      assert.deepStrictEqual(yield* schedules.get(caller, created.id), created);
      rejectMove = false;
      const paused = yield* schedules.update(caller, created.id, { enabled: false });
      assert.strictEqual(paused.kind, "ready");
      if (paused.kind !== "ready") return yield* Effect.die("Paused schedule is invalid");
      assert.strictEqual(paused.state, "disabled");
      assert.deepStrictEqual(paused.definition, created.definition);
      const restarted = yield* open(schedulesDir);
      assert.deepStrictEqual(yield* restarted.get(caller, created.id), paused);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(paused.sourceDirectory, "prompt.md")),
        "Original source.",
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("reconciles a retained rollback before accepting another mutation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-update-retained-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const enabled = path.join(schedulesDir, "enabled");
      const disabled = path.join(schedulesDir, "disabled");
      let rejectCommitAndRollback = true;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          rejectCommitAndRollback &&
          (path.basename(from) === "next.json" ||
            (path.dirname(from) === disabled && path.dirname(to) === enabled))
            ? Effect.fail(permissionDenied("rename", from))
            : fileSystem.rename(from, to),
      });
      const schedules = yield* open(schedulesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
      const created = yield* schedules.create(caller, {
        name: "original",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Original source." }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const failed = yield* schedules
        .update(caller, created.id, {
          name: "uncommitted",
          enabled: false,
        })
        .pipe(Effect.flip);
      assert.strictEqual(failed.kind, "io");
      const blocked = yield* schedules
        .update(caller, created.id, { enabled: false })
        .pipe(Effect.flip);
      assert.strictEqual(blocked.kind, "io");
      rejectCommitAndRollback = false;
      const recovered = yield* schedules.update(caller, created.id, { name: "after recovery" });
      assert.strictEqual(recovered.kind, "ready");
      if (recovered.kind !== "ready") return yield* Effect.die("Recovered schedule is invalid");
      assert.strictEqual(recovered.state, "enabled");
      assert.strictEqual(recovered.sourceDirectory, created.sourceDirectory);
      assert.strictEqual(recovered.definition.name, "after recovery");
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(recovered.sourceDirectory, "prompt.md")),
        "Original source.",
      );
      const paused = yield* schedules.update(caller, created.id, { enabled: false });
      assert.strictEqual(paused.state, "disabled");
      const restarted = yield* open(schedulesDir);
      assert.deepStrictEqual(yield* restarted.get(caller, created.id), paused);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("gates reads and running cycles on retained enable rollback recovery", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-enable-recovery-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const enabled = path.join(schedulesDir, "enabled");
      const disabled = path.join(schedulesDir, "disabled");
      let rejectCommitAndRollback = true;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          rejectCommitAndRollback &&
          (path.basename(from) === "next.json" ||
            (path.dirname(from) === enabled && path.dirname(to) === disabled))
            ? Effect.fail(permissionDenied("rename", from))
            : fileSystem.rename(from, to),
      });
      const logs = yield* captureLogs();
      yield* Effect.gen(function* () {
        const schedules = yield* open(schedulesDir).pipe(
          Effect.provideService(FileSystem.FileSystem, failingFileSystem),
        );
        const published = yield* Queue.unbounded<string>();
        yield* TestClock.setTime(1_000);
        yield* schedules.start({
          prepare: () => Effect.succeed({ chatId, workspaceId, cwd: AbsolutePath.make(root) }),
          deliver: () => Effect.die("Script must publish without OMP"),
          publish: (_chatId, content) => Queue.offer(published, content).pipe(Effect.asVoid),
          runPrompt: () => Effect.die("Script must not invoke OMP"),
        });
        const created = yield* schedules.create(caller, {
          name: "original",
          enabled: false,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({
            "script.js":
              'process.stdout.write(JSON.stringify({agent:false,content:"original script executed"}));',
          }),
        });
        if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
        const error = yield* schedules
          .update(caller, created.id, { enabled: true, name: "uncommitted" })
          .pipe(Effect.flip);
        assert.strictEqual(error.kind, "io");
        assert.isTrue(yield* fileSystem.exists(path.join(enabled, created.id)));
        const getResult = yield* schedules.get(caller, created.id).pipe(Effect.exit);
        const listResult = yield* schedules.list(caller).pipe(Effect.exit);
        yield* TestClock.adjust("30 seconds");
        const cycleResult = yield* Effect.race(
          awaitLog(logs.events, "cycle").pipe(Effect.as("blocked")),
          Queue.take(published),
        );
        assert.deepStrictEqual(
          { get: getResult._tag, list: listResult._tag, cycle: cycleResult },
          { get: "Failure", list: "Failure", cycle: "blocked" },
        );
        assert.deepStrictEqual(
          yield* fileSystem.readDirectory(path.join(schedulesDir, "runs")),
          [],
        );
        rejectCommitAndRollback = false;
        yield* TestClock.adjust("30 seconds");
        yield* awaitLog(logs.events, "update-recovery");
        assert.deepStrictEqual(yield* schedules.get(caller, created.id), created);
        assert.deepStrictEqual(yield* schedules.list(caller), [created]);
        assert.deepStrictEqual(
          yield* fileSystem.readDirectory(path.join(schedulesDir, "runs")),
          [],
        );
        yield* schedules.update(caller, created.id, { enabled: true });
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual(yield* Queue.take(published), "original script executed");
        const runId = `scheduled-1000-${created.definition.revision}`;
        const run = yield* awaitFinished(
          fileSystem,
          path.join(schedulesDir, "runs", created.id, runId, "run.json"),
        );
        assert.deepStrictEqual(run.state.kind === "finished" && run.state.outcome, {
          kind: "published",
          content: "original script executed",
        });
      }).pipe(Effect.provide(logs.layer));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rolls back a state move when the metadata commit fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-update-rollback-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("unused"),
      };
      yield* bootstrap(storage);
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000101");
      const definition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000102"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      yield* publishDefinition(
        storage,
        id,
        "enabled",
        definition,
        yield* prepareSource(
          { "prompt.md": "original", "lib/helper.js": "export const value = 1;" },
          ["lib"],
        ),
        "original",
      );
      const current = yield* loadSchedule(storage, id);
      if (current === undefined) return yield* Effect.die("Published definition disappeared");
      const updated: Schedule.ScheduleDefinition = {
        ...definition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000103"),
        name: "updated",
      };
      const nextMetadata = path.join(schedulesDir, ".staging", "update-rejected", "next.json");
      const destination = path.join(schedulesDir, "disabled", id);
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          from === nextMetadata && to === path.join(destination, "meta.json")
            ? fileSystem
                .exists(destination)
                .pipe(
                  Effect.flatMap((moved) =>
                    moved
                      ? Effect.fail(permissionDenied("rename", from))
                      : Effect.die("Metadata commit preceded the state move"),
                  ),
                )
            : fileSystem.rename(from, to),
      });
      const error = yield* updateDefinition(
        { ...storage, fileSystem: failingFileSystem },
        current,
        updated,
        "disabled",
        "rejected",
      ).pipe(Effect.flip);
      assert.strictEqual(error.kind, "io");
      const retained = yield* loadSchedule(storage, id);
      assert.strictEqual(retained?.view.kind, "ready");
      if (retained?.view.kind !== "ready") return;
      assert.deepStrictEqual(retained.view.definition, definition);
      assert.strictEqual(retained.view.sourceDirectory, path.join(schedulesDir, "enabled", id));
      assert.isFalse(yield* fileSystem.exists(destination));
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(retained.view.sourceDirectory, "lib/helper.js")),
        "export const value = 1;",
      );
      yield* bootstrap(storage);
      assert.deepStrictEqual((yield* loadSchedule(storage, id))?.view, retained.view);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("recovers an uncommitted moved directory without overwriting edited source", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-update-recovery-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("unused"),
      };
      yield* bootstrap(storage);
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000104");
      const definition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000105"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      yield* publishDefinition(
        storage,
        id,
        "disabled",
        definition,
        yield* prepareSource(
          { "prompt.md": "original", "lib/helper.js": "export const value = 1;" },
          ["lib"],
        ),
        "original",
      );
      const transaction = path.join(schedulesDir, ".staging", "update-crashed");
      const updated: Schedule.ScheduleDefinition = {
        ...definition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000106"),
        name: "uncommitted",
      };
      yield* fileSystem.makeDirectory(transaction);
      yield* fileSystem.writeFileString(
        path.join(transaction, "next.json"),
        JSON.stringify(updated),
      );
      yield* fileSystem.writeFileString(
        path.join(transaction, "transaction.json"),
        JSON.stringify({
          kind: "update",
          id,
          state: "disabled",
          nextState: "enabled",
          revision: updated.revision,
        }),
      );
      const originalDirectory = path.join(schedulesDir, "disabled", id);
      const movedDirectory = path.join(schedulesDir, "enabled", id);
      yield* fileSystem.rename(originalDirectory, movedDirectory);
      yield* fileSystem.writeFileString(
        path.join(movedDirectory, "lib/helper.js"),
        "export const value = 2;",
      );
      const restarted = yield* open(schedulesDir);
      const recovered = yield* restarted.get(caller, id);
      assert.strictEqual(recovered.kind, "ready");
      if (recovered.kind !== "ready") return;
      assert.deepStrictEqual(recovered.definition, definition);
      assert.strictEqual(recovered.sourceDirectory, originalDirectory);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(recovered.sourceDirectory, "lib/helper.js")),
        "export const value = 2;",
      );
      assert.isFalse(yield* fileSystem.exists(movedDirectory));
      assert.isFalse(yield* fileSystem.exists(transaction));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("restores a definition retained by an interrupted pre-upgrade replacement", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-replace-upgrade-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir);
      const created = yield* schedules.create(caller, {
        name: "before upgrade",
        enabled: false,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Retained source." }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const transaction = path.join(schedulesDir, ".staging", "replace-interrupted");
      const next = path.join(transaction, "next");
      yield* fileSystem.makeDirectory(next, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(transaction, "transaction.json"),
        JSON.stringify({ kind: "replace", id: created.id, state: "disabled" }),
      );
      yield* fileSystem.writeFileString(
        path.join(next, "meta.json"),
        JSON.stringify({
          ...created.definition,
          revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000107"),
          name: "uncommitted replacement",
        }),
      );
      yield* fileSystem.writeFileString(path.join(next, "prompt.md"), "Uncommitted source.");
      yield* fileSystem.rename(created.sourceDirectory, path.join(transaction, "previous"));
      const restarted = yield* open(schedulesDir);
      const recovered = yield* restarted.get(caller, created.id);
      assert.deepStrictEqual(recovered, created);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(created.sourceDirectory, "prompt.md")),
        "Retained source.",
      );
      assert.isFalse(yield* fileSystem.exists(transaction));
      const reopened = yield* open(schedulesDir);
      assert.deepStrictEqual(yield* reopened.get(caller, created.id), recovered);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("keeps a committed pre-upgrade replacement after a later pause", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-replace-committed-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir);
      const created = yield* schedules.create(caller, {
        name: "committed replacement",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 10_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Committed source." }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const transaction = path.join(schedulesDir, ".staging", "replace-committed");
      const previous = path.join(transaction, "previous");
      yield* fileSystem.makeDirectory(previous, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(transaction, "transaction.json"),
        JSON.stringify({ kind: "replace", id: created.id, state: "enabled" }),
      );
      yield* fileSystem.writeFileString(
        path.join(previous, "meta.json"),
        JSON.stringify({
          ...created.definition,
          revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000108"),
          name: "old definition",
        }),
      );
      yield* fileSystem.writeFileString(path.join(previous, "prompt.md"), "Old source.");
      const paused = yield* schedules.update(caller, created.id, { enabled: false });
      const restarted = yield* open(schedulesDir);
      const recovered = yield* restarted.get(caller, created.id);
      assert.deepStrictEqual(recovered, paused);
      assert.strictEqual(recovered.kind, "ready");
      if (recovered.kind !== "ready") return yield* Effect.die("Recovered schedule is invalid");
      assert.strictEqual(recovered.state, "disabled");
      assert.deepStrictEqual(recovered.definition, created.definition);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(recovered.sourceDirectory, "prompt.md")),
        "Committed source.",
      );
      assert.isFalse(yield* fileSystem.exists(created.sourceDirectory));
      assert.isFalse(yield* fileSystem.exists(transaction));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "retains the whole legacy replacement transaction when both canonical states exist",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-replace-conflict-",
        });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir);
        const created = yield* schedules.create(caller, {
          name: "conflicted replacement",
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 10_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "Enabled source." }),
        });
        if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
        const disabled = path.join(schedulesDir, "disabled", created.id);
        const transaction = path.join(schedulesDir, ".staging", "replace-conflicted");
        const previous = path.join(transaction, "previous");
        const next = path.join(transaction, "next");
        for (const directory of [disabled, previous, next]) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
        }
        const journal = JSON.stringify({ kind: "replace", id: created.id, state: "enabled" });
        const retained = {
          [path.join(created.sourceDirectory, "prompt.md")]: "Enabled source.",
          [path.join(disabled, "prompt.md")]: "Disabled source.",
          [path.join(previous, "prompt.md")]: "Only retained source.",
          [path.join(next, "prompt.md")]: "Uncommitted source.",
          [path.join(transaction, "transaction.json")]: journal,
        };
        for (const [file, content] of Object.entries(retained)) {
          yield* fileSystem.writeFileString(file, content);
        }
        const error = yield* open(schedulesDir).pipe(Effect.flip);
        assert.strictEqual(error.kind, "corrupt");
        for (const [file, content] of Object.entries(retained)) {
          assert.strictEqual(yield* fileSystem.readFileString(file), content);
        }
        assert.deepStrictEqual((yield* fileSystem.readDirectory(transaction)).sort(), [
          "next",
          "previous",
          "transaction.json",
        ]);
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("retains replacement data when its recovery journal is missing or corrupt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-replace-journal-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      yield* open(schedulesDir);
      const transaction = path.join(schedulesDir, ".staging", "replace-retained");
      const previous = path.join(transaction, "previous");
      yield* fileSystem.makeDirectory(previous, { recursive: true });
      const retained = path.join(previous, "prompt.md");
      yield* fileSystem.writeFileString(retained, "Only retained source.");
      const missing = yield* open(schedulesDir).pipe(Effect.flip);
      assert.strictEqual(missing.kind, "corrupt");
      assert.strictEqual(yield* fileSystem.readFileString(retained), "Only retained source.");
      yield* fileSystem.writeFileString(
        path.join(transaction, "transaction.json"),
        '{"kind":"replace"}',
      );
      const corrupt = yield* open(schedulesDir).pipe(Effect.flip);
      assert.strictEqual(corrupt.kind, "corrupt");
      assert.strictEqual(yield* fileSystem.readFileString(retained), "Only retained source.");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("keeps the canonical event log during an interrupted append", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-append-interrupt-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000047"),
      };
      yield* bootstrap(storage);
      const definition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000048"),
        name: "append interruption",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const run: Schedule.ScheduleRunLifecycle = {
        version: 1,
        id: Schedule.ScheduleRunId.make(`scheduled-1000-${definition.revision}`),
        scheduleId: Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000049"),
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
        yield* prepareSource({ "prompt.md": "append" }),
        "018f47a0-0000-7000-8000-000000000050",
        Effect.void,
      );
      const original = `${JSON.stringify({ type: "run-started" })}\n`;
      yield* writeArtifactString(storage, run, "omp/events.jsonl", original);
      const eventsFile = path.join(
        runDirectory(storage, run.scheduleId, run.id),
        "omp",
        "events.jsonl",
      );
      const appendPrepared = yield* Deferred.make<void>();
      const holdAppend = yield* Deferred.make<void>();
      const interruptedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        copyFile: (from, to) =>
          fileSystem.copyFile(from, to).pipe(
            Effect.tap(() => Deferred.succeed(appendPrepared, undefined)),
            Effect.andThen(Deferred.await(holdAppend)),
          ),
        rename: (from, to) =>
          from === eventsFile && path.basename(to).endsWith(".append")
            ? fileSystem.rename(from, to).pipe(
                Effect.tap(() => Deferred.succeed(appendPrepared, undefined)),
                Effect.andThen(Deferred.await(holdAppend)),
              )
            : fileSystem.rename(from, to),
      });
      const fiber = yield* appendArtifactString(
        { ...storage, fileSystem: interruptedFileSystem },
        run,
        "omp/events.jsonl",
        `${JSON.stringify({ type: "run-finished", outcome: "completed" })}\n`,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(appendPrepared);
      yield* Fiber.interrupt(fiber);

      assert.strictEqual(yield* fileSystem.readFileString(eventsFile), original);
      assert.isFalse(
        (yield* fileSystem.readDirectory(path.dirname(eventsFile))).some((name) =>
          name.endsWith(".append"),
        ),
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("preserves a completed once run when disabling its definition fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-once-disable-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      const logs = yield* captureLogs();
      let rejectedDisable = false;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) => {
          if (
            !rejectedDisable &&
            path.dirname(from) === path.join(schedulesDir, "enabled") &&
            path.dirname(to) === path.join(schedulesDir, "disabled")
          ) {
            rejectedDisable = true;
            return Effect.fail(permissionDenied("rename", from));
          }
          return fileSystem.rename(from, to);
        },
      });
      yield* Effect.gen(function* () {
        const delivered = yield* Deferred.make<void>();
        const schedules = yield* make(schedulesDir);
        const host: Schedule.ScheduleRunHost = {
          prepare: (target) =>
            Effect.succeed({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
          deliver: () => Deferred.succeed(delivered, undefined).pipe(Effect.asVoid),
          publish: () => Effect.die("Agent schedules must deliver their final response"),
          runPrompt: (_target, runId) =>
            Effect.succeed({
              runId,
              outcome: "completed",
              events: [],
              finalAssistantText: "complete",
            }),
        };
        yield* TestClock.setTime(1_000);
        yield* schedules.start(host);
        const created = yield* schedules.create(caller, {
          name: "disable retry",
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "complete once" }),
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        yield* Deferred.await(delivered);
        const runFile = path.join(
          schedulesDir,
          "runs",
          created.id,
          `scheduled-1000-${created.definition.revision}`,
          "run.json",
        );
        const completed = yield* awaitFinished(fileSystem, runFile);
        assert.deepStrictEqual(completed.state.kind === "finished" && completed.state.outcome, {
          kind: "completed",
          finalAssistantText: "complete",
        });
        const disableFailure = yield* awaitLog(logs.events, "disable-after-completion");
        assert.strictEqual(disableFailure.level, "Error");
        assert.strictEqual(disableFailure.annotations.scheduleId, created.id);
        assert.strictEqual(disableFailure.annotations.runId, completed.id);
        assert.strictEqual(disableFailure.annotations.outcome, "completed");
        assert.isTrue(yield* fileSystem.exists(path.join(schedulesDir, "enabled", created.id)));

        yield* TestClock.adjust("30 seconds");
        yield* awaitExists(
          fileSystem,
          path.join(schedulesDir, "disabled", created.id, "meta.json"),
        );
        const retained = yield* awaitFinished(fileSystem, runFile);
        assert.deepStrictEqual(retained.state.kind === "finished" && retained.state.outcome, {
          kind: "completed",
          finalAssistantText: "complete",
        });
      }).pipe(
        Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
        Effect.provide(logs.layer),
      );
      assert.strictEqual(logs.entries.filter((entry) => entry.level === "Error").length, 1);
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("records the active phase for unexpected execution failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-run-phase-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const cwd = AbsolutePath.make(root);
      let rejectedDecision = false;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFile: (file, data, options) => {
          if (!rejectedDecision && path.basename(file).startsWith(".decision.json-")) {
            rejectedDecision = true;
            return Effect.fail(permissionDenied("writeFile", file));
          }
          return fileSystem.writeFile(file, data, options);
        },
      });
      yield* Effect.gen(function* () {
        const schedules = yield* make(schedulesDir);
        const host: Schedule.ScheduleRunHost = {
          prepare: (target) =>
            Effect.succeed({ chatId: target.chatId, workspaceId: target.ownerWorkspaceId, cwd }),
          deliver: () => Effect.die("Protocol failures must not deliver output"),
          publish: () => Effect.die("Protocol failures must not publish output"),
          runPrompt: () => Effect.die("Protocol failures must not invoke OMP"),
        };
        yield* TestClock.setTime(1_000);
        yield* schedules.start(host);
        const created = yield* schedules.create(caller, {
          name: "phase retention",
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "unused" }),
        });
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        yield* TestClock.adjust("30 seconds");
        const failed = yield* awaitFinished(
          fileSystem,
          path.join(
            schedulesDir,
            "runs",
            created.id,
            `scheduled-1000-${created.definition.revision}`,
            "run.json",
          ),
        );
        assert.deepInclude(failed.state.kind === "finished" ? failed.state.outcome : {}, {
          kind: "failed",
          stage: "protocol",
        });
      }).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("rejects staging symlinks without writing outside schedule storage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-staging-symlink-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const outside = path.join(root, "outside");
      const sentinel = path.join(outside, "sentinel");
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000060"),
      };
      const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000061");
      const definition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000062"),
        name: "original",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const source = yield* prepareSource({ "prompt.md": "original" });
      const staging = path.join(schedulesDir, ".staging");
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.writeFileString(sentinel, "unchanged");
      yield* bootstrap(storage);

      const definitionTransaction = path.join(staging, "definition-preexisting");
      yield* fileSystem.symlink(outside, definitionTransaction);
      const definitionError = yield* publishDefinition(
        storage,
        id,
        "enabled",
        definition,
        source,
        "preexisting",
      ).pipe(Effect.flip);
      assert.strictEqual(definitionError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      assert.isFalse(yield* fileSystem.exists(path.join(schedulesDir, "enabled", id)));
      yield* fileSystem.remove(definitionTransaction);

      yield* publishDefinition(storage, id, "enabled", definition, source, "original");
      const current = yield* loadSchedule(storage, id);
      if (current === undefined) return yield* Effect.die("Published definition disappeared");
      const replacement: Schedule.ScheduleDefinition = {
        ...definition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000063"),
        name: "replacement",
      };
      const updateTransaction = path.join(staging, "update-preexisting");
      yield* fileSystem.symlink(outside, updateTransaction);
      const updateError = yield* updateDefinition(
        storage,
        current,
        replacement,
        "disabled",
        "preexisting",
      ).pipe(Effect.flip);
      assert.strictEqual(updateError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      const retained = yield* loadSchedule(storage, id);
      assert.strictEqual(retained?.view.kind, "ready");
      if (retained?.view.kind !== "ready") return;
      assert.strictEqual(retained.view.definition.revision, definition.revision);
      yield* fileSystem.remove(updateTransaction);

      yield* fileSystem.remove(staging, { recursive: true });
      yield* fileSystem.symlink(outside, staging);
      const parentError = yield* publishDefinition(
        storage,
        Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000064"),
        "enabled",
        definition,
        source,
        "parent-replaced",
      ).pipe(Effect.flip);
      assert.strictEqual(parentError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      yield* fileSystem.remove(staging);
      yield* fileSystem.makeDirectory(staging, { mode: 0o700 });

      const run: Schedule.ScheduleRunLifecycle = {
        version: 1,
        id: Schedule.ScheduleRunId.make(`scheduled-1000-${definition.revision}`),
        scheduleId: id,
        definitionRevision: definition.revision,
        source: { kind: "scheduled", scheduledFor: 1_000 },
        plannedTarget: { kind: "existing-chat", ownerWorkspaceId: workspaceId, chatId },
        claimedAt: 1_000,
        state: { kind: "claimed" },
      };
      const runTransaction = path.join(staging, "run-preexisting");
      yield* fileSystem.symlink(outside, runTransaction);
      const runError = yield* publishRun(
        storage,
        run,
        definition,
        source,
        "preexisting",
        Effect.void,
      ).pipe(Effect.flip);
      assert.strictEqual(runError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      assert.isFalse(yield* fileSystem.exists(runDirectory(storage, id, run.id)));
      yield* fileSystem.remove(runTransaction);

      const inputTransactionId = "input-preexisting";
      const inputTransaction = path.join(staging, `run-${inputTransactionId}`);
      const input = path.join(inputTransaction, "input");
      const injectedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        makeDirectory: (directory, options) =>
          fileSystem
            .makeDirectory(directory, options)
            .pipe(
              Effect.tap(() =>
                directory === inputTransaction ? fileSystem.symlink(outside, input) : Effect.void,
              ),
            ),
      });
      const inputError = yield* publishRun(
        { ...storage, fileSystem: injectedFileSystem },
        run,
        definition,
        source,
        inputTransactionId,
        Effect.void,
      ).pipe(Effect.flip);
      assert.strictEqual(inputError.kind, "corrupt");
      assert.deepStrictEqual(yield* fileSystem.readDirectory(outside), ["sentinel"]);
      assert.isFalse(yield* fileSystem.exists(runDirectory(storage, id, run.id)));
      const canonical = yield* loadSchedule(storage, id);
      assert.strictEqual(canonical?.view.kind, "ready");
      if (canonical?.view.kind === "ready") {
        assert.strictEqual(canonical.view.definition.revision, definition.revision);
      }
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  for (const phase of ["definition", "run"]) {
    it.effect(`interrupts ${phase} capture between copies after the active callback settles`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-capture-shutdown-",
        });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const copyStarted = yield* Deferred.make<{
          readonly from: string;
          readonly to: string;
          readonly resume: (effect: Effect.Effect<void, PlatformError.PlatformError>) => void;
        }>();
        const events: Array<string> = [];
        const copies: Array<string> = [];
        let capturing = false;
        const gatedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          copyFile: (from, to) =>
            Effect.suspend(() => {
              if (!capturing) return fileSystem.copyFile(from, to);
              copies.push(from);
              if (copies.length !== 1) return fileSystem.copyFile(from, to);
              return Effect.callback<void, PlatformError.PlatformError>((resume) => {
                events.push("copy-started");
                Deferred.doneUnsafe(copyStarted, Effect.succeed({ from, to, resume }));
              });
            }),
          remove: (file, options) =>
            Effect.suspend(() => {
              if (capturing && path.dirname(file) === path.join(schedulesDir, ".staging")) {
                events.push("staging-removed");
              }
              return fileSystem.remove(file, options);
            }),
        });
        const schedules = yield* open(schedulesDir).pipe(
          Effect.provideService(FileSystem.FileSystem, gatedFileSystem),
        );
        const sourceDirectory = yield* prepareSource({
          "prompt.md": "Do not execute.",
          "first.bin": new Uint8Array([0, 255, 128]),
          "last.bin": new Uint8Array([7, 8, 9]),
        });
        const input: Schedule.CreateSchedule = {
          name: "interrupted capture",
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory,
        };
        if (phase === "run") yield* schedules.create(caller, input);
        let prepared = 0;
        let prompts = 0;
        const host: Schedule.ScheduleRunHost = {
          prepare: () =>
            Effect.sync(() => {
              prepared++;
              return { chatId, workspaceId, cwd: AbsolutePath.make(root) };
            }),
          deliver: () => Effect.void,
          publish: () => Effect.void,
          runPrompt: (_chatId, runId) =>
            Effect.sync(() => {
              prompts++;
              return { runId, outcome: "completed", events: [], finalAssistantText: "unexpected" };
            }),
        };
        yield* TestClock.setTime(1_000);
        capturing = true;
        const operation = yield* (
          phase === "definition"
            ? schedules.create(caller, input).pipe(Effect.asVoid)
            : schedules.start(host)
        ).pipe(Effect.scoped, Effect.forkChild);
        const active = yield* Deferred.await(copyStarted);
        const shutdown = yield* Fiber.interrupt(operation).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const copied = yield* fileSystem.copyFile(active.from, active.to).pipe(Effect.exit);
        events.push("copy-settled");
        active.resume(copied);
        yield* Fiber.join(shutdown);
        const stopped = yield* Fiber.await(operation);
        assert.isTrue(Exit.isFailure(stopped) && Cause.hasInterruptsOnly(stopped.cause));
        assert.deepStrictEqual(events, ["copy-started", "copy-settled", "staging-removed"]);
        assert.isTrue(Exit.isSuccess(copied));
        assert.strictEqual(copies.length, 1);
        assert.strictEqual(prepared, 0);
        assert.strictEqual(prompts, 0);
        assert.deepStrictEqual(
          yield* fileSystem.readDirectory(path.join(schedulesDir, ".staging")),
          [],
        );
        assert.deepStrictEqual(
          yield* fileSystem.readDirectory(path.join(schedulesDir, "runs")),
          [],
        );
        if (phase === "definition") {
          assert.deepStrictEqual(yield* schedules.list(caller), []);
        }
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(sourceDirectory, "prompt.md")),
          "Do not execute.",
        );
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
    );
  }

  it.effect("owns a run published while interruption is pending at the rename callback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-claim-handoff-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const publishing = yield* Deferred.make<{
        readonly from: string;
        readonly to: string;
        readonly resume: (effect: Effect.Effect<void, PlatformError.PlatformError>) => void;
      }>();
      const gatedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          path.dirname(from) === path.join(schedulesDir, ".staging") &&
          path.basename(from).startsWith("run-")
            ? Effect.callback<void, PlatformError.PlatformError>((resume) => {
                Deferred.doneUnsafe(publishing, Effect.succeed({ from, to, resume }));
              })
            : fileSystem.rename(from, to),
      });
      const schedules = yield* open(schedulesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, gatedFileSystem),
      );
      yield* schedules.create(caller, {
        name: "publication handoff",
        enabled: true,
        target: { kind: "current-chat" },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "Do not execute." }),
      });
      let prompts = 0;
      yield* TestClock.setTime(1_000);
      const operation = yield* schedules
        .start({
          prepare: () => Effect.succeed({ chatId, workspaceId, cwd: AbsolutePath.make(root) }),
          deliver: () => Effect.void,
          publish: () => Effect.void,
          runPrompt: (_chatId, runId) =>
            Effect.sync(() => {
              prompts++;
              return { runId, outcome: "completed", events: [], finalAssistantText: "unexpected" };
            }),
        })
        .pipe(Effect.scoped, Effect.forkChild);
      const active = yield* Deferred.await(publishing);
      const shutdown = yield* Fiber.interrupt(operation).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const renamed = yield* fileSystem.rename(active.from, active.to).pipe(Effect.exit);
      active.resume(renamed);
      yield* Fiber.join(shutdown);
      assert.isTrue(Exit.isSuccess(renamed));
      const stopped = yield* Fiber.await(operation);
      assert.isTrue(Exit.isFailure(stopped) && Cause.hasInterruptsOnly(stopped.cause));
      const run = yield* decodeRun(
        yield* fileSystem.readFileString(path.join(active.to, "run.json")),
      );
      assert.deepStrictEqual(run.state.kind === "finished" && run.state.outcome, {
        kind: "interrupted",
        phase: "schedule-cycle",
      });
      assert.strictEqual(prompts, 0);
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, ".staging")),
        [],
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("terminalizes an earlier claim when a later schedule history read fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-cycle-read-failure-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000070"),
      };
      const firstId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000071");
      const secondId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000072");
      const firstDefinition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000073"),
        name: "first",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const secondDefinition: Schedule.ScheduleDefinition = {
        ...firstDefinition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000074"),
        name: "second",
      };
      yield* bootstrap(storage);
      yield* publishDefinition(
        storage,
        firstId,
        "enabled",
        firstDefinition,
        yield* prepareSource({ "prompt.md": "first" }),
        "first-definition",
      );
      yield* publishDefinition(
        storage,
        secondId,
        "enabled",
        secondDefinition,
        yield* prepareSource({ "prompt.md": "second" }),
        "second-definition",
      );
      const firstRunId = Schedule.ScheduleRunId.make(`scheduled-1000-${firstDefinition.revision}`);
      const firstRunDirectory = runDirectory(storage, firstId, firstRunId);
      const secondRuns = path.join(schedulesDir, "runs", secondId);
      yield* fileSystem.makeDirectory(secondRuns);
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readDirectory: (directory) =>
          directory === secondRuns
            ? fileSystem
                .exists(firstRunDirectory)
                .pipe(
                  Effect.flatMap((firstClaimed) =>
                    firstClaimed
                      ? Effect.fail(permissionDenied("readDirectory", directory))
                      : fileSystem.readDirectory(directory),
                  ),
                )
            : fileSystem.readDirectory(directory),
      });

      yield* Effect.gen(function* () {
        const schedules = yield* make(schedulesDir);
        const host: Schedule.ScheduleRunHost = {
          prepare: () => Effect.die("Claimed runs must not dispatch after the scan fails"),
          deliver: () => Effect.die("Claimed runs must not dispatch after the scan fails"),
          publish: () => Effect.die("Claimed runs must not dispatch after the scan fails"),
          runPrompt: () => Effect.die("Claimed runs must not dispatch after the scan fails"),
        };
        yield* TestClock.setTime(1_000);
        yield* schedules.start(host);
        const terminal = yield* awaitFinished(fileSystem, path.join(firstRunDirectory, "run.json"));
        assert.deepStrictEqual(terminal.state.kind === "finished" && terminal.state.outcome, {
          kind: "interrupted",
          phase: "schedule-cycle",
        });
        assert.deepStrictEqual(yield* fileSystem.readDirectory(secondRuns), []);
      }).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("terminalizes every missed claim when one finalization fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-cycle-missed-failure-",
      });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("018f47a0-0000-7000-8000-000000000080"),
      };
      const firstId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000081");
      const secondId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000082");
      const firstDefinition: Schedule.ScheduleDefinition = {
        version: 1,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000083"),
        name: "first missed",
        ownerWorkspaceId: workspaceId,
        createdByChatId: chatId,
        createdAt: 0,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
      };
      const secondDefinition: Schedule.ScheduleDefinition = {
        ...firstDefinition,
        revision: Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000084"),
        name: "second missed",
      };
      yield* bootstrap(storage);
      yield* publishDefinition(
        storage,
        firstId,
        "enabled",
        firstDefinition,
        yield* prepareSource({ "prompt.md": "first" }),
        "first-missed-definition",
      );
      yield* publishDefinition(
        storage,
        secondId,
        "enabled",
        secondDefinition,
        yield* prepareSource({ "prompt.md": "second" }),
        "second-missed-definition",
      );
      const firstRunId = Schedule.ScheduleRunId.make(`scheduled-1000-${firstDefinition.revision}`);
      const secondRunId = Schedule.ScheduleRunId.make(
        `scheduled-1000-${secondDefinition.revision}`,
      );
      const firstRunFile = path.join(runDirectory(storage, firstId, firstRunId), "run.json");
      const secondRunFile = path.join(runDirectory(storage, secondId, secondRunId), "run.json");
      let rejectedFinalization = false;
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) => {
          if (
            !rejectedFinalization &&
            to === firstRunFile &&
            path.basename(from).startsWith(".run.json-")
          ) {
            rejectedFinalization = true;
            return Effect.fail(permissionDenied("rename", from));
          }
          return fileSystem.rename(from, to);
        },
      });

      yield* Effect.gen(function* () {
        const schedules = yield* make(schedulesDir);
        const host: Schedule.ScheduleRunHost = {
          prepare: () => Effect.die("Missed runs must not dispatch"),
          deliver: () => Effect.die("Missed runs must not dispatch"),
          publish: () => Effect.die("Missed runs must not dispatch"),
          runPrompt: () => Effect.die("Missed runs must not dispatch"),
        };
        yield* TestClock.setTime(3 * 60 * 60 * 1_000);
        yield* schedules.start(host);
        const first = yield* awaitFinished(fileSystem, firstRunFile);
        const second = yield* awaitFinished(fileSystem, secondRunFile);
        for (const terminal of [first, second]) {
          assert.deepStrictEqual(terminal.state.kind === "finished" && terminal.state.outcome, {
            kind: "interrupted",
            phase: "schedule-cycle",
          });
        }
      }).pipe(Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("reports a primary run failure once when finalization also fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-run-finalizer-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const logs = yield* captureLogs();
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          path.basename(to) === "run.json"
            ? Effect.fail(permissionDenied("rename", from))
            : fileSystem.rename(from, to),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const schedules = yield* make(schedulesDir);
          yield* TestClock.setTime(1_000);
          yield* schedules.start({
            prepare: () =>
              Effect.fail(new Schedule.ScheduleHostError({ message: "private target detail" })),
            deliver: () => Effect.die("Failed targets cannot deliver"),
            publish: () => Effect.die("Failed targets cannot publish"),
            runPrompt: () => Effect.die("Failed targets cannot run"),
          });
          const created = yield* schedules.create(caller, {
            name: "private schedule name",
            enabled: true,
            target: { kind: "current-chat" },
            trigger: { kind: "once", at: 1_000 },
            sourceDirectory: yield* prepareSource({ "prompt.md": "private prompt" }),
          });
          assert.strictEqual(created.kind, "ready");
          if (created.kind !== "ready") return;
          const finalized = yield* awaitLog(logs.events, "finalize");
          const runId = `scheduled-1000-${created.definition.revision}`;
          assert.strictEqual(finalized.annotations.runId, runId);
          const failures = logs.entries.filter((entry) => entry.level === "Error");
          assert.deepStrictEqual(
            failures.map((entry) => entry.annotations.phase),
            ["target", "finalize"],
          );
          assert.isTrue(failures.every((entry) => entry.annotations.scheduleId === created.id));
          assert.strictEqual(failures[0]?.annotations.outcome, "failed");
          assert.strictEqual(failures[0]?.annotations.persisted, false);
          const durable = yield* fileSystem
            .readFileString(path.join(schedulesDir, "runs", created.id, runId, "run.json"))
            .pipe(Effect.flatMap(decodeRun));
          assert.strictEqual(durable.state.kind, "claimed");
        }),
      ).pipe(
        Effect.provide(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
        Effect.provide(logs.layer),
      );
      assert.strictEqual(logs.entries.filter((entry) => entry.level === "Error").length, 2);
      assert.notInclude(JSON.stringify(logs.entries), "private");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "terminalizes and reports a detached execution defect without exposing its contents",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-run-defect-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const logs = yield* captureLogs();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const schedules = yield* make(schedulesDir);
            yield* TestClock.setTime(1_000);
            yield* schedules.start({
              prepare: () => Effect.die(new Error("private SDK payload")),
              deliver: () => Effect.die("Failed targets cannot deliver"),
              publish: () => Effect.die("Failed targets cannot publish"),
              runPrompt: () => Effect.die("Failed targets cannot run"),
            });
            const created = yield* schedules.create(caller, {
              name: "defect",
              enabled: true,
              target: { kind: "current-chat" },
              trigger: { kind: "once", at: 1_000 },
              sourceDirectory: yield* prepareSource({ "prompt.md": "private prompt" }),
            });
            assert.strictEqual(created.kind, "ready");
            if (created.kind !== "ready") return;
            const terminal = yield* awaitLog(logs.events, "target");
            assert.strictEqual(terminal.level, "Error");
            assert.strictEqual(terminal.annotations.category, "defect");
            const durable = yield* awaitFinished(
              fileSystem,
              path.join(
                schedulesDir,
                "runs",
                created.id,
                `scheduled-1000-${created.definition.revision}`,
                "run.json",
              ),
            );
            assert.deepInclude(durable.state.kind === "finished" ? durable.state.outcome : {}, {
              kind: "failed",
              stage: "target",
            });
          }),
        ).pipe(Effect.provide(logs.layer));
        assert.strictEqual(logs.entries.filter((entry) => entry.level === "Error").length, 1);
        assert.notInclude(JSON.stringify(logs.entries), "private");
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("keeps user aborts and scheduler interruption out of error logs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-run-cancel-" });
      const logs = yield* captureLogs();
      for (const mode of ["aborted", "interrupted"] as const) {
        const schedulesDir = AbsolutePath.make(path.join(root, mode));
        const started = yield* Deferred.make<void>();
        const created = yield* Effect.scoped(
          Effect.gen(function* () {
            const schedules = yield* make(schedulesDir);
            yield* TestClock.setTime(1_000);
            yield* schedules.start({
              prepare: (target) =>
                Effect.succeed({
                  chatId: target.chatId,
                  workspaceId: target.ownerWorkspaceId,
                  cwd: AbsolutePath.make(root),
                }),
              deliver: () => Effect.die("Cancelled runs cannot deliver"),
              publish: () => Effect.die("Cancelled runs cannot publish"),
              runPrompt: (_chatId, runId) =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(
                    mode === "interrupted"
                      ? Effect.never
                      : Effect.succeed({
                          runId,
                          outcome: "aborted",
                          events: [],
                          finalAssistantText: "",
                        } satisfies CapturedAgentRun),
                  ),
                ),
            });
            const created = yield* schedules.create(caller, {
              name: mode,
              enabled: true,
              target: { kind: "current-chat" },
              trigger: { kind: "once", at: 1_000 },
              sourceDirectory: yield* prepareSource({ "prompt.md": "private cancellation prompt" }),
            });
            yield* Deferred.await(started);
            if (mode === "aborted") yield* awaitLog(logs.events, "omp");
            return created;
          }),
        ).pipe(Effect.provide(logs.layer));
        assert.strictEqual(created.kind, "ready");
        if (created.kind !== "ready") return;
        const durable = yield* awaitFinished(
          fileSystem,
          path.join(
            schedulesDir,
            "runs",
            created.id,
            `scheduled-1000-${created.definition.revision}`,
            "run.json",
          ),
        );
        assert.deepInclude(durable.state.kind === "finished" ? durable.state.outcome : {}, {
          kind: mode === "aborted" ? "failed" : "interrupted",
        });
      }
      assert.deepStrictEqual(
        logs.entries.filter((entry) => entry.level === "Error"),
        [],
      );
      assert.notInclude(JSON.stringify(logs.entries), "private");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "discards journal-free staging but retains corrupt and unreadable update journals",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "pico-recovery-journal-",
        });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const storage: Storage = {
          fileSystem,
          path,
          schedulesDir,
          temporaryId: () => Effect.succeed("unused"),
        };
        const logs = yield* captureLogs();
        yield* bootstrap(storage);
        const abandoned = path.join(schedulesDir, ".staging", "update-abandoned");
        yield* fileSystem.makeDirectory(abandoned);
        yield* fileSystem.writeFileString(
          path.join(abandoned, "next.json"),
          "uncommitted metadata",
        );
        yield* bootstrap(storage).pipe(Effect.provide(logs.layer));
        assert.isFalse(yield* fileSystem.exists(abandoned));
        assert.deepStrictEqual(
          logs.entries.filter((entry) => entry.level === "Error"),
          [],
        );

        const copiedSource = path.join(schedulesDir, ".staging", "definition-abandoned");
        yield* fileSystem.makeDirectory(path.join(copiedSource, "previous"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(copiedSource, "prompt.md"), "authored prompt");
        yield* fileSystem.writeFileString(
          path.join(copiedSource, "transaction.json"),
          '{"helper":true}',
        );
        yield* bootstrap(storage);
        assert.isFalse(yield* fileSystem.exists(copiedSource));

        const transaction = path.join(schedulesDir, ".staging", "update-broken");
        const journal = path.join(transaction, "transaction.json");
        const retained = path.join(transaction, "next.json");
        yield* fileSystem.makeDirectory(transaction);
        yield* fileSystem.writeFileString(retained, "retained definition");
        yield* fileSystem.writeFileString(journal, '{"private":"corrupt journal"}');
        const corrupt = yield* bootstrap(storage).pipe(Effect.flip);
        assert.strictEqual(corrupt.kind, "corrupt");
        assert.strictEqual(yield* fileSystem.readFileString(retained), "retained definition");
        assert.strictEqual(
          yield* fileSystem.readFileString(journal),
          '{"private":"corrupt journal"}',
        );
        const unreadable = yield* bootstrap({
          ...storage,
          fileSystem: FileSystem.FileSystem.of({
            ...fileSystem,
            readFileString: (file, encoding) =>
              file === journal
                ? Effect.fail(permissionDenied("readFileString", file))
                : fileSystem.readFileString(file, encoding),
          }),
        }).pipe(Effect.flip);
        assert.strictEqual(unreadable.kind, "io");
        assert.strictEqual(yield* fileSystem.readFileString(retained), "retained definition");
        assert.isTrue(yield* fileSystem.exists(journal));
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
  it.effect("warns again only after an invalid definition returns to a valid state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-invalid-scan-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const logs = yield* captureLogs();
      const scans = yield* Queue.unbounded<void>();
      let observeScans = false;
      const observedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readDirectory: (directory) =>
          fileSystem
            .readDirectory(directory)
            .pipe(
              Effect.tap(() =>
                observeScans && directory === path.join(schedulesDir, "disabled")
                  ? Queue.offer(scans, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const schedules = yield* open(schedulesDir);
          const created = yield* schedules.create(caller, {
            name: "invalid definition",
            enabled: false,
            target: { kind: "current-chat" },
            trigger: { kind: "once", at: 1_000 },
            sourceDirectory: yield* prepareSource({ "prompt.md": "private prompt" }),
          });
          assert.strictEqual(created.kind, "ready");
          if (created.kind !== "ready") return;
          const metadata = path.join(schedulesDir, "disabled", created.id, "meta.json");
          const validSource = yield* fileSystem.readFileString(metadata);
          yield* fileSystem.writeFileString(metadata, '{"private":"invalid metadata"}');
          yield* schedules.start({
            prepare: () => Effect.die("Disabled schedules cannot execute"),
            deliver: () => Effect.die("Disabled schedules cannot execute"),
            publish: () => Effect.die("Disabled schedules cannot execute"),
            runPrompt: () => Effect.die("Disabled schedules cannot execute"),
          });
          const invalid = yield* awaitLog(logs.events, "definition");
          assert.strictEqual(invalid.level, "Warn");
          assert.strictEqual(invalid.annotations.scheduleId, created.id);
          observeScans = true;
          const advanceScan = Effect.gen(function* () {
            yield* TestClock.adjust("30 seconds");
            yield* Queue.take(scans);
            yield* schedules.update(caller, created.id, { enabled: false }).pipe(Effect.exit);
          });
          yield* advanceScan;
          yield* advanceScan;
          assert.strictEqual(
            logs.entries.filter((entry) => entry.annotations.phase === "definition").length,
            1,
          );
          yield* fileSystem.writeFileString(metadata, validSource);
          yield* advanceScan;
          yield* fileSystem.writeFileString(metadata, '{"private":"invalid again"}');
          yield* advanceScan;
          yield* awaitLog(logs.events, "definition");
        }),
      ).pipe(
        Effect.provide(logs.layer),
        Effect.provideService(FileSystem.FileSystem, observedFileSystem),
      );
      assert.strictEqual(
        logs.entries.filter((entry) => entry.annotations.phase === "definition").length,
        2,
      );
      assert.notInclude(JSON.stringify(logs.entries), "private");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
