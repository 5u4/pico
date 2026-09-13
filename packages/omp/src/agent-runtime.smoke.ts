import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import type * as AgentEvent from "@pico/contract/agent-event";
import * as AgentMessage from "@pico/contract/agent-message";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import { BranchNaming } from "@pico/contract/branch-naming";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import { PicoRoot } from "@pico/contract/config";
import { AbsolutePath } from "@pico/contract/path";
import { Schedules } from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Persistence from "@pico/persistence/layer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as AgentRuntimeLayer from "./layer.ts";

const marker = "PICO_SMOKE_OK";
const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const platformLayer = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);

const smoke = Effect.fn("AgentRuntime.smoke")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-omp-smoke-" });
  const storeFile = AbsolutePath.make(path.join(temporaryRoot, "pico.sqlite"));
  const sessionsDir = AbsolutePath.make(path.join(temporaryRoot, "sessions"));
  const cwd = AbsolutePath.make(process.cwd());
  const resolvedChat: Chat.Chat = {
    id: chatId,
    workspaceId,
    cwd,
    externalId: null,
    createdAt: 0,
    archivedAt: null,
  };
  const schedules = Schedules.of({
    create: () => Effect.die("unexpected schedule create"),
    list: () => Effect.die("unexpected schedule list"),
    get: () => Effect.die("unexpected schedule get"),
    update: () => Effect.die("unexpected schedule update"),
    remove: () => Effect.die("unexpected schedule delete"),
    start: () => Effect.die("unexpected scheduler start"),
  });
  const persistenceLayer = Persistence.layer(storeFile);
  const chatSessionContext = Layer.succeed(
    ChatSessionContext,
    ChatSessionContext.of({
      resolve: () =>
        Effect.succeed({
          chat: resolvedChat,
          platform: null,
          appendSystemPrompt: "You are pico, a personal agent assistant.",
        }),
    }),
  );
  const runtimeLayer = AgentRuntimeLayer.layer({
    paths: { root: PicoRoot.make(temporaryRoot), sessionsDir },
    schedules,
    browser: { idleTimeoutMs: 10_800_000 },
  }).pipe(
    Layer.provide(
      Layer.merge(
        chatSessionContext,
        Layer.succeed(
          BranchNaming,
          BranchNaming.of({
            handle: () => {},
          }),
        ),
      ),
    ),
    Layer.provideMerge(persistenceLayer),
  );

  yield* Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepository;
    const chats = yield* ChatRepository;
    const runtime = yield* AgentRuntime;

    yield* workspaces.create({
      id: workspaceId,
      name: "OMP smoke",
      binding: null,
      defaultCwd: cwd,
      worktree: null,
      createdAt: 0,
    });
    yield* chats.create(resolvedChat);

    const finished =
      yield* Deferred.make<Extract<AgentEvent.AgentEvent, { readonly type: "run-finished" }>>();
    yield* runtime.events.pipe(
      Stream.runForEach((envelope) => {
        if (envelope.chatId !== chatId || envelope.event.type !== "run-finished") {
          return Effect.void;
        }
        return Deferred.succeed(finished, envelope.event);
      }),
      Effect.forkScoped({ startImmediately: true }),
    );

    const [, terminal] = yield* Effect.all(
      [
        runtime
          .send(
            chatId,
            AgentMessage.AgentPrompt.make({
              text: `Do not use tools. Reply with exactly ${marker}.`,
              attachments: [],
            }),
          )
          .pipe(
            Effect.flatMap((delivery) =>
              delivery.kind === "handled" ? Effect.void : delivery.completed,
            ),
          ),
        Deferred.await(finished).pipe(Effect.timeout("1 minute")),
      ],
      { concurrency: "unbounded" },
    );
    if (terminal.outcome !== "completed") {
      return yield* Effect.fail(new Error("OMP smoke run did not complete successfully"));
    }

    const transcript = yield* runtime.transcript(chatId);
    const hasMarker = transcript.some(
      (message) =>
        message.role === "assistant" &&
        message.status === "completed" &&
        message.content.some((content) => content.type === "text" && content.text.includes(marker)),
    );
    if (!hasMarker) {
      return yield* Effect.fail(
        new Error("OMP smoke response did not contain the expected marker"),
      );
    }

    const contextUsage = yield* runtime.contextUsage(chatId);
    assert.strictEqual(contextUsage.kind, "available");
    if (contextUsage.kind === "available") {
      assert.isAbove(contextUsage.contextWindow, 0);
      assert.isAbove(contextUsage.usedTokens, 0);
      assert.isAtLeast(contextUsage.systemPromptTokens, 0);
      assert.isAtLeast(contextUsage.systemToolsTokens, 0);
      assert.isAtLeast(contextUsage.systemContextTokens, 0);
      assert.isAtLeast(contextUsage.skillsTokens, 0);
      assert.isAbove(contextUsage.messagesTokens, 0);
    }

    yield* Effect.logInfo(`result=${marker} sessionsDir=${sessionsDir}`);
  }).pipe(Effect.provide(runtimeLayer));
});

describe("AgentRuntime smoke", () => {
  it.effect("runs an authenticated agent with temporary state", () =>
    smoke().pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
