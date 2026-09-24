import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Publication } from "@pico/contract/agent-event";
import { HistoryRevision } from "@pico/contract/agent-history";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import type { TranscriptSnapshot } from "@pico/contract/agent-snapshot";
import { Application } from "@pico/contract/application";
import { ChatId } from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AgentError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { GitWorktree } from "@pico/contract/worktree";
import * as Persistence from "@pico/persistence/layer";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ScheduleLayer from "../../schedule/src/schedule.ts";
import * as ApplicationLayer from "./application.ts";

const platformLayer = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);
const emptyTranscript: TranscriptSnapshot = {
  messages: [],
  contextUsage: { kind: "unavailable" },
  historyRevision: HistoryRevision.make("test-history"),
  todo: { kind: "ready", phases: [] },
  runtime: { publication: Publication.make(0), run: { kind: "idle" }, assistant: [], tools: [] },
  currentModel: null,
};
const populatedTranscript: TranscriptSnapshot = {
  ...emptyTranscript,
  messages: [
    { role: "user", content: [{ type: "text", text: "Keep this history" }], timestamp: 1 },
  ],
};
const unused = () => Effect.die("Unexpected runtime operation");

const fixture = Effect.fn("WorkspaceDelete.test.fixture")(function* (
  options: {
    readonly runtime?: Partial<AgentRuntime["Service"]>;
    readonly beforeSessionCreate?: (chatId: ChatId) => Effect.Effect<void>;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-workspace-delete-" });
  const cwd = AbsolutePath.make(path.join(root, "project"));
  const sessionsDir = path.join(root, "sessions");
  yield* fileSystem.makeDirectory(cwd);
  yield* fileSystem.makeDirectory(sessionsDir);
  yield* fileSystem.writeFileString(path.join(cwd, "project.txt"), "project contents");
  const sessionFile = (chatId: ChatId) => path.join(sessionsDir, `${chatId}.jsonl`);
  const hostReady = yield* Deferred.make<Schedule.ScheduleRunHost>();
  const schedulesDir = AbsolutePath.make(path.join(root, "schedules"));
  const schedules = yield* ScheduleLayer.open(schedulesDir, (input) =>
    Deferred.await(hostReady).pipe(Effect.flatMap((host) => host.resolveTarget(input))),
  );
  const git: GitWorktree = {
    validate: () => Effect.void,
    create: ({ chatId }, use) =>
      Effect.gen(function* () {
        const directory = AbsolutePath.make(path.join(root, "worktrees", chatId));
        yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
        yield* fileSystem
          .writeFileString(path.join(directory, "retained.txt"), "worktree contents")
          .pipe(Effect.orDie);
        return yield* use(directory);
      }),
    inspectChat: unused,
    renameChatBranch: unused,
    removeChat: unused,
  };
  const services = yield* Layer.build(
    ApplicationLayer.layer(git).pipe(
      Layer.provideMerge(Persistence.layer(AbsolutePath.make(path.join(root, "store.db")))),
      Layer.provide(Layer.succeed(Schedule.Schedules, schedules)),
      Layer.provide(
        Layer.succeed(
          AgentRuntime,
          AgentRuntime.of({
            history: () => Effect.die("unexpected history read"),
            previewHistory: () => Effect.die("unexpected history preview"),
            navigateHistory: () => Effect.die("unexpected history navigation"),
            events: Stream.empty,
            drain: () => Effect.void,
            transcript: () => Effect.succeed(emptyTranscript),
            resultSummary: () => Effect.die("unexpected chat results read"),
            send: unused,
            sendCaptured: unused,
            askBtw: unused,
            deliver: unused,
            publish: unused,
            close: unused,
            abort: unused,
            contextUsage: unused,
            availableModels: unused,
            discoverSkills: () => Effect.die("unexpected workspace skill command discovery"),
            switchModel: unused,
            shake: unused,
            ...options.runtime,
            availableSkills: () => Effect.die("unexpected skill command discovery"),
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(
          AgentSessionStore,
          AgentSessionStore.of({
            create: ({ chatId }) =>
              Effect.gen(function* () {
                if (options.beforeSessionCreate) yield* options.beforeSessionCreate(chatId);
                yield* fileSystem.writeFileString(
                  sessionFile(chatId),
                  `retained session ${chatId}`,
                );
              }).pipe(
                Effect.mapError(() => new AgentError({ message: "Session creation failed" })),
              ),
            readTitle: () => Effect.succeed(null),
            remove: (chatId) =>
              fileSystem
                .remove(sessionFile(chatId))
                .pipe(
                  Effect.mapError(() => new AgentError({ message: "Session rollback failed" })),
                ),
          }),
        ),
      ),
    ),
  );
  const application = Context.get(services, Application);
  const chats = Context.get(services, ChatRepository);
  const workspaces = Context.get(services, WorkspaceRepository);
  const host = Context.get(services, Schedule.ScheduleRunHostFactory)(null);
  yield* Deferred.succeed(hostReady, host);
  const workspace = yield* application.createWorkspace({
    name: "Delete me",
    platform: "web",
    externalId: null,
    defaultCwd: cwd,
    worktree: null,
  });
  const sourceDirectory = AbsolutePath.make(path.join(root, "source"));
  yield* fileSystem.makeDirectory(sourceDirectory);
  yield* fileSystem.writeFileString(path.join(sourceDirectory, "prompt.md"), "Check the project");
  return {
    application,
    chats,
    workspaces,
    host,
    workspace,
    schedules,
    schedulesDir,
    sourceDirectory,
    fileSystem,
    path,
    cwd,
    sessionFile,
  };
});

describe("Workspace deletion", () => {
  it.effect(
    "rejects visible or unreadable open history and preserves archived chats and directories",
    () =>
      Effect.gen(function* () {
        const transcripts = new Map<ChatId, TranscriptSnapshot>();
        let unreadable: ChatId | undefined;
        const test = yield* fixture({
          runtime: {
            transcript: (id) =>
              id === unreadable
                ? Effect.fail(new AgentError({ message: "History cannot be read" }))
                : Effect.succeed(transcripts.get(id) ?? emptyTranscript),
          },
        });
        yield* test.application.updateWorkspace({
          workspaceId: test.workspace.id,
          configuration: {
            kind: "worktree",
            repository: test.cwd,
            settings: { branch: "main", prefix: "chat/" },
          },
        });
        const archived = yield* test.application.createChat({
          workspaceId: test.workspace.id,
          externalId: null,
          modelOverride: null,
        });
        const empty = yield* test.application.createChat({
          workspaceId: test.workspace.id,
          externalId: null,
          modelOverride: null,
        });
        transcripts.set(archived.id, populatedTranscript);
        assert.strictEqual(
          (yield* test.application.deleteWorkspace(test.workspace.id).pipe(Effect.flip)).reason,
          "conflict",
        );
        const archivedRecord = Option.getOrThrow(yield* test.chats.archive(archived.id, 10));
        unreadable = empty.id;
        assert.strictEqual(
          (yield* test.application.deleteWorkspace(test.workspace.id).pipe(Effect.flip)).reason,
          "operation",
        );
        assert.isTrue(Option.isSome(yield* test.workspaces.findById(test.workspace.id)));
        unreadable = undefined;
        yield* test.application.deleteWorkspace(test.workspace.id);
        assert.deepStrictEqual(yield* test.application.listWorkspaces(), []);
        for (const chat of [archivedRecord, empty]) {
          assert.deepStrictEqual(Option.getOrThrow(yield* test.chats.findById(chat.id)), chat);
          assert.strictEqual(
            yield* test.fileSystem.readFileString(test.sessionFile(chat.id)),
            `retained session ${chat.id}`,
          );
          assert.strictEqual(
            yield* test.fileSystem.readFileString(test.path.join(chat.cwd, "retained.txt")),
            "worktree contents",
          );
        }
        assert.strictEqual(
          yield* test.fileSystem.readFileString(test.path.join(test.cwd, "project.txt")),
          "project contents",
        );
        assert.strictEqual(
          (yield* test.application.transcript(empty.id).pipe(Effect.flip)).reason,
          "not-found",
        );
        assert.strictEqual(
          (yield* test.application.abort(empty.id).pipe(Effect.flip)).reason,
          "not-found",
        );
        assert.strictEqual(
          (yield* test.application
            .createChat({ workspaceId: test.workspace.id, externalId: null, modelOverride: null })
            .pipe(Effect.flip)).reason,
          "not-found",
        );
        assert.strictEqual(
          (yield* test.host.publish(empty.id, "late publication").pipe(Effect.flip))._tag,
          "ScheduleHostError",
        );
        assert.strictEqual(
          (yield* test.host
            .materialize({
              destination: {
                kind: "workspace",
                workspaceId: test.workspace.id,
                newChatId: empty.id,
              },
              title: "Deleted workspace",
            })
            .pipe(Effect.flip))._tag,
          "ScheduleHostError",
        );
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("blocks disabled cross-owner chat targets and enabled workspace targets", () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const chat = yield* test.application.createChat({
        workspaceId: test.workspace.id,
        externalId: null,
        modelOverride: null,
      });
      const owner = yield* test.application.createWorkspace({
        ...test.workspace,
        name: "Schedule owner",
      });
      const caller = { workspaceId: owner.id, chatId: chat.id };
      const chatSchedule = yield* test.schedules.create(caller, {
        name: "Disabled chat target",
        enabled: false,
        target: { kind: "chat", chatId: chat.id },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: test.sourceDirectory,
      });
      const directSchedule = yield* test.schedules.create(caller, {
        name: "Workspace target",
        enabled: true,
        target: { kind: "workspace", workspaceId: test.workspace.id },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: test.sourceDirectory,
      });
      yield* test.chats.archive(chat.id, 20);
      yield* test.fileSystem.remove(
        test.path.join(test.schedulesDir, "disabled", chatSchedule.id, "prompt.md"),
      );
      assert.strictEqual(
        (yield* test.application.deleteWorkspace(test.workspace.id).pipe(Effect.flip)).reason,
        "conflict",
      );
      yield* test.schedules.remove(caller, directSchedule.id);
      assert.strictEqual(
        (yield* test.application.deleteWorkspace(test.workspace.id).pipe(Effect.flip)).reason,
        "conflict",
      );
      yield* test.schedules.remove(caller, chatSchedule.id);
      const unrelated = yield* test.schedules.create(caller, {
        name: "Unrelated target",
        enabled: false,
        target: { kind: "workspace", workspaceId: owner.id },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: test.sourceDirectory,
      });
      const metadata = test.path.join(test.schedulesDir, "disabled", unrelated.id, "meta.json");
      yield* test.fileSystem.writeFileString(
        metadata,
        JSON.stringify({
          target: { kind: "chat", chatId: ChatId.make("018f47a0-0000-7000-8000-000000000099") },
        }),
      );
      assert.strictEqual(
        (yield* test.application.deleteWorkspace(test.workspace.id).pipe(Effect.flip)).reason,
        "operation",
      );
      yield* test.fileSystem.writeFileString(
        metadata,
        JSON.stringify({
          target: { kind: "workspace", workspaceId: owner.id },
          trigger: "broken unrelated metadata",
        }),
      );
      yield* test.application.deleteWorkspace(test.workspace.id);
      assert.deepStrictEqual(
        (yield* test.application.listWorkspaces()).map((workspace) => workspace.id),
        [owner.id],
      );
      assert.strictEqual(
        (yield* test.schedules
          .create(caller, {
            name: "Late target",
            enabled: false,
            target: { kind: "workspace", workspaceId: test.workspace.id },
            trigger: { kind: "once", at: 1_000 },
            sourceDirectory: test.sourceDirectory,
          })
          .pipe(Effect.flip)).kind,
        "invalid",
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "retains Shake tracking through caller interruption and releases it after cleanup",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        const test = yield* fixture({
          runtime: {
            shake: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Deferred.succeed(cleaning, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCleanup)),
                  ),
                ),
              ),
          },
        });
        const chat = yield* test.application.createChat({
          workspaceId: test.workspace.id,
          externalId: null,
          modelOverride: null,
        });
        const shaking = yield* test.application.shake(chat.id, "elide").pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseCleanup, undefined));
        yield* Deferred.await(started);
        const interrupting = yield* Fiber.interrupt(shaking).pipe(Effect.forkChild);
        yield* Deferred.await(cleaning);
        assert.strictEqual(
          (yield* test.application.deleteWorkspace(test.workspace.id).pipe(Effect.flip)).reason,
          "conflict",
        );
        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* Fiber.join(interrupting);
        const result = yield* Fiber.await(shaking);
        assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
        yield* test.application.deleteWorkspace(test.workspace.id);
        assert.isTrue(Option.isNone(yield* test.workspaces.findById(test.workspace.id)));
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rejects busy admissions and active ordinary work without waiting", () =>
    Effect.gen(function* () {
      const admitting = yield* Deferred.make<void>();
      const allowAdmission = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const test = yield* fixture({
        runtime: {
          send: () =>
            Deferred.succeed(admitting, undefined).pipe(
              Effect.andThen(Deferred.await(allowAdmission)),
              Effect.as({ kind: "started", completed: Deferred.await(completed) } as const),
            ),
        },
      });
      const chat = yield* test.application.createChat({
        workspaceId: test.workspace.id,
        externalId: null,
        modelOverride: null,
      });
      const sending = yield* test.application
        .sendMessage(chat.id, { text: "running", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(admitting);
      assert.strictEqual(
        (yield* test.application.deleteWorkspace(test.workspace.id).pipe(Effect.flip)).reason,
        "conflict",
      );
      yield* Deferred.succeed(allowAdmission, undefined);
      const delivery = yield* Fiber.join(sending);
      if (delivery.kind !== "started") return yield* Effect.die("Expected started delivery");
      assert.strictEqual(
        (yield* test.application.deleteWorkspace(test.workspace.id).pipe(Effect.flip)).reason,
        "conflict",
      );
      yield* Deferred.succeed(completed, undefined);
      yield* delivery.completed;
      const caller = { workspaceId: test.workspace.id, chatId: chat.id };
      const schedule = yield* test.schedules.create(caller, {
        name: "Removed while running",
        enabled: false,
        target: { kind: "chat", chatId: chat.id },
        trigger: { kind: "once", at: 1_000 },
        sourceDirectory: test.sourceDirectory,
      });
      yield* test.schedules.remove(caller, schedule.id);
      yield* test.application.deleteWorkspace(test.workspace.id);
      assert.strictEqual(
        (yield* test.host
          .materialize({
            destination: { kind: "chat", chatId: chat.id },
            title: "Deleted script must not start",
          })
          .pipe(Effect.flip))._tag,
        "ScheduleHostError",
      );
      const rejected = yield* test.application
        .sendMessage(chat.id, { text: "late", attachments: [] })
        .pipe(Effect.flip);
      assert.strictEqual(rejected._tag, "ApplicationError");
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect(
    "rejects an uninspected chat committed during transcript inspection and releases locks",
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const test = yield* fixture({
          runtime: {
            transcript: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(reading, undefined);
                yield* Deferred.await(release);
                return emptyTranscript;
              }),
            send: () => Effect.succeed({ kind: "handled" }),
          },
        });
        const first = yield* test.application.createChat({
          workspaceId: test.workspace.id,
          externalId: null,
          modelOverride: null,
        });
        const deleting = yield* test.application
          .deleteWorkspace(test.workspace.id)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(reading);
        const second = yield* test.application.createChat({
          workspaceId: test.workspace.id,
          externalId: null,
          modelOverride: null,
        });
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(deleting);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "conflict");
        assert.deepStrictEqual(
          yield* test.application.sendMessage(first.id, { text: "still live", attachments: [] }),
          { kind: "handled" },
        );
        assert.deepStrictEqual(Option.getOrThrow(yield* test.chats.findById(second.id)), second);
        yield* test.application.deleteWorkspace(test.workspace.id);
        assert.deepStrictEqual(yield* test.application.listWorkspaces(), []);
      }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("rolls back only a new session whose insertion loses the deletion race", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<ChatId>();
      const release = yield* Deferred.make<void>();
      const test = yield* fixture({
        beforeSessionCreate: (chatId) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, chatId);
            yield* Deferred.await(release);
          }),
      });
      const creating = yield* test.application
        .createChat({ workspaceId: test.workspace.id, externalId: null, modelOverride: null })
        .pipe(Effect.result, Effect.forkChild);
      const chatId = yield* Deferred.await(started);
      yield* test.application.deleteWorkspace(test.workspace.id);
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual((yield* Fiber.join(creating))._tag, "Failure");
      assert.isTrue(Option.isNone(yield* test.chats.findById(chatId)));
      assert.isFalse(yield* test.fileSystem.exists(test.sessionFile(chatId)));
      assert.strictEqual(
        yield* test.fileSystem.readFileString(test.path.join(test.cwd, "project.txt")),
        "project contents",
      );
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
