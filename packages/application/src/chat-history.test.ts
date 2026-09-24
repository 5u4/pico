import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Publication } from "@pico/contract/agent-event";
import * as History from "@pico/contract/agent-history";
import * as AgentMessage from "@pico/contract/agent-message";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import type { TranscriptSnapshot } from "@pico/contract/agent-snapshot";
import { Application } from "@pico/contract/application";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import type { GitWorktree } from "@pico/contract/worktree";
import * as Persistence from "@pico/persistence/layer";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ApplicationLayer from "./application.ts";
import { unusedSchedulesLayer } from "./test-schedules.ts";

const platform = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);
const rootId = History.HistoryEntryId.make("root");
const tailId = History.HistoryEntryId.make("tail");
const runId = Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003");
const prompt = AgentMessage.AgentPrompt.make({ text: "Continue", attachments: [] });
const firstMessage: AgentMessage.AgentAssistantMessage = {
  role: "assistant",
  id: AgentMessage.AgentMessageId.make("first-answer"),
  status: "completed",
  stopReason: "stop",
  content: [{ type: "text", text: "First answer" }],
  model: "test",
  timestamp: 1,
};
const currentMessage: AgentMessage.AgentUserMessage = {
  role: "user",
  content: [{ type: "text", text: "Current prompt" }],
  timestamp: 2,
};
const transcriptTexts = (snapshot: TranscriptSnapshot) =>
  snapshot.messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
  );

const makeFixture = Effect.fn("HistoryTest.makeFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-chat-history-" });
  const cwd = AbsolutePath.make(path.join(directory, "workspace"));
  yield* fileSystem.makeDirectory(cwd);
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const held = Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)));
  let activeLeafId = tailId;
  const snapshot = (): TranscriptSnapshot => ({
    messages: activeLeafId === rootId ? [firstMessage] : [firstMessage, currentMessage],
    historyRevision: History.HistoryRevision.make(`revision-${activeLeafId}`),
    contextUsage: { kind: "unavailable" },
    todo: { kind: "ready", phases: [] },
    runtime: { publication: Publication.make(0), run: { kind: "idle" }, assistant: [], tools: [] },
    currentModel: null,
  });
  const runtime = Layer.succeed(
    AgentRuntime,
    AgentRuntime.of({
      events: Stream.empty,
      drain: () => Effect.void,
      transcript: () => Effect.sync(snapshot),
      resultSummary: () => Effect.die("unexpected chat results read"),
      history: () =>
        Effect.sync(() => ({
          nodes: [
            {
              entryId: rootId,
              parentId: null,
              defaultTargetId: rootId,
              kind: "assistant" as const,
              timestamp: "2026-09-18T00:00:00.000Z",
              label: null,
              excerpt: "First answer",
              visibleByDefault: true,
            },
            {
              entryId: tailId,
              parentId: rootId,
              defaultTargetId: tailId,
              kind: "user" as const,
              timestamp: "2026-09-18T00:00:01.000Z",
              label: null,
              excerpt: "Current prompt",
              visibleByDefault: true,
            },
          ],
          activeLeafId,
          revision: History.HistoryRevision.make(`revision-${activeLeafId}`),
          version: History.HistoryVersion.make(`version-${activeLeafId}`),
          publication: Publication.make(0),
          matches: [],
          canContinue: true,
        })),
      previewHistory: ({ targetId }) =>
        Effect.succeed({
          targetId,
          version: History.HistoryVersion.make(`version-${activeLeafId}`),
          destinationLeafId: rootId,
          blocks: [{ label: "Assistant", text: "First answer" }],
        }),
      navigateHistory: ({ targetId }) =>
        Effect.sync(() => {
          activeLeafId = targetId;
          return { kind: "applied", snapshot: snapshot(), draft: null } as const;
        }),
      send: () => Effect.succeed({ kind: "started", completed: held }),
      sendCaptured: (_chatId, capturedRunId) =>
        held.pipe(
          Effect.as({
            runId: capturedRunId,
            outcome: "completed",
            events: [],
            finalAssistantText: "Scheduled answer",
          }),
        ),
      close: () => Effect.void,
      abort: () => Effect.die("unexpected abort"),
      askBtw: () => Effect.die("unexpected side question"),
      deliver: () => Effect.die("unexpected delivery"),
      publish: () => Effect.die("unexpected publication"),
      contextUsage: () => Effect.die("unexpected context read"),
      availableModels: () => Effect.die("unexpected model catalog"),
      discoverSkills: () => Effect.die("unexpected workspace skill command discovery"),
      availableSkills: () => Effect.die("unexpected skill catalog"),
      switchModel: () => Effect.die("unexpected model switch"),
      shake: () => Effect.die("unexpected shake"),
    }),
  );
  const git: GitWorktree = {
    validate: () => Effect.die("unexpected git validation"),
    create: () => Effect.die("unexpected worktree creation"),
    inspectChat: () => Effect.succeed({ kind: "not-managed" }),
    renameChatBranch: () => Effect.die("unexpected branch rename"),
    removeChat: () => Effect.die("unexpected worktree removal"),
  };
  const services = yield* Layer.build(
    ApplicationLayer.layer(git).pipe(
      Layer.provide(unusedSchedulesLayer),
      Layer.provideMerge(Persistence.layer(AbsolutePath.make(path.join(directory, "store.db")))),
      Layer.provide(runtime),
      Layer.provide(
        Layer.succeed(
          AgentSessionStore,
          AgentSessionStore.of({
            create: () => Effect.void,
            readTitle: () => Effect.succeed(null),
            remove: () => Effect.die("unexpected session removal"),
          }),
        ),
      ),
    ),
  );
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
  const application = Context.get(services, Application);
  const chats = Context.get(services, ChatRepository);
  const host = Context.get(services, Schedule.ScheduleRunHostFactory)(null);
  const workspace = yield* application.createWorkspace({
    name: "history",
    platform: "web",
    externalId: null,
    defaultCwd: cwd,
    worktree: null,
  });
  const chat = yield* application.createChat({
    workspaceId: workspace.id,
    externalId: null,
    modelOverride: null,
  });
  const request = {
    chatId: chat.id,
    targetId: rootId,
    expectedVersion: History.HistoryVersion.make("version-tail"),
  };
  return { application, chats, host, chat, request, started, release, held };
});

describe("Application history", () => {
  it.effect(
    "rejects history, preview and navigation for archived chats without moving the branch",
    () =>
      Effect.gen(function* () {
        const { application, chats, chat, request } = yield* makeFixture();
        assert.strictEqual(
          (yield* application.history({ chatId: chat.id, query: "" })).activeLeafId,
          "tail",
        );
        assert.deepStrictEqual(
          yield* application.closeChat(chat.id, { allowDirtyWorktree: false }),
          {
            kind: "closed",
          },
        );
        assert.isNotNull(Option.getOrThrow(yield* chats.findById(chat.id)).archivedAt);
        assert.strictEqual(
          (yield* application.history({ chatId: chat.id, query: "" }).pipe(Effect.flip))._tag,
          "ChatClosed",
        );
        assert.strictEqual(
          (yield* application.previewHistory(request).pipe(Effect.flip))._tag,
          "ChatClosed",
        );
        assert.strictEqual(
          (yield* application.navigateHistory(request).pipe(Effect.flip))._tag,
          "ChatClosed",
        );
        const transcript = yield* application.transcript(chat.id);
        assert.strictEqual(transcript.historyRevision, "revision-tail");
        assert.deepStrictEqual(transcriptTexts(transcript), ["First answer", "Current prompt"]);
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  for (const kind of ["ordinary", "captured"] as const) {
    it.effect(`denies navigation until the tracked ${kind} operation completes`, () =>
      Effect.gen(function* () {
        const { application, host, chat, request, started, release } = yield* makeFixture();
        const operation = yield* Effect.gen(function* () {
          switch (kind) {
            case "ordinary": {
              const delivery = yield* application.sendMessage(chat.id, prompt);
              assert.strictEqual(delivery.kind, "started");
              if (delivery.kind !== "started")
                return yield* Effect.die("Expected started delivery");
              return yield* delivery.completed.pipe(Effect.as("ordinary completed"));
            }
            case "captured":
              return yield* host
                .runPrompt(chat.id, runId, prompt, () => Effect.void)
                .pipe(Effect.map((result) => result.finalAssistantText));
          }
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const history = yield* application.history({ chatId: chat.id, query: "" });
        assert.strictEqual(history.canContinue, false);
        assert.strictEqual(history.activeLeafId, "tail");
        const preview = yield* application.previewHistory(request);
        assert.strictEqual(preview.destinationLeafId, "root");
        assert.deepStrictEqual(preview.blocks, [{ label: "Assistant", text: "First answer" }]);
        const denied = yield* application.navigateHistory(request);
        assert.strictEqual(denied.kind, "conflict");
        if (denied.kind !== "conflict") return yield* Effect.die("Expected busy conflict");
        assert.strictEqual(denied.reason, "busy");
        assert.strictEqual(denied.version, "version-tail");
        assert.strictEqual(denied.history.canContinue, false);
        assert.strictEqual(denied.history.activeLeafId, "tail");
        const unchanged = yield* application.transcript(chat.id);
        assert.strictEqual(unchanged.historyRevision, "revision-tail");
        assert.deepStrictEqual(transcriptTexts(unchanged), ["First answer", "Current prompt"]);
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual(
          yield* Fiber.join(operation),
          kind === "captured" ? "Scheduled answer" : `${kind} completed`,
        );
        yield* Effect.yieldNow;
        assert.strictEqual(
          (yield* application.history({ chatId: chat.id, query: "" })).canContinue,
          true,
        );
        const applied = yield* application.navigateHistory(request);
        assert.strictEqual(applied.kind, "applied");
        if (applied.kind !== "applied") return yield* Effect.die("Expected applied navigation");
        assert.strictEqual(applied.snapshot.historyRevision, "revision-root");
        assert.deepStrictEqual(transcriptTexts(applied.snapshot), ["First answer"]);
        assert.strictEqual(
          (yield* application.history({ chatId: chat.id, query: "" })).activeLeafId,
          "root",
        );
        assert.deepStrictEqual(transcriptTexts(yield* application.transcript(chat.id)), [
          "First answer",
        ]);
      }).pipe(Effect.scoped, Effect.provide(platform)),
    );
  }
});
