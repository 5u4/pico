import { assert, describe, it } from "@effect/vitest";
import type * as Agent from "@pico/contract/agent-message";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { publishRun, readRuns } from "./run-storage.ts";
import { open } from "./schedule.ts";
import {
  awaitFinished,
  caller,
  capturedRun,
  chatId,
  decodeDefinition,
  permissionDenied,
  platformLayer,
  prepareSource,
  resolveTarget,
  textPrompt,
  workspaceId,
} from "./schedule-test-fixtures.ts";
import type { Storage } from "./storage.ts";

const defaultScriptTarget = (target: Schedule.ScheduleTarget) =>
  Effect.succeed(
    target.kind === "chat"
      ? ({ kind: "existing-chat", workspaceId } satisfies Schedule.ScheduleScriptTarget)
      : ({
          kind: "workspace-chat",
          workspaceId: target.workspaceId,
        } satisfies Schedule.ScheduleScriptTarget),
  );

const resolveMaterializedTarget = (
  destination: Schedule.ScheduleRunDestination,
  cwd: AbsolutePath,
): Schedule.ResolvedScheduleRunTarget => ({
  chatId: destination.kind === "chat" ? destination.chatId : destination.newChatId,
  workspaceId: destination.kind === "chat" ? workspaceId : destination.workspaceId,
  cwd,
});

describe("source files", () => {
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
        const schedules = yield* open(schedulesDir, resolveTarget).pipe(
          Effect.provideService(FileSystem.FileSystem, guardedFileSystem),
        );
        const asset = new Uint8Array([0, 255, 128, 10]);
        const created = yield* schedules.create(caller, {
          name: "native copying",
          enabled: true,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({
            "script.js": [
              'import { content } from "./lib/helper.js";',
              'import { readFileSync, writeFileSync } from "node:fs";',
              'const bytes = readFileSync("./assets/data.bin");',
              'writeFileSync("./prompt.md", "script changed prompt");',
              'writeFileSync("./cwd.txt", process.cwd());',
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
          scriptTarget: defaultScriptTarget,
          resolveTarget,
          materialize: ({ destination }) =>
            Effect.succeed(resolveMaterializedTarget(destination, AbsolutePath.make(root))),
          deliver: () => Effect.void,
          publish: () => Effect.die("Expected an agent request"),
          runPrompt: (_chatId, runId, request) =>
            Queue.offer(requests, request).pipe(Effect.as(capturedRun(runId, "done"))),
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
        const scriptCwd = yield* fileSystem.readFileString(
          path.join(directory, "input", "cwd.txt"),
        );
        assert.strictEqual(
          yield* fileSystem.realPath(scriptCwd),
          yield* fileSystem.realPath(path.join(directory, "input")),
        );
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(created.sourceDirectory, "prompt.md")),
          "original prompt",
        );
        assert.isFalse(yield* fileSystem.exists(path.join(root, "prompt.md")));
        assert.isFalse(yield* fileSystem.exists(path.join(root, "cwd.txt")));
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("keeps script outputs separate from run metadata across restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-run-metadata-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir, resolveTarget);
      const created = yield* schedules.create(caller, {
        name: "metadata collision",
        enabled: true,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({
          "script.js": [
            'import { writeFileSync } from "node:fs";',
            'writeFileSync("definition.json", "script output");',
            "process.stdout.write(JSON.stringify({agent:false}));",
          ].join("\n"),
        }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      const runId = `scheduled-1000-${created.definition.revision}`;
      const directory = path.join(schedulesDir, "runs", created.id, runId);
      const host: Schedule.ScheduleRunHost = {
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: () => Effect.die("Unexpected materialization"),
        deliver: () => Effect.die("Unexpected delivery"),
        publish: () => Effect.die("Unexpected publication"),
        runPrompt: () => Effect.die("Unexpected agent request"),
      };
      yield* TestClock.setTime(1_000);
      yield* Effect.gen(function* () {
        yield* schedules.start(host);
        const finished = yield* awaitFinished(fileSystem, path.join(directory, "run.json"));
        assert.strictEqual(
          finished.state.kind === "finished" && finished.state.outcome.kind,
          "skipped",
        );
      }).pipe(Effect.scoped);
      for (let restart = 0; restart < 2; restart++) {
        yield* Effect.gen(function* () {
          const reopened = yield* open(schedulesDir, resolveTarget);
          yield* reopened.start(host);
          assert.strictEqual(
            yield* fileSystem.readFileString(path.join(directory, "input", "definition.json")),
            "script output",
          );
        }).pipe(Effect.scoped);
      }
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect.each([
    "definition.json",
    "Definition.json",
    "definition.json/data.bin",
    "Definition.json/data.bin",
  ])("preserves authored %s through managed sources and run capture", (asset) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-definition-" });
      const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
      const schedules = yield* open(schedulesDir, resolveTarget);
      const bytes = new Uint8Array([0, 255, 128, 10]);
      const created = yield* schedules.create(caller, {
        name: "definition source asset",
        enabled: false,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: yield* prepareSource({ "prompt.md": "asset prompt", [asset]: bytes }),
      });
      if (created.kind !== "ready") return yield* Effect.die("Created schedule is invalid");
      assert.deepStrictEqual(
        yield* fileSystem.readFile(path.join(created.sourceDirectory, asset)),
        bytes,
      );
      assert.deepStrictEqual(yield* schedules.get(caller, created.id), created);
      const storage: Storage = {
        fileSystem,
        path,
        schedulesDir,
        temporaryId: () => Effect.succeed("source-definition"),
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
      yield* publishRun(
        storage,
        run,
        created.definition,
        created.sourceDirectory,
        "source-definition",
        () => Effect.void,
      );
      const directory = path.join(schedulesDir, "runs", run.scheduleId, run.id);
      assert.deepStrictEqual(
        yield* fileSystem.readFile(path.join(directory, "input", asset)),
        bytes,
      );
      assert.deepStrictEqual(
        yield* decodeDefinition(
          yield* fileSystem.readFileString(path.join(directory, "definition.json")),
        ),
        created.definition,
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
      const schedules = yield* open(schedulesDir, resolveTarget);
      const created = yield* schedules.create(caller, {
        name: "source contains aliased storage",
        enabled: false,
        target: { kind: "chat", chatId: caller.chatId },
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
          const schedules = yield* open(schedulesDir, resolveTarget).pipe(
            Effect.provideService(FileSystem.FileSystem, collisionFileSystem),
          );
          const error = yield* schedules
            .create(caller, {
              name: `${first} collides with ${second}`,
              enabled: false,
              target: { kind: "chat", chatId: caller.chatId },
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
      const schedules = yield* open(schedulesDir, resolveTarget).pipe(
        Effect.provideService(FileSystem.FileSystem, stagedFileSystem),
      );
      const sourceDirectory = yield* prepareSource({ "prompt.md": "valid original prompt" });
      const input: Schedule.CreateSchedule = {
        name: "staged validation",
        enabled: true,
        target: { kind: "chat", chatId: caller.chatId },
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
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: ({ destination }) =>
          Effect.succeed(resolveMaterializedTarget(destination, AbsolutePath.make(root))),
        deliver: () => Effect.void,
        publish: () => Effect.die("Expected an agent request"),
        runPrompt: (_chatId, runId, request) =>
          Queue.offer(requests, request).pipe(Effect.as(capturedRun(runId, "done"))),
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
      const schedules = yield* open(schedulesDir, resolveTarget).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
      const error = yield* schedules
        .create(caller, {
          name: "staging inspection",
          enabled: false,
          target: { kind: "chat", chatId: caller.chatId },
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
        const schedules = yield* open(schedulesDir, resolveTarget);
        const created = yield* schedules.create(caller, {
          name: "ancestor source",
          enabled: false,
          target: { kind: "chat", chatId: caller.chatId },
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
      const schedules = yield* open(schedulesDir, resolveTarget).pipe(
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
          target: { kind: "chat", chatId: caller.chatId },
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
        scriptTarget: defaultScriptTarget,
        resolveTarget,
        materialize: () => Effect.die("Disabled and non-due schedules must not execute"),
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
      const schedules = yield* open(schedulesDir, resolveTarget).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
      );
      const input: Schedule.CreateSchedule = {
        name: "source resolution",
        enabled: false,
        target: { kind: "chat", chatId: caller.chatId },
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

  it.effect(
    "rejects authored source symlinks, reserved names, and missing or blank entrypoints",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-unsafe-" });
        const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
        const schedules = yield* open(schedulesDir, resolveTarget);
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
          yield* prepareSource({ "prompt.md": "valid" }, ["meta.json"]),
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
              target: { kind: "chat", chatId: caller.chatId },
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
        const schedules = yield* open(
          AbsolutePath.make(path.join(root, "schedules")),
          resolveTarget,
        );
        const error = yield* schedules
          .create(caller, {
            name: "malformed entrypoint",
            enabled: false,
            target: { kind: "chat", chatId: caller.chatId },
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
        const schedules = yield* open(
          AbsolutePath.make(path.join(root, "schedules")),
          resolveTarget,
        );
        const created = yield* schedules.create(caller, {
          name: "repairable entrypoint",
          enabled: false,
          target: { kind: "chat", chatId: caller.chatId },
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

  it.effect("rejects authored Meta.json before publishing metadata", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-source-reserved-" });
      const schedules = yield* open(AbsolutePath.make(path.join(root, "schedules")), resolveTarget);
      const error = yield* schedules
        .create(caller, {
          name: "reserved source",
          enabled: false,
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory: yield* prepareSource({ "prompt.md": "valid", "Meta.json": "{}" }),
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
      const schedules = yield* open(schedulesDir, resolveTarget);
      const created = yield* schedules.create(caller, {
        name: "managed metadata",
        enabled: false,
        target: { kind: "chat", chatId: caller.chatId },
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
        () => Effect.void,
      ).pipe(Effect.flip);
      assert.strictEqual(error.kind, "invalid");
      assert.deepStrictEqual(yield* readRuns(storage), []);
      assert.deepStrictEqual(
        yield* fileSystem.readDirectory(path.join(schedulesDir, ".staging")),
        [],
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects dangling helper links added to owned sources", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-owned-source-unsafe-",
      });
      const schedules = yield* open(AbsolutePath.make(path.join(root, "schedules")), resolveTarget);
      const created = yield* schedules.create(caller, {
        name: "owned source",
        enabled: false,
        target: { kind: "chat", chatId: caller.chatId },
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
        const schedules = yield* open(schedulesDir, resolveTarget).pipe(
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
          target: { kind: "chat", chatId: caller.chatId },
          trigger: { kind: "once", at: 1_000 },
          sourceDirectory,
        };
        if (phase === "run") yield* schedules.create(caller, input);
        const host: Schedule.ScheduleRunHost = {
          scriptTarget: defaultScriptTarget,
          resolveTarget,
          materialize: () => Effect.die("Interrupted source capture must not materialize a target"),
          deliver: () => Effect.void,
          publish: () => Effect.void,
          runPrompt: () => Effect.die("Interrupted source capture must not invoke OMP"),
        };
        yield* TestClock.setTime(1_000);
        capturing = true;
        const operation = yield* (
          phase === "definition"
            ? schedules.create(caller, input).pipe(Effect.asVoid)
            : schedules.start(host).pipe(Effect.andThen(Effect.never))
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
});
