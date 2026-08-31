import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, it } from "@effect/vitest";
import type * as AgentEvent from "@pico/contract/agent-event";
import * as AgentMessage from "@pico/contract/agent-message";
import { AgentRuntime } from "@pico/contract/agent-runtime";
import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AbsolutePath } from "@pico/contract/path";
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
const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const smoke = Effect.fn("AgentRuntime.smoke")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-omp-smoke-" });
  const storeFile = AbsolutePath.make(path.join(temporaryRoot, "pico.sqlite"));
  const sessionsDir = AbsolutePath.make(path.join(temporaryRoot, "sessions"));
  const cwd = AbsolutePath.make(process.cwd());
  const persistenceLayer = Persistence.layer(storeFile);
  const runtimeLayer = AgentRuntimeLayer.layer(sessionsDir).pipe(
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
    yield* chats.createRegular({
      id: chatId,
      workspaceId,
      cwd,
      externalId: null,
      createdAt: 0,
    });

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
        runtime.send(
          chatId,
          AgentMessage.AgentPrompt.make(`Do not use tools. Reply with exactly ${marker}.`),
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

    yield* Effect.logInfo(`result=${marker} sessionsDir=${sessionsDir}`);
  }).pipe(Effect.provide(runtimeLayer));
});

describe("AgentRuntime smoke", () => {
  it.effect("runs an authenticated agent with temporary state", () =>
    smoke().pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
