import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { AgentMessageId } from "@pico/contract/agent-message";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import { Application } from "@pico/contract/application";
import type { ChatId, ChatResultSummary } from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import type { GitWorktree } from "@pico/contract/worktree";
import * as Persistence from "@pico/persistence/layer";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ApplicationLayer from "./application.ts";
import { unusedSchedulesLayer } from "./test-schedules.ts";

const platform = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);

const makeFixture = Effect.fn("ChatResultsTest.makeFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-chat-results-" });
  const cwd = AbsolutePath.make(path.join(directory, "workspace"));
  yield* fileSystem.makeDirectory(cwd);
  const responses = new Map<ChatId, Effect.Effect<ChatResultSummary, AgentError>>();
  const runtime = Layer.succeed(
    AgentRuntime,
    AgentRuntime.of({
      events: Stream.empty,
      drain: () => Effect.void,
      resultSummary: (chatId) =>
        Effect.suspend(() => responses.get(chatId) ?? Effect.die("unexpected chat results read")),
      transcript: () => Effect.die("unexpected transcript read"),
      history: () => Effect.die("unexpected history read"),
      previewHistory: () => Effect.die("unexpected history preview"),
      navigateHistory: () => Effect.die("unexpected history navigation"),
      send: () => Effect.die("unexpected ordinary send"),
      sendCaptured: () => Effect.die("unexpected captured run"),
      close: () => Effect.die("unexpected close"),
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
    inspectChat: () => Effect.die("unexpected worktree inspection"),
    slotCandidate: () => Effect.die("unexpected slot candidate lookup"),
    renameChatBranch: () => Effect.die("unexpected branch rename"),
    removeChat: () => Effect.die("unexpected worktree removal"),
  };
  const services = yield* Layer.build(
    ApplicationLayer.layer(git).pipe(
      Layer.provide(unusedSchedulesLayer),
      Layer.provide(Persistence.layer(AbsolutePath.make(path.join(directory, "store.db")))),
      Layer.provide(runtime),
      Layer.provide(
        Layer.succeed(
          AgentSessionStore,
          AgentSessionStore.of({
            create: () => Effect.void,
            readTitle: () => Effect.die("unexpected title read"),
            remove: () => Effect.die("unexpected session removal"),
          }),
        ),
      ),
    ),
  );
  const application = Context.get(services, Application);
  const workspace = yield* application.createWorkspace({
    name: "results",
    platform: "web",
    externalId: null,
    defaultCwd: cwd,
    worktree: null,
  });
  const failedChat = yield* application.createChat({
    workspaceId: workspace.id,
    externalId: null,
    modelOverride: null,
    sourceChatId: null,
  });
  const healthyChat = yield* application.createChat({
    workspaceId: workspace.id,
    externalId: null,
    modelOverride: null,
    sourceChatId: null,
  });
  return { application, responses, failedChat, healthyChat };
});

describe("Application chat results", () => {
  it.effect("isolates an unavailable journal and returns its genuine result after recovery", () =>
    Effect.gen(function* () {
      const { application, responses, failedChat, healthyChat } = yield* makeFixture();
      responses.set(
        failedChat.id,
        Effect.fail(new AgentError({ message: "Journal temporarily unreadable" })),
      );
      responses.set(
        healthyChat.id,
        Effect.succeed({
          kind: "ready",
          latest: {
            cursor: { sessionId: "healthy-session", entryId: "healthy-result" },
            messageId: AgentMessageId.make("healthy-message"),
          },
          relation: "none",
        }),
      );
      const request = {
        chats: [
          {
            chatId: failedChat.id,
            seen: { sessionId: "recovering-session", entryId: "previous-result" },
            seenRevision: 7,
          },
        ],
      };
      const catalog = yield* application.chatResults({ ...request, includeAllOpenChats: true });
      assert.deepStrictEqual(Object.fromEntries(catalog.map((entry) => [entry.chatId, entry])), {
        [failedChat.id]: {
          chatId: failedChat.id,
          seenRevision: 7,
          summary: { kind: "unavailable" },
        },
        [healthyChat.id]: {
          chatId: healthyChat.id,
          seenRevision: 0,
          summary: {
            kind: "ready",
            latest: {
              cursor: { sessionId: "healthy-session", entryId: "healthy-result" },
              messageId: AgentMessageId.make("healthy-message"),
            },
            relation: "none",
          },
        },
      });
      assert.deepStrictEqual(yield* application.chatResults(request), [
        { chatId: failedChat.id, seenRevision: 7, summary: { kind: "unavailable" } },
      ]);
      responses.set(
        failedChat.id,
        Effect.succeed({
          kind: "ready",
          latest: {
            cursor: { sessionId: "recovering-session", entryId: "recovered-result" },
            messageId: AgentMessageId.make("recovered-message"),
          },
          relation: "behind",
        }),
      );
      assert.deepStrictEqual(yield* application.chatResults(request), [
        {
          chatId: failedChat.id,
          seenRevision: 7,
          summary: {
            kind: "ready",
            latest: {
              cursor: { sessionId: "recovering-session", entryId: "recovered-result" },
              messageId: AgentMessageId.make("recovered-message"),
            },
            relation: "behind",
          },
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );

  it.effect("preserves interruptions from a journal read", () =>
    Effect.gen(function* () {
      const { application, responses, failedChat } = yield* makeFixture();
      responses.set(failedChat.id, Effect.interrupt);
      const result = yield* application
        .chatResults({
          chats: [{ chatId: failedChat.id, seen: null, seenRevision: 0 }],
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
});
