import { Database } from "bun:sqlite";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import { type AgentEventEnvelope, Publication } from "@pico/contract/agent-event";
import {
  HistoryEntryId,
  type HistoryPreview,
  HistoryRevision,
  type HistorySnapshot,
  HistoryVersion,
} from "@pico/contract/agent-history";
import {
  type AgentAssistantMessage,
  AgentMessageId,
  AgentPrompt,
  type AgentTranscript,
} from "@pico/contract/agent-message";
import type { ContextUsage, ShakeMode, ShakeResult } from "@pico/contract/agent-runtime";
import type {
  NavigateHistoryResult,
  RuntimeSnapshot,
  TranscriptSnapshot,
} from "@pico/contract/agent-snapshot";
import { Application } from "@pico/contract/application";
import {
  ChatId,
  type ChatListEntry,
  type ChatResultsRequest,
  type ChatResultsResponse,
} from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { ApplicationError, ChatClosed } from "@pico/contract/errors";
import { EventRouter } from "@pico/contract/event-router";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import { type Workspace, WorkspaceId } from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as RpcServer from "@pico/rpc/server";
import type {} from "bun";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { vi } from "vitest";
import * as Persistence from "../../persistence/src/layer.ts";
import * as ScheduleLayer from "../../schedule/src/schedule.ts";
import { type LiveChat, make } from "../src/client.ts";

const firstChat = ChatId.make("018f47a0-0000-7000-8000-000000000001");
const secondChat = ChatId.make("018f47a0-0000-7000-8000-000000000002");
const firstMessageId = AgentMessageId.make("first-message");
const secondMessageId = AgentMessageId.make("second-message");
const thirdMessageId = AgentMessageId.make("third-message");
const orphanMessageId = AgentMessageId.make("orphan-message");
const nextMessageId = AgentMessageId.make("next-message");
const webWorkspace: Workspace = {
  id: WorkspaceId.make("018f47a0-0000-7000-8000-000000000003"),
  name: "Project",
  defaultCwd: AbsolutePath.make("/tmp/project"),
  platform: "web",
  externalId: null,
  worktree: null,
  modelOverride: null,
  createdAt: 1,
};
const message = { role: "user", content: [{ type: "text", text: "same" }], timestamp: 1 } as const;
const prompt = (text: string) => AgentPrompt.make({ text, attachments: [] });
const recoveredImage = {
  type: "image",
  name: "recovered.gif",
  data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  mimeType: "image/gif",
} as const;
let publication = 0;
const snapshot = (
  messages: AgentTranscript = [],
  contextUsage: ContextUsage = { kind: "unavailable" },
  runtime: RuntimeSnapshot = {
    publication: Publication.make(0),
    run: { kind: "idle" },
    assistant: [],
    tools: [],
  },
  historyRevision = HistoryRevision.make("initial-history"),
): TranscriptSnapshot => ({
  messages,
  contextUsage,
  currentModel: null,
  todo: { kind: "ready", phases: [] },
  runtime,
  historyRevision,
});
const historySnapshot = (query: string, revision: string): HistorySnapshot => ({
  nodes: [],
  activeLeafId: null,
  revision: HistoryRevision.make(revision),
  version: HistoryVersion.make(revision),
  publication: Publication.make(0),
  matches: [HistoryEntryId.make(`${revision}:${query}`)],
  canContinue: true,
});
const assistant = (id: AgentMessageId, text: string): AgentAssistantMessage => ({
  id,
  role: "assistant",
  status: "completed",
  stopReason: "stop",
  content: [{ type: "text", text }],
  model: "test",
  timestamp: 1,
});
const pendingMessages = (live: LiveChat) =>
  [...live.assistant.values()].flatMap((entry) =>
    entry.kind === "settled" ? [entry.message] : [],
  );
const draftBlock = (live: LiveChat, id: AgentMessageId, index: number) => {
  const entry = live.assistant.get(id);
  return entry?.kind === "draft" ? entry.blocks.get(index) : undefined;
};

type RoutedEvent = Omit<AgentEventEnvelope, "publication" | "origin"> &
  Partial<Pick<AgentEventEnvelope, "publication" | "origin">>;

interface Route {
  readonly queue: Queue.Queue<RoutedEvent, Cause.Done>;
  readonly closed: Deferred.Deferred<void>;
}

const fixture = Effect.fnUntraced(function* (
  procedures: Pick<Application["Service"], "transcript" | "sendMessage" | "abort"> &
    Partial<
      Pick<
        Application["Service"],
        | "listWorkspaces"
        | "listChats"
        | "createWorkspace"
        | "updateWorkspace"
        | "deleteWorkspace"
        | "createChat"
        | "closeChat"
        | "shake"
        | "contextUsage"
        | "availableModels"
        | "availableSkills"
        | "switchModel"
        | "history"
        | "previewHistory"
        | "navigateHistory"
        | "chatResults"
      >
    >,
  beforeReady: Effect.Effect<void> = Effect.void,
) {
  const opened = yield* Queue.unbounded<Route>();
  let openCount = 0;
  const storeFile = yield* Deferred.make<AbsolutePath>();
  const scheduleDirectory = yield* Deferred.make<AbsolutePath>();
  const persistence = Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-frontend-" });
      const path = AbsolutePath.make(`${directory}/store.db`);
      yield* Deferred.succeed(storeFile, path);
      return Persistence.layer(path);
    }),
  ).pipe(Layer.provide(BunFileSystem.layer));
  const ownership = Layer.effectDiscard(
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceRepository;
      const chats = yield* ChatRepository;
      yield* workspaces.create(webWorkspace);
      for (const id of [firstChat, secondChat]) {
        yield* chats.create({
          id,
          workspaceId: webWorkspace.id,
          cwd: webWorkspace.defaultCwd,
          externalId: null,
          createdAt: 1,
        });
      }
    }),
  ).pipe(Layer.provideMerge(persistence));
  const application = Application.of({
    deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
    listWorkspaces: () => Effect.succeed([webWorkspace]),
    listChats: () => Effect.die("unexpected chat list"),
    askBtw: () => Effect.die("unexpected side question"),
    createWorkspace: () => Effect.die("unexpected workspace creation"),
    updateWorkspace: () => Effect.die("unexpected workspace update"),
    getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
    bindWorkspace: () => Effect.die("unexpected workspace binding"),
    createChat: () => Effect.die("unexpected chat creation"),
    findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
    findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
    findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
    contextUsage: () => Effect.die("unexpected context read"),
    availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
    availableWorkspaceSkills: () => Effect.die("unexpected workspace model discovery"),
    setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
    availableModels: () => Effect.die("unexpected model discovery"),
    availableSkills: () => Effect.die("unexpected skill command discovery"),
    switchModel: () => Effect.die("unexpected model switch"),
    shake: () => Effect.die("unexpected chat shake"),
    closeChat: () => Effect.die("unexpected chat close"),
    history: () => Effect.die("unexpected history read"),
    previewHistory: () => Effect.die("unexpected history preview"),
    navigateHistory: () => Effect.die("unexpected history navigation"),
    chatResults: (_input) => Effect.succeed([]),
    ...procedures,
  });
  const router = EventRouter.of({
    drain: () => Effect.void,
    open: () =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          openCount++;
          const queue = yield* Queue.unbounded<RoutedEvent, Cause.Done>();
          const closed = yield* Deferred.make<void>();
          const route = { queue, closed };
          yield* Queue.offer(opened, route);
          return route;
        }),
        (route) => Deferred.succeed(route.closed, undefined),
      ).pipe(
        Effect.tap(() => beforeReady),
        Effect.map((route) => ({
          events: Stream.fromQueue(route.queue).pipe(
            Stream.map(
              (envelope): AgentEventEnvelope => ({
                ...envelope,
                publication: envelope.publication ?? Publication.make(++publication),
                origin: envelope.origin ?? "session",
              }),
            ),
          ),
          setFilter: () => Effect.die("unexpected filter change"),
        })),
      ),
  });
  const schedules = Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-frontend-schedules-",
      });
      yield* Deferred.succeed(scheduleDirectory, AbsolutePath.make(directory));
      return ScheduleLayer.layer(AbsolutePath.make(directory), (target) =>
        target.kind === "chat" || target.kind === "workspace"
          ? Effect.succeed(target)
          : Effect.fail(new Schedule.ScheduleHostError({ message: "Unexpected external target" })),
      );
    }),
  ).pipe(Layer.provide(Layer.mergeAll(BunCrypto.layer, BunPath.layer, BunFileSystem.layer)));
  const layer = HttpRouter.serve(RpcServer.routes).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Application, application),
        Layer.succeed(EventRouter, router),
        schedules,
        ownership,
      ),
    ),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );
  return {
    opened,
    openCount: () => openCount,
    layer,
    storeFile: Deferred.await(storeFile),
    scheduleDirectory: Deferred.await(scheduleDirectory),
  };
});

const endpoint = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  if (server.address._tag === "UnixAddress") return yield* Effect.die("Expected TCP server");
  const host = server.address.hostname === "0.0.0.0" ? "127.0.0.1" : server.address.hostname;
  return `ws://${host}:${server.address.port}/rpc`;
});

const waitFor = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  predicate: (value: A) => boolean,
) =>
  AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runDrain,
  );

const registryInScope = Effect.acquireRelease(
  Effect.sync(() => AtomRegistry.make()),
  (registry) => Effect.sync(() => registry.dispose()),
);

const snapshotFixture = Effect.fnUntraced(function* (
  procedures: Partial<
    Pick<Application["Service"], "navigateHistory" | "history" | "previewHistory">
  > = {},
) {
  const requests = yield* Queue.unbounded<{
    readonly reply: Deferred.Deferred<TranscriptSnapshot, ApplicationError>;
    readonly returned: Deferred.Deferred<void>;
  }>();
  const pending: Array<Deferred.Deferred<TranscriptSnapshot, ApplicationError>> = [];
  const server = yield* fixture({
    transcript: () =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<TranscriptSnapshot, ApplicationError>();
        const returned = yield* Deferred.make<void>();
        pending.push(reply);
        yield* Queue.offer(requests, { reply, returned });
        return yield* Deferred.await(reply).pipe(
          Effect.ensuring(Deferred.succeed(returned, undefined)),
          Effect.uninterruptible,
        );
      }),
    sendMessage: () => Effect.succeed({ kind: "handled" }),
    abort: () => Effect.void,
    ...procedures,
  });
  return {
    ...server,
    requests,
    release: Effect.forEach(pending, Deferred.interrupt, { discard: true }),
  };
});

const resultsFixture = Effect.fnUntraced(function* () {
  const requests = yield* Queue.unbounded<{
    readonly input: ChatResultsRequest;
    readonly reply: Deferred.Deferred<ChatResultsResponse>;
  }>();
  const server = yield* fixture({
    transcript: () => Effect.die("unexpected transcript read"),
    sendMessage: () => Effect.succeed({ kind: "handled" }),
    abort: () => Effect.void,
    chatResults: Effect.fnUntraced(function* (input: ChatResultsRequest) {
      const reply = yield* Deferred.make<ChatResultsResponse>();
      yield* Queue.offer(requests, { input, reply });
      return yield* Deferred.await(reply);
    }),
  });
  return { ...server, requests };
});

describe("frontend state over WebSocket", () => {
  it.live("loads the complete results catalog without opening chat transcripts", () =>
    Effect.gen(function* () {
      const server = yield* resultsFixture();
      yield* Effect.gen(function* () {
        const registry = yield* registryInScope;
        const state = make({ url: yield* endpoint });
        registry.mount(state.chatResults);
        const catalog = yield* Queue.take(server.requests);
        assert.deepStrictEqual(catalog.input, { chats: [], includeAllOpenChats: true });
        yield* Deferred.succeed(catalog.reply, [
          {
            chatId: firstChat,
            seenRevision: 0,
            summary: {
              kind: "ready",
              latest: {
                cursor: { sessionId: "first-session", entryId: "first-result" },
                messageId: firstMessageId,
              },
              relation: "none",
            },
          },
          {
            chatId: secondChat,
            seenRevision: 0,
            summary: { kind: "ready", latest: null, relation: "none" },
          },
        ]);
        const results = yield* AtomRegistry.getResult(registry, state.chatResults, {
          suspendOnWaiting: true,
        });
        assert.deepStrictEqual(
          [...results],
          [
            [
              firstChat,
              {
                chatId: firstChat,
                seenRevision: 0,
                summary: {
                  kind: "ready",
                  latest: {
                    cursor: { sessionId: "first-session", entryId: "first-result" },
                    messageId: firstMessageId,
                  },
                  relation: "none",
                },
              },
            ],
            [
              secondChat,
              {
                chatId: secondChat,
                seenRevision: 0,
                summary: { kind: "ready", latest: null, relation: "none" },
              },
            ],
          ],
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("merges a background chat terminal refresh without losing other results", () =>
    Effect.gen(function* () {
      const server = yield* resultsFixture();
      yield* Effect.gen(function* () {
        const registry = yield* registryInScope;
        const state = make({ url: yield* endpoint });
        registry.mount(state.chatResults);
        const route = yield* Queue.take(server.opened);
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [
          {
            chatId: firstChat,
            seenRevision: 0,
            summary: {
              kind: "ready",
              latest: {
                cursor: { sessionId: "first-session", entryId: "first-result" },
                messageId: firstMessageId,
              },
              relation: "none",
            },
          },
          {
            chatId: secondChat,
            seenRevision: 0,
            summary: { kind: "ready", latest: null, relation: "none" },
          },
        ]);
        yield* AtomRegistry.getResult(registry, state.chatResults, { suspendOnWaiting: true });
        yield* waitFor(registry, state.connection, (value) => value.kind === "active");
        yield* Queue.offer(route.queue, {
          chatId: secondChat,
          event: { type: "run-finished", outcome: "completed" },
        });
        const refresh = yield* Queue.take(server.requests);
        assert.deepStrictEqual(refresh.input, {
          chats: [{ chatId: secondChat, seen: null, seenRevision: 0 }],
          includeAllOpenChats: false,
        });
        yield* Deferred.succeed(refresh.reply, [
          {
            chatId: secondChat,
            seenRevision: 0,
            summary: {
              kind: "ready",
              latest: {
                cursor: { sessionId: "second-session", entryId: "background-result" },
                messageId: secondMessageId,
              },
              relation: "none",
            },
          },
        ]);
        const results = yield* AtomRegistry.getResult(registry, state.chatResults, {
          suspendOnWaiting: true,
        });
        assert.deepStrictEqual(
          [...results],
          [
            [
              firstChat,
              {
                chatId: firstChat,
                seenRevision: 0,
                summary: {
                  kind: "ready",
                  latest: {
                    cursor: { sessionId: "first-session", entryId: "first-result" },
                    messageId: firstMessageId,
                  },
                  relation: "none",
                },
              },
            ],
            [
              secondChat,
              {
                chatId: secondChat,
                seenRevision: 0,
                summary: {
                  kind: "ready",
                  latest: {
                    cursor: { sessionId: "second-session", entryId: "background-result" },
                    messageId: secondMessageId,
                  },
                  relation: "none",
                },
              },
            ],
          ],
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live(
    "drops an in-flight result after the seen basis changes and publishes the new basis",
    () =>
      Effect.gen(function* () {
        const server = yield* resultsFixture();
        yield* Effect.gen(function* () {
          const registry = yield* registryInScope;
          const state = make({ url: yield* endpoint });
          registry.set(state.chatResults, {
            chats: [
              {
                chatId: firstChat,
                seen: { sessionId: "first-session", entryId: "first-result" },
                seenRevision: 1,
              },
            ],
            includeAllOpenChats: true,
          });
          const publishedHeads = new Set<string | null>();
          registry.subscribe(state.chatResults, (value) => {
            if (value._tag !== "Success") return;
            const summary = value.value.get(firstChat)?.summary;
            if (summary?.kind === "ready") {
              publishedHeads.add(summary.latest?.cursor.entryId ?? null);
            }
          });
          registry.mount(state.chatResults);
          const route = yield* Queue.take(server.opened);
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [
            {
              chatId: firstChat,
              seenRevision: 1,
              summary: {
                kind: "ready",
                latest: {
                  cursor: { sessionId: "first-session", entryId: "first-result" },
                  messageId: firstMessageId,
                },
                relation: "covered",
              },
            },
          ]);
          yield* AtomRegistry.getResult(registry, state.chatResults, { suspendOnWaiting: true });
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          yield* Queue.offer(route.queue, {
            chatId: firstChat,
            event: { type: "run-finished", outcome: "completed" },
          });
          const stale = yield* Queue.take(server.requests);
          registry.set(state.chatResults, {
            chats: [
              {
                chatId: firstChat,
                seen: { sessionId: "first-session", entryId: "second-result" },
                seenRevision: 2,
              },
            ],
            includeAllOpenChats: true,
          });
          yield* Deferred.succeed(stale.reply, [
            {
              chatId: firstChat,
              seenRevision: 1,
              summary: {
                kind: "ready",
                latest: {
                  cursor: { sessionId: "first-session", entryId: "stale-result" },
                  messageId: orphanMessageId,
                },
                relation: "behind",
              },
            },
          ]);
          const fresh = yield* Queue.take(server.requests);
          assert.deepStrictEqual(fresh.input.chats, [
            {
              chatId: firstChat,
              seen: { sessionId: "first-session", entryId: "second-result" },
              seenRevision: 2,
            },
          ]);
          assert.deepStrictEqual(
            [...AsyncResult.getOrThrow(registry.get(state.chatResults))],
            [
              [
                firstChat,
                {
                  chatId: firstChat,
                  seenRevision: 1,
                  summary: {
                    kind: "ready",
                    latest: {
                      cursor: { sessionId: "first-session", entryId: "first-result" },
                      messageId: firstMessageId,
                    },
                    relation: "covered",
                  },
                },
              ],
            ],
          );
          yield* Deferred.succeed(fresh.reply, [
            {
              chatId: firstChat,
              seenRevision: 2,
              summary: {
                kind: "ready",
                latest: {
                  cursor: { sessionId: "first-session", entryId: "second-result" },
                  messageId: secondMessageId,
                },
                relation: "covered",
              },
            },
          ]);
          const results = yield* AtomRegistry.getResult(registry, state.chatResults, {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            [...results],
            [
              [
                firstChat,
                {
                  chatId: firstChat,
                  seenRevision: 2,
                  summary: {
                    kind: "ready",
                    latest: {
                      cursor: { sessionId: "first-session", entryId: "second-result" },
                      messageId: secondMessageId,
                    },
                    relation: "covered",
                  },
                },
              ],
            ],
          );
          assert.deepStrictEqual([...publishedHeads], ["first-result", "second-result"]);
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live("rehydrates the complete results catalog after reconnecting", () =>
    Effect.gen(function* () {
      const thirdChat = ChatId.make("018f47a0-0000-7000-8000-000000000004");
      const server = yield* resultsFixture();
      yield* Effect.gen(function* () {
        const registry = yield* registryInScope;
        const state = make({ url: yield* endpoint });
        registry.mount(state.chatResults);
        const first = yield* Queue.take(server.opened);
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [
          {
            chatId: firstChat,
            seenRevision: 0,
            summary: { kind: "ready", latest: null, relation: "none" },
          },
          {
            chatId: secondChat,
            seenRevision: 0,
            summary: { kind: "ready", latest: null, relation: "none" },
          },
        ]);
        yield* AtomRegistry.getResult(registry, state.chatResults, { suspendOnWaiting: true });
        yield* waitFor(registry, state.connection, (value) => value.kind === "active");
        yield* Queue.end(first.queue);
        yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");
        registry.set(state.ensure, undefined);
        yield* Queue.take(server.opened);
        const rehydration = yield* Queue.take(server.requests);
        assert.deepStrictEqual(rehydration.input, { chats: [], includeAllOpenChats: true });
        yield* Deferred.succeed(rehydration.reply, [
          {
            chatId: firstChat,
            seenRevision: 0,
            summary: {
              kind: "ready",
              latest: {
                cursor: { sessionId: "first-session", entryId: "offline-result" },
                messageId: nextMessageId,
              },
              relation: "none",
            },
          },
          {
            chatId: thirdChat,
            seenRevision: 0,
            summary: {
              kind: "ready",
              latest: {
                cursor: { sessionId: "third-session", entryId: "discovered-result" },
                messageId: thirdMessageId,
              },
              relation: "none",
            },
          },
        ]);
        yield* waitFor(registry, state.connection, (value) => value.kind === "active");
        const results = yield* AtomRegistry.getResult(registry, state.chatResults, {
          suspendOnWaiting: true,
        });
        assert.deepStrictEqual(
          [...results],
          [
            [
              firstChat,
              {
                chatId: firstChat,
                seenRevision: 0,
                summary: {
                  kind: "ready",
                  latest: {
                    cursor: { sessionId: "first-session", entryId: "offline-result" },
                    messageId: nextMessageId,
                  },
                  relation: "none",
                },
              },
            ],
            [
              thirdChat,
              {
                chatId: thirdChat,
                seenRevision: 0,
                summary: {
                  kind: "ready",
                  latest: {
                    cursor: { sessionId: "third-session", entryId: "discovered-result" },
                    messageId: thirdMessageId,
                  },
                  relation: "none",
                },
              },
            ],
          ],
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  for (const kind of ["history", "preview"] as const) {
    it.live(
      `interrupts superseded ${kind} reads, coalesces bursts, and recovers without affecting other chats`,
      () =>
        Effect.gen(function* () {
          const requests = yield* Queue.unbounded<{
            readonly input: string;
            readonly reply: Deferred.Deferred<string, ApplicationError>;
            readonly returned: Deferred.Deferred<void>;
          }>();
          const received: string[] = [];
          const read = (input: string) =>
            Effect.gen(function* () {
              received.push(input);
              const reply = yield* Deferred.make<string, ApplicationError>();
              const returned = yield* Deferred.make<void>();
              yield* Queue.offer(requests, { input, reply, returned });
              return yield* Deferred.await(reply).pipe(
                Effect.ensuring(Deferred.succeed(returned, undefined)),
              );
            });
          const server = yield* fixture({
            transcript: () => Effect.succeed(snapshot()),
            sendMessage: () => Effect.succeed({ kind: "handled" }),
            abort: () => Effect.void,
            history: ({ query }) =>
              read(query ?? "").pipe(
                Effect.map(
                  (id): HistorySnapshot => ({
                    nodes: [],
                    activeLeafId: null,
                    revision: HistoryRevision.make("initial"),
                    version: HistoryVersion.make("initial"),
                    publication: Publication.make(0),
                    matches: [HistoryEntryId.make(id)],
                    canContinue: true,
                  }),
                ),
              ),
            previewHistory: ({ targetId }) =>
              read(targetId).pipe(
                Effect.map(
                  (id): HistoryPreview => ({
                    targetId: HistoryEntryId.make(id),
                    version: HistoryVersion.make("initial"),
                    destinationLeafId: HistoryEntryId.make(id),
                    blocks: [],
                  }),
                ),
              ),
          });
          yield* Effect.gen(function* () {
            const registry = yield* registryInScope;
            const state = make({ url: yield* endpoint });
            registry.mount(state.connection);
            yield* waitFor(registry, state.connection, (value) => value.kind === "active");
            const firstRoute = yield* Queue.take(server.opened);
            const result = Atom.readable((get) =>
              kind === "history"
                ? AsyncResult.map(get(state.history(firstChat)), (value) => value.matches[0] ?? "")
                : AsyncResult.map(get(state.previewHistory(firstChat)), (value) => value.targetId),
            );
            registry.mount(result);
            yield* AtomRegistry.getResult(registry, state.transcript(firstChat), {
              suspendOnWaiting: true,
            });
            const select = (id: string, chatId = firstChat) => {
              if (kind === "history") registry.set(state.history(chatId), id);
              else registry.set(state.previewHistory(chatId), HistoryEntryId.make(id));
            };
            select("old");
            const old = yield* Queue.take(requests);
            select("latest");
            const latest = yield* Queue.take(requests);
            yield* Deferred.await(old.returned);
            yield* Deferred.succeed(latest.reply, "latest");
            yield* waitFor(registry, result, (value) => value._tag === "Success" && !value.waiting);
            assert.strictEqual(AsyncResult.getOrThrow(registry.get(result)), "latest");
            yield* Deferred.succeed(old.reply, "old");
            yield* Deferred.await(old.returned);
            registry.set(state.ensure, undefined);
            yield* AtomRegistry.getResult(registry, state.ensure, { suspendOnWaiting: true });
            assert.strictEqual(server.openCount(), 1);
            assert.isTrue(Option.isNone(yield* Queue.poll(requests)));
            assert.strictEqual(AsyncResult.getOrThrow(registry.get(result)), "latest");
            yield* Queue.end(firstRoute.queue);
            yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");
            registry.set(state.ensure, undefined);
            const secondRoute = yield* Queue.take(server.opened);
            yield* AtomRegistry.getResult(registry, state.ensure, { suspendOnWaiting: true });
            const latestRefresh = yield* Queue.take(requests);
            assert.strictEqual(latestRefresh.input, "latest");
            yield* Deferred.succeed(latestRefresh.reply, "latest");
            yield* waitFor(registry, result, (value) => value._tag === "Success" && !value.waiting);
            assert.strictEqual(AsyncResult.getOrThrow(registry.get(result)), "latest");

            select("pending");
            const pending = yield* Queue.take(requests);
            select("failed");
            const failed = yield* Queue.take(requests);
            yield* Deferred.fail(
              failed.reply,
              new ApplicationError({ reason: "operation", message: "History unavailable" }),
            );
            yield* waitFor(registry, result, (value) => value._tag === "Failure" && !value.waiting);
            const failure = registry.get(result);
            const error = failure._tag === "Failure" ? Cause.squash(failure.cause) : undefined;
            assert.strictEqual(
              error instanceof ApplicationError ? error.message : undefined,
              "History unavailable",
            );
            select("recovered");
            const recovered = yield* Queue.take(requests);
            yield* Deferred.succeed(recovered.reply, "recovered");
            yield* waitFor(registry, result, (value) => value._tag === "Success" && !value.waiting);
            assert.strictEqual(AsyncResult.getOrThrow(registry.get(result)), "recovered");
            yield* Deferred.fail(
              pending.reply,
              new ApplicationError({ reason: "operation", message: "Superseded failure" }),
            );
            yield* Deferred.await(pending.returned);
            yield* Queue.end(secondRoute.queue);
            yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");
            registry.set(state.ensure, undefined);
            const thirdRoute = yield* Queue.take(server.opened);
            yield* AtomRegistry.getResult(registry, state.ensure, { suspendOnWaiting: true });
            const recoveredRefresh = yield* Queue.take(requests);
            assert.strictEqual(recoveredRefresh.input, "recovered");
            yield* Deferred.succeed(recoveredRefresh.reply, "recovered");
            yield* waitFor(registry, result, (value) => value._tag === "Success" && !value.waiting);
            assert.strictEqual(AsyncResult.getOrThrow(registry.get(result)), "recovered");

            const otherResult = Atom.readable((get) =>
              kind === "history"
                ? AsyncResult.map(get(state.history(secondChat)), (value) => value.matches[0] ?? "")
                : AsyncResult.map(get(state.previewHistory(secondChat)), (value) => value.targetId),
            );
            registry.mount(otherResult);
            yield* AtomRegistry.getResult(registry, state.transcript(secondChat), {
              suspendOnWaiting: true,
            });
            select("other-chat", secondChat);
            const other = yield* Queue.take(requests);
            select("burst-blocked");
            const blocked = yield* Queue.take(requests);
            for (let index = 0; index < 50; index++) select(`burst-${index}`);
            const last = yield* Queue.take(requests);
            assert.strictEqual(last.input, "burst-49");
            yield* Deferred.await(blocked.returned);
            yield* Deferred.succeed(last.reply, last.input);
            yield* waitFor(registry, result, (value) => value._tag === "Success" && !value.waiting);
            assert.strictEqual(AsyncResult.getOrThrow(registry.get(result)), "burst-49");
            yield* Deferred.succeed(other.reply, "other-chat");
            yield* waitFor(
              registry,
              otherResult,
              (value) => value._tag === "Success" && !value.waiting,
            );
            assert.strictEqual(AsyncResult.getOrThrow(registry.get(otherResult)), "other-chat");
            yield* Queue.end(thirdRoute.queue);
            yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");
            registry.set(state.ensure, undefined);
            yield* AtomRegistry.getResult(registry, state.ensure, { suspendOnWaiting: true });
            const refreshed = [yield* Queue.take(requests), yield* Queue.take(requests)];
            assert.deepStrictEqual(refreshed.map((request) => request.input).sort(), [
              "burst-49",
              "other-chat",
            ]);
            for (const request of refreshed) yield* Deferred.succeed(request.reply, request.input);
            yield* waitFor(registry, result, (value) => value._tag === "Success" && !value.waiting);
            yield* waitFor(
              registry,
              otherResult,
              (value) => value._tag === "Success" && !value.waiting,
            );
            assert.strictEqual(AsyncResult.getOrThrow(registry.get(result)), "burst-49");
            assert.strictEqual(AsyncResult.getOrThrow(registry.get(otherResult)), "other-chat");
            assert.isTrue(Option.isNone(yield* Queue.poll(requests)));
            assert.deepStrictEqual(received.slice(0, 10), [
              "old",
              "latest",
              "latest",
              "pending",
              "failed",
              "recovered",
              "recovered",
              "other-chat",
              "burst-blocked",
              "burst-49",
            ]);
            assert.deepStrictEqual(received.slice(10).sort(), ["burst-49", "other-chat"]);
            select("disposed");
            registry.dispose();
            yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
            assert.strictEqual(received.length, 12);
          }).pipe(Effect.scoped, Effect.provide(server.layer));
        }),
    );
  }

  it.live(
    "refreshes open history and previews on ordinary turns without losing newer streams or refreshing duplicate cuts",
    () =>
      Effect.gen(function* () {
        const previews = yield* Queue.unbounded<{
          readonly targetId: HistoryEntryId;
          readonly reply: Deferred.Deferred<HistoryPreview>;
          readonly returned: Deferred.Deferred<void>;
        }>();
        const targetId = HistoryEntryId.make("selected-entry");
        let version = "initial";
        let historyReads = 0;
        let previewReads = 0;
        const preview = (text: string): HistoryPreview => ({
          targetId,
          version: HistoryVersion.make(text),
          destinationLeafId: targetId,
          blocks: [{ label: "Assistant", text }],
        });
        const server = yield* snapshotFixture({
          history: ({ query }) =>
            Effect.sync(() => {
              historyReads += 1;
              return {
                ...historySnapshot(query ?? "", version),
                revision: HistoryRevision.make("initial-history"),
              };
            }),
          previewHistory: ({ targetId }) =>
            Effect.gen(function* () {
              previewReads += 1;
              const reply = yield* Deferred.make<HistoryPreview>();
              const returned = yield* Deferred.make<void>();
              yield* Queue.offer(previews, { targetId, reply, returned });
              return yield* Deferred.await(reply).pipe(
                Effect.ensuring(Deferred.succeed(returned, undefined)),
              );
            }),
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => server.release);
          const registry = yield* registryInScope;
          const state = make({ url: yield* endpoint });
          registry.mount(state.live(firstChat));
          const route = yield* Queue.take(server.opened);
          yield* Deferred.succeed(
            (yield* Queue.take(server.requests)).reply,
            snapshot([], undefined, {
              publication: Publication.make(0),
              run: { kind: "idle" },
              assistant: [
                {
                  kind: "draft",
                  messageId: orphanMessageId,
                  blocks: [
                    {
                      type: "text-delta",
                      messageId: orphanMessageId,
                      contentIndex: 0,
                      text: "Retained earlier draft",
                    },
                  ],
                },
              ],
              tools: [],
            }),
          );
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          const closeHistory = registry.mount(state.history(firstChat));
          const closePreview = registry.mount(state.previewHistory(firstChat));
          registry.set(state.history(firstChat), "needle");
          registry.set(state.previewHistory(firstChat), targetId);
          yield* Deferred.succeed((yield* Queue.take(previews)).reply, preview("initial"));
          yield* AtomRegistry.getResult(registry, state.history(firstChat), {
            suspendOnWaiting: true,
          });
          yield* AtomRegistry.getResult(registry, state.previewHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.history(firstChat))).matches,
            [HistoryEntryId.make("initial:needle")],
          );
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.previewHistory(firstChat))).blocks,
            [{ label: "Assistant", text: "initial" }],
          );

          registry.set(state.previewHistory(firstChat), targetId);
          const obsolete = yield* Queue.take(previews);
          version = "settled";
          yield* Queue.offer(route.queue, {
            chatId: firstChat,
            publication: Publication.make(10),
            event: { type: "message-settled", message: assistant(firstMessageId, "Settled turn") },
          });
          const append = yield* Queue.take(server.requests);
          yield* Queue.offerAll(route.queue, [
            {
              chatId: firstChat,
              publication: Publication.make(11),
              event: { type: "run-started" },
            },
            {
              chatId: firstChat,
              publication: Publication.make(12),
              event: {
                type: "text-delta",
                messageId: secondMessageId,
                contentIndex: 0,
                text: "Newer stream",
              },
            },
          ]);
          yield* waitFor(
            registry,
            state.live(firstChat),
            (live) => draftBlock(live, secondMessageId, 0)?.text === "Newer stream",
          );
          const settled = snapshot([assistant(firstMessageId, "Settled turn")], undefined, {
            publication: Publication.make(10),
            run: { kind: "idle" },
            assistant: [],
            tools: [],
          });
          yield* Deferred.succeed(append.reply, settled);
          yield* AtomRegistry.getResult(registry, state.transcript(firstChat), {
            suspendOnWaiting: true,
          });
          yield* AtomRegistry.getResult(registry, state.history(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.history(firstChat))).matches,
            [HistoryEntryId.make("settled:needle")],
          );
          const refreshed = yield* Queue.take(previews);
          yield* Deferred.await(obsolete.returned);
          assert.strictEqual(refreshed.targetId, "selected-entry");
          assert.deepStrictEqual(registry.get(state.live(firstChat)).run, { kind: "running" });
          assert.strictEqual(
            draftBlock(registry.get(state.live(firstChat)), orphanMessageId, 0)?.text,
            "Retained earlier draft",
          );
          assert.strictEqual(
            draftBlock(registry.get(state.live(firstChat)), secondMessageId, 0)?.text,
            "Newer stream",
          );
          assert.isFalse(registry.get(state.historyReplacing(firstChat)));
          yield* Deferred.succeed(obsolete.reply, preview("obsolete"));
          yield* Deferred.succeed(refreshed.reply, preview("settled"));
          yield* AtomRegistry.getResult(registry, state.previewHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.previewHistory(firstChat))).blocks,
            [{ label: "Assistant", text: "settled" }],
          );

          yield* Queue.offerAll(route.queue, [
            {
              chatId: firstChat,
              publication: Publication.make(10),
              event: { type: "history-replaced" },
            },
            {
              chatId: firstChat,
              publication: Publication.make(13),
              event: {
                type: "text-delta",
                messageId: secondMessageId,
                contentIndex: 0,
                text: " continues",
              },
            },
          ]);
          const duplicate = yield* Queue.take(server.requests);
          yield* waitFor(
            registry,
            state.live(firstChat),
            (live) => draftBlock(live, secondMessageId, 0)?.text === "Newer stream continues",
          );
          yield* Deferred.succeed(duplicate.reply, settled);
          yield* AtomRegistry.getResult(registry, state.transcript(firstChat), {
            suspendOnWaiting: true,
          });
          registry.refresh(state.transcript(firstChat));
          const stale = yield* Queue.take(server.requests);
          yield* Deferred.succeed(
            stale.reply,
            snapshot(
              [],
              undefined,
              {
                publication: Publication.make(5),
                run: { kind: "idle" },
                assistant: [],
                tools: [],
              },
              HistoryRevision.make("obsolete-history"),
            ),
          );
          yield* Deferred.await(stale.returned);
          registry.refresh(state.transcript(firstChat));
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, settled);
          yield* AtomRegistry.getResult(registry, state.transcript(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))),
            [assistant(firstMessageId, "Settled turn")],
          );
          assert.strictEqual(
            draftBlock(registry.get(state.live(firstChat)), secondMessageId, 0)?.text,
            "Newer stream continues",
          );
          assert.strictEqual(
            draftBlock(registry.get(state.live(firstChat)), orphanMessageId, 0)?.text,
            "Retained earlier draft",
          );
          assert.deepStrictEqual(registry.get(state.live(firstChat)).run, { kind: "running" });
          assert.isFalse(registry.get(state.historyReplacing(firstChat)));
          assert.strictEqual(historyReads, 2);
          assert.strictEqual(previewReads, 3);

          closeHistory();
          closePreview();
          yield* Effect.yieldNow;
          version = "closed";
          yield* Queue.offer(route.queue, {
            chatId: firstChat,
            publication: Publication.make(20),
            event: { type: "message-settled", message: assistant(secondMessageId, "Closed turn") },
          });
          yield* Deferred.succeed(
            (yield* Queue.take(server.requests)).reply,
            snapshot(
              [
                assistant(firstMessageId, "Settled turn"),
                assistant(secondMessageId, "Closed turn"),
              ],
              undefined,
              {
                publication: Publication.make(20),
                run: { kind: "idle" },
                assistant: [],
                tools: [],
              },
            ),
          );
          yield* AtomRegistry.getResult(registry, state.transcript(firstChat), {
            suspendOnWaiting: true,
          });
          assert.strictEqual(historyReads, 2);
          assert.strictEqual(previewReads, 3);
          registry.mount(state.history(firstChat));
          registry.mount(state.previewHistory(firstChat));
          yield* Deferred.succeed((yield* Queue.take(previews)).reply, preview("closed"));
          yield* AtomRegistry.getResult(registry, state.history(firstChat), {
            suspendOnWaiting: true,
          });
          yield* AtomRegistry.getResult(registry, state.previewHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.history(firstChat))).matches,
            [HistoryEntryId.make("closed:needle")],
          );
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.previewHistory(firstChat))).blocks,
            [{ label: "Assistant", text: "closed" }],
          );
          assert.strictEqual(historyReads, 3);
          assert.strictEqual(previewReads, 4);
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "refreshes the mounted history query and invalidates pending previews after a remote replacement",
    () =>
      Effect.gen(function* () {
        const previews = yield* Queue.unbounded<{
          readonly targetId: HistoryEntryId;
          readonly reply: Deferred.Deferred<HistoryPreview>;
          readonly returned: Deferred.Deferred<void>;
        }>();
        let revision = "initial";
        let historyReads = 0;
        const targetId = HistoryEntryId.make("selected-entry");
        const preview = (version: string): HistoryPreview => ({
          targetId,
          version: HistoryVersion.make(version),
          destinationLeafId: targetId,
          blocks: [],
        });
        const server = yield* snapshotFixture({
          history: ({ query }) =>
            Effect.sync(() => {
              historyReads += 1;
              return historySnapshot(query ?? "", revision);
            }),
          previewHistory: ({ targetId }) =>
            Effect.gen(function* () {
              const reply = yield* Deferred.make<HistoryPreview>();
              const returned = yield* Deferred.make<void>();
              yield* Queue.offer(previews, { targetId, reply, returned });
              return yield* Deferred.await(reply).pipe(
                Effect.ensuring(Deferred.succeed(returned, undefined)),
              );
            }),
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => server.release);
          const registry = yield* registryInScope;
          const state = make({ url: yield* endpoint });
          registry.mount(state.live(firstChat));
          const route = yield* Queue.take(server.opened);
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, snapshot());
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          const closeHistory = registry.mount(state.history(firstChat));
          const closePreview = registry.mount(state.previewHistory(firstChat));
          registry.set(state.history(firstChat), "needle");
          registry.set(state.previewHistory(firstChat), targetId);
          const initial = yield* Queue.take(previews);
          yield* Deferred.succeed(initial.reply, preview("initial"));
          yield* AtomRegistry.getResult(registry, state.history(firstChat), {
            suspendOnWaiting: true,
          });
          yield* AtomRegistry.getResult(registry, state.previewHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.history(firstChat))).matches,
            [HistoryEntryId.make("initial:needle")],
          );
          assert.strictEqual(
            AsyncResult.getOrThrow(registry.get(state.previewHistory(firstChat))).version,
            "initial",
          );

          registry.set(state.previewHistory(firstChat), targetId);
          const obsolete = yield* Queue.take(previews);
          revision = "selected";
          yield* Queue.offer(route.queue, {
            chatId: firstChat,
            publication: Publication.make(10),
            event: { type: "history-replaced" },
          });
          const transcript = yield* Queue.take(server.requests);
          const refreshedPreview = yield* Queue.take(previews);
          yield* Deferred.await(obsolete.returned);
          yield* waitFor(
            registry,
            state.history(firstChat),
            (value) => value._tag === "Success" && value.value.revision === "selected",
          );
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.history(firstChat))).matches,
            [HistoryEntryId.make("selected:needle")],
          );
          assert.strictEqual(registry.get(state.previewHistory(firstChat))._tag, "Initial");
          assert.isTrue(registry.get(state.previewHistory(firstChat)).waiting);
          assert.strictEqual(refreshedPreview.targetId, "selected-entry");
          yield* Deferred.succeed(obsolete.reply, preview("obsolete"));
          yield* Deferred.succeed(
            transcript.reply,
            snapshot(
              [],
              undefined,
              {
                publication: Publication.make(10),
                run: { kind: "idle" },
                assistant: [],
                tools: [],
              },
              HistoryRevision.make("selected"),
            ),
          );
          yield* waitFor(registry, state.historyReplacing(firstChat), (value) => !value);
          assert.strictEqual(registry.get(state.previewHistory(firstChat))._tag, "Initial");
          yield* Deferred.succeed(refreshedPreview.reply, preview("selected"));
          yield* AtomRegistry.getResult(registry, state.previewHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.strictEqual(
            AsyncResult.getOrThrow(registry.get(state.previewHistory(firstChat))).version,
            "selected",
          );

          closeHistory();
          closePreview();
          yield* Effect.yieldNow;
          revision = "closed";
          yield* Queue.offer(route.queue, {
            chatId: firstChat,
            publication: Publication.make(20),
            event: { type: "history-replaced" },
          });
          yield* Deferred.succeed(
            (yield* Queue.take(server.requests)).reply,
            snapshot(
              [],
              undefined,
              {
                publication: Publication.make(20),
                run: { kind: "idle" },
                assistant: [],
                tools: [],
              },
              HistoryRevision.make("closed"),
            ),
          );
          yield* waitFor(registry, state.historyReplacing(firstChat), (value) => !value);
          assert.strictEqual(historyReads, 2);
          assert.isTrue(Option.isNone(yield* Queue.poll(previews)));
          registry.mount(state.history(firstChat));
          registry.mount(state.previewHistory(firstChat));
          const reopened = yield* Queue.take(previews);
          yield* Deferred.succeed(reopened.reply, preview("closed"));
          yield* AtomRegistry.getResult(registry, state.history(firstChat), {
            suspendOnWaiting: true,
          });
          yield* AtomRegistry.getResult(registry, state.previewHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.history(firstChat))).matches,
            [HistoryEntryId.make("closed:needle")],
          );
          assert.strictEqual(
            AsyncResult.getOrThrow(registry.get(state.previewHistory(firstChat))).version,
            "closed",
          );
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "refreshes open history and previews after a reconnect with the same revision and publication",
    () =>
      Effect.gen(function* () {
        let version = "initial";
        let historyReads = 0;
        let previewReads = 0;
        const targetId = HistoryEntryId.make("selected-entry");
        const server = yield* snapshotFixture({
          history: ({ query }) =>
            Effect.sync(() => {
              historyReads += 1;
              return {
                ...historySnapshot(query ?? "", version),
                revision: HistoryRevision.make("initial-history"),
              };
            }),
          previewHistory: ({ targetId }) =>
            Effect.sync((): HistoryPreview => {
              previewReads += 1;
              return {
                targetId,
                version: HistoryVersion.make(version),
                destinationLeafId: targetId,
                blocks: [{ label: "Assistant", text: version }],
              };
            }),
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => server.release);
          const registry = yield* registryInScope;
          const state = make({ url: yield* endpoint });
          registry.mount(state.live(firstChat));
          const first = yield* Queue.take(server.opened);
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, snapshot());
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          registry.mount(state.history(firstChat));
          registry.mount(state.previewHistory(firstChat));
          registry.set(state.history(firstChat), "needle");
          registry.set(state.previewHistory(firstChat), targetId);
          yield* AtomRegistry.getResult(registry, state.history(firstChat), {
            suspendOnWaiting: true,
          });
          yield* AtomRegistry.getResult(registry, state.previewHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.history(firstChat))).matches,
            [HistoryEntryId.make("initial:needle")],
          );
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.previewHistory(firstChat))).blocks,
            [{ label: "Assistant", text: "initial" }],
          );

          yield* Queue.end(first.queue);
          yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");
          version = "reconnected";
          registry.set(state.ensure, undefined);
          yield* Queue.take(server.opened);
          yield* Deferred.succeed(
            (yield* Queue.take(server.requests)).reply,
            snapshot([assistant(firstMessageId, "Turn completed while disconnected")]),
          );
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          yield* AtomRegistry.getResult(registry, state.history(firstChat), {
            suspendOnWaiting: true,
          });
          yield* AtomRegistry.getResult(registry, state.previewHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.history(firstChat))).matches,
            [HistoryEntryId.make("reconnected:needle")],
          );
          assert.strictEqual(
            AsyncResult.getOrThrow(registry.get(state.previewHistory(firstChat))).targetId,
            "selected-entry",
          );
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.previewHistory(firstChat))).blocks,
            [{ label: "Assistant", text: "reconnected" }],
          );
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))),
            [assistant(firstMessageId, "Turn completed while disconnected")],
          );
          assert.deepStrictEqual(registry.get(state.live(firstChat)).run, { kind: "idle" });
          assert.isFalse(registry.get(state.historyReplacing(firstChat)));
          assert.strictEqual(historyReads, 2);
          assert.strictEqual(previewReads, 2);
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "refreshes the requested history query and preview after accepting a reconnect revision",
    () =>
      Effect.gen(function* () {
        let revision = "initial";
        const targetId = HistoryEntryId.make("selected-entry");
        const server = yield* snapshotFixture({
          history: ({ query }) => Effect.sync(() => historySnapshot(query ?? "", revision)),
          previewHistory: () =>
            Effect.sync(
              (): HistoryPreview => ({
                targetId,
                version: HistoryVersion.make(revision),
                destinationLeafId: targetId,
                blocks: [],
              }),
            ),
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => server.release);
          const registry = yield* registryInScope;
          const state = make({ url: yield* endpoint });
          registry.mount(state.live(firstChat));
          const first = yield* Queue.take(server.opened);
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, snapshot());
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          registry.mount(state.history(firstChat));
          registry.mount(state.previewHistory(firstChat));
          registry.set(state.history(firstChat), "needle");
          registry.set(state.previewHistory(firstChat), targetId);
          yield* AtomRegistry.getResult(registry, state.history(firstChat), {
            suspendOnWaiting: true,
          });
          yield* AtomRegistry.getResult(registry, state.previewHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.history(firstChat))).matches,
            [HistoryEntryId.make("initial:needle")],
          );
          assert.strictEqual(
            AsyncResult.getOrThrow(registry.get(state.previewHistory(firstChat))).version,
            "initial",
          );

          yield* Queue.end(first.queue);
          yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");
          revision = "reconnected";
          registry.set(state.ensure, undefined);
          yield* Queue.take(server.opened);
          yield* Deferred.succeed(
            (yield* Queue.take(server.requests)).reply,
            snapshot(
              [],
              undefined,
              {
                publication: Publication.make(20),
                run: { kind: "idle" },
                assistant: [],
                tools: [],
              },
              HistoryRevision.make("reconnected"),
            ),
          );
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          yield* AtomRegistry.getResult(registry, state.history(firstChat), {
            suspendOnWaiting: true,
          });
          yield* AtomRegistry.getResult(registry, state.previewHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.history(firstChat))).matches,
            [HistoryEntryId.make("reconnected:needle")],
          );
          assert.strictEqual(
            AsyncResult.getOrThrow(registry.get(state.previewHistory(firstChat))).version,
            "reconnected",
          );
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "replaces abandoned assistant state when the history revision changes while disconnected",
    () =>
      Effect.gen(function* () {
        const server = yield* snapshotFixture();
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => server.release);
          const registry = yield* registryInScope;
          const state = make({ url: yield* endpoint });
          registry.mount(state.live(firstChat));
          const first = yield* Queue.take(server.opened);
          yield* Deferred.succeed(
            (yield* Queue.take(server.requests)).reply,
            snapshot([assistant(firstMessageId, "Abandoned response")], undefined, {
              publication: Publication.make(1),
              run: { kind: "running" },
              assistant: [
                {
                  kind: "draft",
                  messageId: orphanMessageId,
                  blocks: [
                    {
                      type: "text-delta",
                      messageId: orphanMessageId,
                      contentIndex: 0,
                      text: "Abandoned draft",
                    },
                  ],
                },
              ],
              tools: [],
            }),
          );
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          assert.strictEqual(
            draftBlock(registry.get(state.live(firstChat)), orphanMessageId, 0)?.text,
            "Abandoned draft",
          );
          yield* Queue.offer(first.queue, {
            chatId: firstChat,
            event: { type: "notice", level: "info", message: "Keep this notice" },
          });
          yield* waitFor(registry, state.live(firstChat), (value) => value.notices.length === 1);
          yield* Queue.end(first.queue);
          yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");
          registry.set(state.ensure, undefined);
          const second = yield* Queue.take(server.opened);
          const recovery = yield* Queue.take(server.requests);
          assert.isTrue(registry.get(state.historyReplacing(firstChat)));
          yield* Deferred.succeed(
            recovery.reply,
            snapshot(
              [assistant(secondMessageId, "Selected branch")],
              undefined,
              {
                publication: Publication.make(20),
                run: { kind: "idle" },
                assistant: [],
                tools: [],
              },
              HistoryRevision.make("selected-branch"),
            ),
          );
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          assert.isFalse(registry.get(state.historyReplacing(firstChat)));
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))),
            [assistant(secondMessageId, "Selected branch")],
          );
          assert.deepStrictEqual([...registry.get(state.live(firstChat)).assistant], []);
          assert.deepStrictEqual(
            registry.get(state.live(firstChat)).notices.map((notice) => notice.message),
            ["Keep this notice"],
          );
          yield* Queue.offer(second.queue, {
            chatId: firstChat,
            publication: Publication.make(21),
            event: {
              type: "text-delta",
              messageId: firstMessageId,
              contentIndex: 0,
              text: "Reused on the selected branch",
            },
          });
          yield* waitFor(
            registry,
            state.live(firstChat),
            (value) =>
              draftBlock(value, firstMessageId, 0)?.text === "Reused on the selected branch",
          );
          assert.strictEqual(
            draftBlock(registry.get(state.live(firstChat)), firstMessageId, 0)?.text,
            "Reused on the selected branch",
          );
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "preserves a matching navigation draft and newer events after its replacement snapshot is accepted",
    () =>
      Effect.gen(function* () {
        const navigation = yield* Deferred.make<NavigateHistoryResult>();
        const started = yield* Deferred.make<void>();
        const server = yield* snapshotFixture({
          navigateHistory: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(navigation))),
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => server.release);
          const registry = yield* registryInScope;
          const state = make({ url: yield* endpoint });
          registry.mount(state.live(firstChat));
          const route = yield* Queue.take(server.opened);
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, snapshot());
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          registry.set(state.navigateHistory(firstChat), {
            targetId: HistoryEntryId.make("destination"),
            expectedVersion: HistoryVersion.make("before-navigation"),
          });
          yield* Deferred.await(started);
          yield* Queue.offer(route.queue, {
            chatId: firstChat,
            publication: Publication.make(10),
            event: { type: "history-replaced" },
          });
          const refresh = yield* Queue.take(server.requests);
          assert.isTrue(registry.get(state.historyReplacing(firstChat)));
          const selected = snapshot(
            [assistant(firstMessageId, "Selected response")],
            undefined,
            { publication: Publication.make(10), run: { kind: "idle" }, assistant: [], tools: [] },
            HistoryRevision.make("destination"),
          );
          yield* Deferred.succeed(refresh.reply, selected);
          yield* waitFor(registry, state.historyReplacing(firstChat), (value) => !value);
          yield* Queue.offer(route.queue, {
            chatId: firstChat,
            publication: Publication.make(11),
            event: {
              type: "text-delta",
              messageId: nextMessageId,
              contentIndex: 0,
              text: "New run after navigation",
            },
          });
          yield* waitFor(
            registry,
            state.live(firstChat),
            (value) => draftBlock(value, nextMessageId, 0)?.text === "New run after navigation",
          );
          yield* Deferred.succeed(navigation, {
            kind: "applied",
            snapshot: selected,
            draft: AgentPrompt.make({
              text: "Recovered selected prompt",
              attachments: [recoveredImage],
            }),
          });
          const result = yield* AtomRegistry.getResult(registry, state.navigateHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(result, {
            kind: "applied",
            snapshot: selected,
            draft: { text: "Recovered selected prompt", attachments: [recoveredImage] },
          });
          assert.isFalse(registry.get(state.historyReplacing(firstChat)));
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))),
            [assistant(firstMessageId, "Selected response")],
          );
          assert.strictEqual(
            draftBlock(registry.get(state.live(firstChat)), nextMessageId, 0)?.text,
            "New run after navigation",
          );
          assert.deepStrictEqual(registry.get(state.live(firstChat)).run, { kind: "running" });
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "keeps the replacement gate and newer cut through a failed refresh and an older navigation reply",
    () =>
      Effect.gen(function* () {
        const navigation = yield* Deferred.make<NavigateHistoryResult>();
        const started = yield* Deferred.make<void>();
        const server = yield* snapshotFixture({
          navigateHistory: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(navigation))),
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => server.release);
          const registry = yield* registryInScope;
          const state = make({ url: yield* endpoint });
          registry.mount(state.live(firstChat));
          const route = yield* Queue.take(server.opened);
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, snapshot());
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          registry.set(state.navigateHistory(firstChat), {
            targetId: HistoryEntryId.make("older-destination"),
            expectedVersion: HistoryVersion.make("initial"),
          });
          yield* Deferred.await(started);
          yield* Queue.offer(route.queue, {
            chatId: firstChat,
            publication: Publication.make(30),
            event: { type: "history-replaced" },
          });
          yield* Deferred.fail(
            (yield* Queue.take(server.requests)).reply,
            new ApplicationError({ reason: "operation", message: "Read failed" }),
          );
          yield* waitFor(
            registry,
            state.transcript(firstChat),
            (value) => value._tag === "Failure" && !value.waiting,
          );
          assert.isTrue(registry.get(state.historyReplacing(firstChat)));
          yield* Deferred.succeed(navigation, {
            kind: "applied",
            draft: AgentPrompt.make({
              text: "Obsolete recovered prompt",
              attachments: [recoveredImage],
            }),
            snapshot: snapshot(
              [assistant(firstMessageId, "Older destination")],
              undefined,
              {
                publication: Publication.make(20),
                run: { kind: "idle" },
                assistant: [],
                tools: [],
              },
              HistoryRevision.make("older-destination"),
            ),
          });
          const result = yield* AtomRegistry.getResult(registry, state.navigateHistory(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(result, { kind: "cancelled" });
          assert.isTrue(registry.get(state.historyReplacing(firstChat)));
          yield* Queue.offerAll(route.queue, [
            {
              chatId: firstChat,
              publication: Publication.make(25),
              event: {
                type: "text-delta",
                messageId: orphanMessageId,
                contentIndex: 0,
                text: "Stale delta",
              },
            },
            {
              chatId: firstChat,
              publication: Publication.make(31),
              origin: "delivery",
              event: {
                type: "message-settled",
                message: assistant(thirdMessageId, "Current delivery"),
              },
            },
            {
              chatId: firstChat,
              publication: Publication.make(33),
              event: {
                type: "text-delta",
                messageId: nextMessageId,
                contentIndex: 0,
                text: "Current delta",
              },
            },
          ]);
          const recovery = yield* Queue.take(server.requests);
          yield* waitFor(
            registry,
            state.live(firstChat),
            (value) => draftBlock(value, nextMessageId, 0)?.text === "Current delta",
          );
          yield* Deferred.succeed(
            recovery.reply,
            snapshot(
              [assistant(secondMessageId, "Newer destination")],
              undefined,
              {
                publication: Publication.make(32),
                run: { kind: "idle" },
                assistant: [],
                tools: [],
              },
              HistoryRevision.make("newer-destination"),
            ),
          );
          yield* waitFor(registry, state.historyReplacing(firstChat), (value) => !value);
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))),
            [assistant(secondMessageId, "Newer destination")],
          );
          assert.deepStrictEqual(
            [...registry.get(state.live(firstChat)).assistant.keys()],
            [thirdMessageId, nextMessageId],
          );
          assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [
            assistant(thirdMessageId, "Current delivery"),
          ]);
          assert.strictEqual(
            draftBlock(registry.get(state.live(firstChat)), nextMessageId, 0)?.text,
            "Current delta",
          );
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live("discards an older navigation draft after a newer replacement snapshot is accepted", () =>
    Effect.gen(function* () {
      const navigation = yield* Deferred.make<NavigateHistoryResult>();
      const started = yield* Deferred.make<void>();
      const server = yield* snapshotFixture({
        navigateHistory: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(navigation))),
      });
      yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() => server.release);
        const registry = yield* registryInScope;
        const state = make({ url: yield* endpoint });
        registry.mount(state.live(firstChat));
        const route = yield* Queue.take(server.opened);
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, snapshot());
        yield* waitFor(registry, state.connection, (value) => value.kind === "active");
        registry.set(state.navigateHistory(firstChat), {
          targetId: HistoryEntryId.make("older-destination"),
          expectedVersion: HistoryVersion.make("initial"),
        });
        yield* Deferred.await(started);
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          publication: Publication.make(30),
          event: { type: "history-replaced" },
        });
        const refresh = yield* Queue.take(server.requests);
        yield* Deferred.succeed(
          refresh.reply,
          snapshot(
            [assistant(secondMessageId, "Newer destination")],
            undefined,
            {
              publication: Publication.make(30),
              run: { kind: "idle" },
              assistant: [],
              tools: [],
            },
            HistoryRevision.make("newer-destination"),
          ),
        );
        yield* waitFor(registry, state.historyReplacing(firstChat), (value) => !value);
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          publication: Publication.make(31),
          event: {
            type: "text-delta",
            messageId: nextMessageId,
            contentIndex: 0,
            text: "Current branch delta",
          },
        });
        yield* waitFor(
          registry,
          state.live(firstChat),
          (value) => draftBlock(value, nextMessageId, 0)?.text === "Current branch delta",
        );
        yield* Deferred.succeed(navigation, {
          kind: "applied",
          draft: AgentPrompt.make({
            text: "Obsolete recovered prompt",
            attachments: [recoveredImage],
          }),
          snapshot: snapshot(
            [assistant(firstMessageId, "Older destination")],
            undefined,
            {
              publication: Publication.make(20),
              run: { kind: "idle" },
              assistant: [],
              tools: [],
            },
            HistoryRevision.make("older-destination"),
          ),
        });
        const result = yield* AtomRegistry.getResult(registry, state.navigateHistory(firstChat), {
          suspendOnWaiting: true,
        });
        assert.deepStrictEqual(result, { kind: "cancelled" });
        assert.isFalse(registry.get(state.historyReplacing(firstChat)));
        assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))), [
          assistant(secondMessageId, "Newer destination"),
        ]);
        assert.strictEqual(
          draftBlock(registry.get(state.live(firstChat)), nextMessageId, 0)?.text,
          "Current branch delta",
        );
        assert.deepStrictEqual(registry.get(state.live(firstChat)).run, { kind: "running" });
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live(
    "drops pre-replacement deliveries when navigation replies before queued Events frames",
    () =>
      Effect.gen(function* () {
        let current = snapshot();
        const selected = snapshot(
          [assistant(firstMessageId, "Selected response")],
          undefined,
          { publication: Publication.make(10), run: { kind: "idle" }, assistant: [], tools: [] },
          HistoryRevision.make("destination"),
        );
        const server = yield* fixture({
          transcript: () => Effect.sync(() => current),
          sendMessage: () => Effect.succeed({ kind: "handled" }),
          abort: () => Effect.void,
          navigateHistory: () =>
            Effect.sync(() => {
              current = selected;
              return { kind: "applied", snapshot: selected, draft: null } as const;
            }),
        });
        yield* Effect.gen(function* () {
          const registry = yield* registryInScope;
          const state = make({ url: yield* endpoint });
          registry.mount(state.live(firstChat));
          const route = yield* Queue.take(server.opened);
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          registry.set(state.navigateHistory(firstChat), {
            targetId: HistoryEntryId.make("destination"),
            expectedVersion: HistoryVersion.make("initial"),
          });
          yield* AtomRegistry.getResult(registry, state.navigateHistory(firstChat), {
            suspendOnWaiting: true,
          });
          yield* Queue.offerAll(route.queue, [
            {
              chatId: firstChat,
              publication: Publication.make(8),
              origin: "delivery",
              event: {
                type: "message-settled",
                message: assistant(orphanMessageId, "Abandoned delivery"),
              },
            },
            {
              chatId: firstChat,
              publication: Publication.make(10),
              event: { type: "history-replaced" },
            },
            {
              chatId: firstChat,
              publication: Publication.make(9),
              event: { type: "notice", level: "info", message: "Delayed notice" },
            },
            {
              chatId: firstChat,
              publication: Publication.make(11),
              event: {
                type: "text-delta",
                messageId: nextMessageId,
                contentIndex: 0,
                text: "Current branch",
              },
            },
          ]);
          yield* waitFor(
            registry,
            state.live(firstChat),
            (value) => draftBlock(value, nextMessageId, 0)?.text === "Current branch",
          );
          yield* AtomRegistry.getResult(registry, state.transcript(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))),
            [assistant(firstMessageId, "Selected response")],
          );
          assert.deepStrictEqual(
            [...registry.get(state.live(firstChat)).assistant.keys()],
            [nextMessageId],
          );
          assert.deepStrictEqual(
            registry.get(state.live(firstChat)).notices.map((notice) => notice.message),
            ["Delayed notice"],
          );
          assert.isFalse(registry.get(state.historyReplacing(firstChat)));
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "keeps a rejected workspace and removes a confirmed deletion even when refresh fails",
    () =>
      Effect.gen(function* () {
        let rejectDeletion = true;
        let refreshFails = false;
        const staleStarted = yield* Deferred.make<void>();
        const staleReply = yield* Deferred.make<readonly Workspace[]>();
        let holdRead = false;
        const server = yield* fixture({
          transcript: () => Effect.succeed(snapshot()),
          sendMessage: () => Effect.succeed({ kind: "handled" }),
          abort: () => Effect.void,
          listWorkspaces: () =>
            Effect.gen(function* () {
              if (holdRead) {
                holdRead = false;
                yield* Deferred.succeed(staleStarted, undefined);
                return yield* Deferred.await(staleReply);
              }
              if (refreshFails)
                return yield* new ApplicationError({
                  reason: "operation",
                  message: "Refresh unavailable",
                });
              return [webWorkspace];
            }),
          deleteWorkspace: () =>
            rejectDeletion
              ? Effect.fail(
                  new ApplicationError({
                    reason: "conflict",
                    message: "Archive the existing conversation first",
                  }),
                )
              : Effect.sync(() => {
                  refreshFails = true;
                  return [firstChat, secondChat];
                }),
        });
        yield* Effect.gen(function* () {
          const state = make({ url: yield* endpoint });
          const registry = yield* registryInScope;
          registry.mount(state.workspaces);
          yield* AtomRegistry.getResult(registry, state.workspaces);
          registry.set(state.deleteWorkspace, { workspaceId: webWorkspace.id });
          const rejected = yield* AtomRegistry.getResult(registry, state.deleteWorkspace, {
            suspendOnWaiting: true,
          }).pipe(Effect.flip);
          assert.instanceOf(rejected, ApplicationError);
          if (rejected instanceof ApplicationError) {
            assert.strictEqual(rejected.reason, "conflict");
          }
          yield* AtomRegistry.getResult(registry, state.workspaces, { suspendOnWaiting: true });
          assert.deepStrictEqual(
            Option.getOrThrow(AsyncResult.value(registry.get(state.workspaces))),
            [webWorkspace],
          );
          assert.strictEqual(registry.get(state.connection).kind, "active");
          rejectDeletion = false;
          holdRead = true;
          registry.refresh(state.workspaces);
          yield* Deferred.await(staleStarted);
          registry.set(state.deleteWorkspace, { workspaceId: webWorkspace.id });
          const deletedChatIds = yield* AtomRegistry.getResult(registry, state.deleteWorkspace, {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(deletedChatIds, [firstChat, secondChat]);
          assert.deepStrictEqual(
            Option.getOrThrow(AsyncResult.value(registry.get(state.workspaces))),
            [],
          );
          yield* Deferred.succeed(staleReply, [webWorkspace]);
          yield* waitFor(
            registry,
            state.workspaces,
            (value) => value._tag === "Failure" && !value.waiting,
          );
          assert.deepStrictEqual(
            Option.getOrThrow(AsyncResult.value(registry.get(state.workspaces))),
            [],
          );
          assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.deleteWorkspace)), [
            firstChat,
            secondChat,
          ]);
          assert.strictEqual(registry.get(state.connection).kind, "active");
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live("retains the global schedule snapshot after ScheduleError and recovers on refresh", () =>
    Effect.gen(function* () {
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot()),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* server.scheduleDirectory;
        const id = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000088");
        const definition = `${directory}/enabled/${id}`;
        yield* fileSystem.makeDirectory(definition);
        yield* fileSystem.writeFileString(`${definition}/meta.json`, "invalid metadata");
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.schedules);
        const loaded = yield* AtomRegistry.getResult(registry, state.schedules);
        assert.strictEqual(loaded.entries[0]?.view.id, id);
        assert.strictEqual(loaded.entries[0]?.view.kind, "invalid");
        assert.isNull(loaded.entries[0]?.ownerWorkspaceId);
        const revision = Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000099");
        const runDirectory = `${directory}/runs/${id}/scheduled-1000-${revision}`;
        yield* fileSystem.makeDirectory(runDirectory, { recursive: true });
        yield* fileSystem.writeFileString(`${runDirectory}/run.json`, "broken run metadata");
        registry.refresh(state.schedules);
        yield* waitFor(
          registry,
          state.schedules,
          (value) => value._tag === "Failure" && !value.waiting,
        );
        const failed = registry.get(state.schedules);
        if (failed._tag !== "Failure") return yield* Effect.die("Expected schedule read failure");
        assert.instanceOf(
          Option.getOrNull(Cause.findErrorOption(failed.cause)),
          Schedule.ScheduleError,
        );
        assert.deepStrictEqual(Option.getOrThrow(AsyncResult.value(failed)), loaded);
        assert.strictEqual(registry.get(state.connection).kind, "active");

        yield* fileSystem.remove(runDirectory, { recursive: true });
        yield* fileSystem.remove(definition, { recursive: true });
        registry.refresh(state.schedules);
        const recovered = yield* AtomRegistry.getResult(registry, state.schedules, {
          suspendOnWaiting: true,
        });
        assert.deepStrictEqual(recovered.entries, []);
      }).pipe(Effect.scoped, Effect.provide(server.layer), Effect.provide(BunFileSystem.layer));
    }),
  );

  it.live("refreshes changed context without losing drafts or mixing chats", () =>
    Effect.gen(function* () {
      let usage: ContextUsage = {
        kind: "available",
        contextWindow: 200_000,
        usedTokens: 120_000,
        messagesTokens: 110_000,
        systemPromptTokens: 3_000,
        systemToolsTokens: 4_000,
        systemContextTokens: 2_000,
        skillsTokens: 1_000,
      };
      const server = yield* fixture({
        transcript: () => Effect.sync(() => snapshot([message], { kind: "unavailable" })),
        contextUsage: (chatId) =>
          Effect.sync(() => (chatId === firstChat ? usage : ({ kind: "unavailable" } as const))),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.observeContext(firstChat));
        registry.mount(state.observeContext(secondChat));
        const route = yield* Queue.take(server.opened);
        yield* waitFor(registry, state.contextUsage(firstChat), AsyncResult.isSuccess);
        yield* waitFor(registry, state.contextUsage(secondChat), AsyncResult.isSuccess);
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: {
            type: "text-delta",
            messageId: firstMessageId,
            contentIndex: 0,
            text: "keep this draft",
          },
        });
        yield* waitFor(
          registry,
          state.live(firstChat),
          (live) => draftBlock(live, firstMessageId, 0)?.text === "keep this draft",
        );
        usage = {
          kind: "available",
          contextWindow: 100_000,
          usedTokens: 35_000,
          messagesTokens: 25_000,
          systemPromptTokens: 3_000,
          systemToolsTokens: 4_000,
          systemContextTokens: 2_000,
          skillsTokens: 1_000,
        };
        registry.set(state.contextUsage(firstChat), undefined);
        yield* waitFor(
          registry,
          state.contextUsage(firstChat),
          (result) =>
            result._tag === "Success" &&
            !result.waiting &&
            result.value.kind === "available" &&
            result.value.usedTokens === 35_000,
        );
        assert.deepStrictEqual(
          AsyncResult.getOrThrow(registry.get(state.contextUsage(firstChat))),
          usage,
        );
        assert.deepStrictEqual(
          AsyncResult.getOrThrow(registry.get(state.contextUsage(secondChat))),
          { kind: "unavailable" },
        );
        assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))), [
          message,
        ]);
        assert.strictEqual(
          draftBlock(registry.get(state.live(firstChat)), firstMessageId, 0)?.text,
          "keep this draft",
        );
        assert.strictEqual(registry.get(state.live(firstChat)).run.kind, "running");
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("keeps newer context results when an older transcript response settles later", () =>
    Effect.gen(function* () {
      let usage: ContextUsage = {
        kind: "available",
        contextWindow: 200_000,
        usedTokens: 12_345,
        messagesTokens: 10_000,
        systemPromptTokens: 800,
        systemToolsTokens: 700,
        systemContextTokens: 500,
        skillsTokens: 345,
      };
      const transcriptRequests = yield* Queue.unbounded<{
        readonly reply: Deferred.Deferred<TranscriptSnapshot>;
        readonly returned: Deferred.Deferred<void>;
      }>();
      const server = yield* fixture({
        transcript: () =>
          Effect.gen(function* () {
            const reply = yield* Deferred.make<TranscriptSnapshot>();
            const returned = yield* Deferred.make<void>();
            yield* Queue.offer(transcriptRequests, { reply, returned });
            return yield* Deferred.await(reply).pipe(
              Effect.ensuring(Deferred.succeed(returned, undefined)),
              Effect.uninterruptible,
            );
          }),
        contextUsage: () => Effect.sync(() => usage),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.observeContext(firstChat));
        registry.mount(state.transcript(firstChat));

        const initial = yield* Queue.take(transcriptRequests);
        yield* Deferred.succeed(initial.reply, snapshot([message], { kind: "unavailable" }));
        yield* Deferred.await(initial.returned);
        yield* waitFor(
          registry,
          state.contextUsage(firstChat),
          (value) =>
            value._tag === "Success" &&
            !value.waiting &&
            value.value.kind === "available" &&
            value.value.usedTokens === 12_345,
        );

        usage = {
          kind: "available",
          contextWindow: 200_000,
          usedTokens: 6_000,
          messagesTokens: 4_500,
          systemPromptTokens: 700,
          systemToolsTokens: 400,
          systemContextTokens: 250,
          skillsTokens: 150,
        };
        registry.refresh(state.transcript(firstChat));
        const stale = yield* Queue.take(transcriptRequests);
        registry.set(state.contextUsage(firstChat), undefined);
        yield* waitFor(
          registry,
          state.contextUsage(firstChat),
          (value) =>
            value._tag === "Success" &&
            !value.waiting &&
            value.value.kind === "available" &&
            value.value.usedTokens === 6_000,
        );

        yield* Deferred.succeed(stale.reply, snapshot([message], { kind: "unavailable" }));
        yield* Deferred.await(stale.returned);
        assert.deepStrictEqual(
          AsyncResult.getOrThrow(registry.get(state.contextUsage(firstChat))),
          usage,
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("consumes connection readiness in the initial context read", () =>
    Effect.gen(function* () {
      const reads: Array<ChatId> = [];
      const server = yield* fixture({
        contextUsage: (chatId) =>
          Effect.sync(() => {
            reads.push(chatId);
            return { kind: "unavailable" } as const;
          }),
        transcript: () => Effect.succeed(snapshot()),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.observeContext(firstChat));
        yield* waitFor(
          registry,
          state.contextUsage(firstChat),
          (value) => value._tag === "Success" && !value.waiting,
        );
        yield* Effect.sleep("50 millis");
        assert.deepStrictEqual(
          AsyncResult.getOrThrow(registry.get(state.contextUsage(firstChat))),
          { kind: "unavailable" },
        );
        assert.deepStrictEqual(reads, [firstChat]);
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("coalesces context refresh requests into one follow-up and never overlaps calls", () =>
    Effect.gen(function* () {
      let inFlight = 0;
      let maxInFlight = 0;
      const requests = yield* Queue.unbounded<Deferred.Deferred<ContextUsage>>();
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot()),
        contextUsage: () =>
          Effect.gen(function* () {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            const reply = yield* Deferred.make<ContextUsage>();
            yield* Queue.offer(requests, reply);
            return yield* Deferred.await(reply).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  inFlight -= 1;
                }),
              ),
              Effect.uninterruptible,
            );
          }),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.observeContext(firstChat));
        const first = yield* Queue.take(requests);
        registry.set(state.contextUsage(firstChat), undefined);
        registry.set(state.contextUsage(firstChat), undefined);
        registry.set(state.contextUsage(firstChat), undefined);
        yield* Deferred.succeed(first, { kind: "unavailable" });
        const second = yield* Queue.take(requests);
        assert.strictEqual(maxInFlight, 1);
        yield* Deferred.succeed(second, {
          kind: "available",
          contextWindow: 100_000,
          usedTokens: 777,
          messagesTokens: 500,
          systemPromptTokens: 100,
          systemToolsTokens: 100,
          systemContextTokens: 50,
          skillsTokens: 27,
        });
        yield* waitFor(
          registry,
          state.contextUsage(firstChat),
          (value) =>
            value._tag === "Success" &&
            !value.waiting &&
            value.value.kind === "available" &&
            value.value.usedTokens === 777,
        );
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Queue.poll(requests)));
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live(
    "keeps the last context estimate while a replacement for a superseded failure is pending",
    () =>
      Effect.gen(function* () {
        const requests =
          yield* Queue.unbounded<Deferred.Deferred<ContextUsage, ApplicationError>>();
        const server = yield* fixture({
          transcript: () => Effect.succeed(snapshot()),
          contextUsage: () =>
            Effect.gen(function* () {
              const reply = yield* Deferred.make<ContextUsage, ApplicationError>();
              yield* Queue.offer(requests, reply);
              return yield* Deferred.await(reply);
            }),
          sendMessage: () => Effect.succeed({ kind: "handled" }),
          abort: () => Effect.void,
        });
        yield* Effect.gen(function* () {
          const state = make({ url: yield* endpoint });
          const registry = yield* registryInScope;
          registry.mount(state.observeContext(firstChat));
          const initial = yield* Queue.take(requests);
          yield* Deferred.succeed(initial, {
            kind: "available",
            contextWindow: 100_000,
            usedTokens: 777,
            messagesTokens: 500,
            systemPromptTokens: 100,
            systemToolsTokens: 100,
            systemContextTokens: 50,
            skillsTokens: 27,
          });
          yield* waitFor(
            registry,
            state.contextUsage(firstChat),
            (value) => value._tag === "Success" && !value.waiting,
          );

          registry.set(state.contextUsage(firstChat), undefined);
          const stale = yield* Queue.take(requests);
          registry.set(state.contextUsage(firstChat), undefined);
          yield* Deferred.fail(
            stale,
            new ApplicationError({ reason: "operation", message: "Context read failed" }),
          );
          const replacement = yield* Queue.take(requests);
          const refreshing = registry.get(state.contextUsage(firstChat));
          assert.strictEqual(refreshing._tag, "Success");
          assert.isTrue(refreshing.waiting);
          assert.deepStrictEqual(AsyncResult.getOrThrow(refreshing), {
            kind: "available",
            contextWindow: 100_000,
            usedTokens: 777,
            messagesTokens: 500,
            systemPromptTokens: 100,
            systemToolsTokens: 100,
            systemContextTokens: 50,
            skillsTokens: 27,
          });

          yield* Deferred.succeed(replacement, {
            kind: "available",
            contextWindow: 100_000,
            usedTokens: 444,
            messagesTokens: 300,
            systemPromptTokens: 50,
            systemToolsTokens: 50,
            systemContextTokens: 30,
            skillsTokens: 14,
          });
          yield* waitFor(
            registry,
            state.contextUsage(firstChat),
            (value) => value._tag === "Success" && !value.waiting,
          );
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.contextUsage(firstChat))),
            {
              kind: "available",
              contextWindow: 100_000,
              usedTokens: 444,
              messagesTokens: 300,
              systemPromptTokens: 50,
              systemToolsTokens: 50,
              systemContextTokens: 30,
              skillsTokens: 14,
            },
          );
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live("ignores stale context replies from a released observer", () =>
    Effect.gen(function* () {
      const firstRequests = yield* Queue.unbounded<Deferred.Deferred<ContextUsage>>();
      const secondRequests = yield* Queue.unbounded<Deferred.Deferred<ContextUsage>>();
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot()),
        contextUsage: (chatId) =>
          Effect.gen(function* () {
            const reply = yield* Deferred.make<ContextUsage>();
            yield* Queue.offer(chatId === firstChat ? firstRequests : secondRequests, reply);
            return yield* Deferred.await(reply).pipe(Effect.uninterruptible);
          }),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        const releaseFirst = registry.mount(state.observeContext(firstChat));
        registry.mount(state.contextUsage(firstChat));
        const stale = yield* Queue.take(firstRequests);

        releaseFirst();
        registry.refresh(state.observeContext(firstChat));

        const releaseSecond = registry.mount(state.observeContext(secondChat));
        registry.mount(state.contextUsage(secondChat));
        const fresh = yield* Queue.take(secondRequests);
        yield* Deferred.succeed(fresh, {
          kind: "available",
          contextWindow: 100_000,
          usedTokens: 444,
          messagesTokens: 300,
          systemPromptTokens: 50,
          systemToolsTokens: 50,
          systemContextTokens: 30,
          skillsTokens: 14,
        });
        yield* waitFor(
          registry,
          state.contextUsage(secondChat),
          (value) =>
            value._tag === "Success" &&
            !value.waiting &&
            value.value.kind === "available" &&
            value.value.usedTokens === 444,
        );

        yield* Deferred.succeed(stale, {
          kind: "available",
          contextWindow: 100_000,
          usedTokens: 99_999,
          messagesTokens: 90_000,
          systemPromptTokens: 2_000,
          systemToolsTokens: 2_000,
          systemContextTokens: 3_000,
          skillsTokens: 2_999,
        });
        yield* Effect.yieldNow;
        const first = registry.get(state.contextUsage(firstChat));
        assert.isFalse(first.waiting);
        if (first._tag === "Success" && first.value.kind === "available") {
          assert.notStrictEqual(first.value.usedTokens, 99_999);
        }

        releaseSecond();
        registry.refresh(state.observeContext(secondChat));
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("reconnects context reads only for the mounted chat", () =>
    Effect.gen(function* () {
      let recordingReconnect = false;
      const reconnectReads: Array<ChatId> = [];
      const reconnectFirst = yield* Deferred.make<ChatId>();
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot([message])),
        contextUsage: (chatId) =>
          Effect.gen(function* () {
            if (recordingReconnect) {
              reconnectReads.push(chatId);
              yield* Deferred.succeed(reconnectFirst, chatId);
            }
            return { kind: "unavailable" } as const;
          }),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.transcript(firstChat));
        registry.mount(state.transcript(secondChat));
        registry.mount(state.observeContext(secondChat));
        registry.mount(state.contextUsage(secondChat));
        const first = yield* Queue.take(server.opened);
        yield* waitFor(registry, state.connection, (value) => value.kind === "active");
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        yield* waitFor(
          registry,
          state.transcript(secondChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        yield* waitFor(
          registry,
          state.contextUsage(secondChat),
          (value) => value._tag === "Success" && !value.waiting,
        );

        yield* Queue.end(first.queue);
        yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");

        recordingReconnect = true;
        registry.set(state.ensure, undefined);
        const second = yield* Queue.take(server.opened);
        assert.strictEqual(yield* Deferred.await(reconnectFirst), secondChat);
        yield* waitFor(registry, state.connection, (value) => value.kind === "active");
        assert.isTrue(reconnectReads.length > 0);
        assert.isTrue(reconnectReads.every((chatId) => chatId === secondChat));
        yield* Queue.end(second.queue);
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("shows a confirmed model switch while the initial snapshot is still pending", () =>
    Effect.gen(function* () {
      const model = { provider: "fixture", id: "selected", name: "Selected" };
      const snapshotGate = yield* Deferred.make<TranscriptSnapshot, ApplicationError>();
      const server = yield* fixture({
        transcript: () => Deferred.await(snapshotGate),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
        availableModels: () => Effect.succeed([model]),
        switchModel: () => Effect.succeed({ kind: "persistence-unconfirmed", model }),
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.availableModels(firstChat));
        yield* waitFor(registry, state.availableModels(firstChat), AsyncResult.isSuccess);
        registry.mount(state.currentModel(firstChat));
        yield* waitFor(registry, state.currentModel(firstChat), (result) => result.waiting);
        registry.set(state.switchModel(firstChat), model);
        yield* waitFor(
          registry,
          state.switchModel(firstChat),
          (result) => AsyncResult.isSuccess(result) && !result.waiting,
        );
        const current = registry.get(state.currentModel(firstChat));
        assert.isTrue(AsyncResult.isSuccess(current));
        assert.isTrue(current.waiting);
        assert.deepStrictEqual(AsyncResult.getOrThrow(current), model);
        assert.strictEqual(
          AsyncResult.getOrThrow(registry.get(state.switchModel(firstChat))).kind,
          "persistence-unconfirmed",
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("retains a confirmed model switch when snapshots fail without a previous value", () =>
    Effect.gen(function* () {
      const model = { provider: "fixture", id: "selected", name: "Selected" };
      let readable = false;
      const server = yield* fixture({
        transcript: () =>
          readable
            ? Effect.succeed(snapshot())
            : Effect.fail(
                new ApplicationError({ reason: "operation", message: "Snapshot unavailable" }),
              ),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
        availableModels: () => Effect.succeed([model]),
        switchModel: () => Effect.succeed({ kind: "persistence-unconfirmed", model }),
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.currentModel(firstChat));
        registry.mount(state.availableModels(firstChat));
        yield* waitFor(registry, state.currentModel(firstChat), AsyncResult.isFailure);
        yield* waitFor(registry, state.availableModels(firstChat), AsyncResult.isSuccess);
        registry.set(state.switchModel(firstChat), model);
        yield* waitFor(
          registry,
          state.switchModel(firstChat),
          (result) => AsyncResult.isSuccess(result) && !result.waiting,
        );
        yield* waitFor(
          registry,
          state.currentModel(firstChat),
          (result) => AsyncResult.isFailure(result) && !result.waiting,
        );
        assert.deepStrictEqual(
          Option.getOrNull(AsyncResult.value(registry.get(state.currentModel(firstChat)))),
          model,
        );
        assert.strictEqual(
          AsyncResult.getOrThrow(registry.get(state.switchModel(firstChat))).kind,
          "persistence-unconfirmed",
        );
        assert.isTrue(AsyncResult.isFailure(registry.get(state.transcript(firstChat))));
        readable = true;
        registry.refresh(state.currentModel(firstChat));
        yield* waitFor(
          registry,
          state.currentModel(firstChat),
          (result) => AsyncResult.isSuccess(result) && !result.waiting,
        );
        assert.deepStrictEqual(
          AsyncResult.getOrThrow(registry.get(state.currentModel(firstChat))),
          model,
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("retains a confirmed model across a stale read and failed refresh", () =>
    Effect.gen(function* () {
      const previous = { provider: "fixture", id: "previous", name: "Previous" };
      const selected = { provider: "fixture", id: "selected", name: "Selected" };
      const requests =
        yield* Queue.unbounded<Deferred.Deferred<TranscriptSnapshot, ApplicationError>>();
      const switchStarted = yield* Deferred.make<void>();
      const switchReply = yield* Deferred.make<void>();
      const server = yield* fixture({
        transcript: () =>
          Effect.gen(function* () {
            const reply = yield* Deferred.make<TranscriptSnapshot, ApplicationError>();
            yield* Queue.offer(requests, reply);
            return yield* Deferred.await(reply);
          }),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
        switchModel: () =>
          Deferred.succeed(switchStarted, undefined).pipe(
            Effect.andThen(Deferred.await(switchReply)),
            Effect.as({ kind: "persistence-unconfirmed" as const, model: selected }),
          ),
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        const current = state.currentModel(firstChat);
        const switching = state.switchModel(firstChat);
        registry.mount(current);
        yield* Deferred.succeed(yield* Queue.take(requests), {
          ...snapshot(),
          currentModel: previous,
        });
        yield* waitFor(
          registry,
          current,
          (result) => AsyncResult.isSuccess(result) && !result.waiting,
        );

        registry.set(switching, selected);
        yield* Deferred.await(switchStarted);
        registry.refresh(current);
        const stale = yield* Queue.take(requests);
        yield* Deferred.succeed(switchReply, undefined);
        yield* waitFor(
          registry,
          switching,
          (result) => AsyncResult.isSuccess(result) && !result.waiting,
        );
        yield* Deferred.succeed(stale, { ...snapshot(), currentModel: previous });
        const followup = yield* Queue.take(requests);
        assert.deepStrictEqual(
          Option.getOrThrow(AsyncResult.value(registry.get(current))),
          selected,
        );
        yield* Deferred.fail(
          followup,
          new ApplicationError({ reason: "operation", message: "Read failed" }),
        );
        yield* waitFor(
          registry,
          current,
          (result) => AsyncResult.isFailure(result) && !result.waiting,
        );
        assert.deepStrictEqual(
          Option.getOrThrow(AsyncResult.value(registry.get(current))),
          selected,
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live(
    "times out skill discovery locally after thirty seconds and refreshes without reconnecting",
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        let reads = 0;
        const server = yield* fixture({
          transcript: () => Effect.succeed(snapshot()),
          sendMessage: () => Effect.succeed({ kind: "handled" }),
          abort: () => Effect.void,
          availableSkills: () =>
            Effect.gen(function* () {
              reads += 1;
              if (reads === 1) {
                yield* Deferred.succeed(reading, undefined);
                return yield* Effect.never;
              }
              return [{ name: "review", description: "Review the current changes" }];
            }),
        });
        yield* Effect.gen(function* () {
          const state = make({ url: yield* endpoint });
          const registry = yield* registryInScope;
          registry.mount(state.connection);
          const route = yield* Queue.take(server.opened);
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");

          // Keep the established socket's heartbeat live while advancing the catalog deadline.
          yield* Effect.acquireRelease(
            Effect.sync(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })),
            () => Effect.sync(() => vi.useRealTimers()),
          );
          const skills = state.availableSkills(firstChat);
          registry.mount(skills);
          yield* Deferred.await(reading);

          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_000));
          assert.strictEqual(registry.get(skills)._tag, "Initial");
          assert.isTrue(registry.get(skills).waiting);
          assert.deepStrictEqual(registry.get(state.connection), { kind: "active" });

          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(23_999));
          assert.strictEqual(registry.get(skills)._tag, "Initial");
          assert.isTrue(registry.get(skills).waiting);

          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          const failed = registry.get(skills);
          if (failed._tag !== "Failure") return yield* Effect.die("Expected skill catalog timeout");
          assert.isFalse(failed.waiting);
          const error = Option.getOrThrow(Cause.findErrorOption(failed.cause));
          assert.instanceOf(error, ApplicationError);
          if (!(error instanceof ApplicationError))
            return yield* Effect.die("Expected application error");
          assert.strictEqual(error.reason, "operation");
          assert.deepStrictEqual(registry.get(state.connection), { kind: "active" });
          assert.strictEqual(server.openCount(), 1);
          assert.isFalse(yield* Deferred.isDone(route.closed));

          registry.refresh(skills);
          yield* waitFor(registry, skills, (value) => value._tag === "Success" && !value.waiting);
          assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(skills)), [
            { name: "review", description: "Review the current changes" },
          ]);
          assert.deepStrictEqual(registry.get(state.connection), { kind: "active" });
          assert.strictEqual(server.openCount(), 1);
          assert.isFalse(yield* Deferred.isDone(route.closed));
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "activates the connection after an initial list rejection and allows a successful retry",
    () =>
      Effect.gen(function* () {
        const workspace = webWorkspace;
        const rejection = new ApplicationError({ reason: "operation", message: "Read failed" });
        let reads = 0;
        const server = yield* fixture({
          transcript: () => Effect.succeed(snapshot()),
          sendMessage: () => Effect.succeed({ kind: "handled" }),
          abort: () => Effect.void,
          listWorkspaces: () =>
            Effect.suspend(() => {
              reads += 1;
              return reads === 1 ? Effect.fail(rejection) : Effect.succeed([workspace]);
            }),
        });
        yield* Effect.gen(function* () {
          const state = make({ url: yield* endpoint });
          const registry = yield* registryInScope;
          registry.mount(state.workspaces);
          yield* waitFor(
            registry,
            state.workspaces,
            (value) => value._tag === "Failure" && !value.waiting,
          );
          const result = registry.get(state.workspaces);
          if (result._tag !== "Failure")
            return yield* Effect.die("Expected initial list rejection");
          assert.deepStrictEqual(Option.getOrNull(Cause.findErrorOption(result.cause)), rejection);
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          assert.strictEqual(registry.get(state.connection).kind, "active");
          assert.strictEqual(reads, 1);
          registry.refresh(state.workspaces);
          yield* waitFor(
            registry,
            state.workspaces,
            (value) => value._tag === "Success" && !value.waiting,
          );
          assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.workspaces)), [
            workspace,
          ]);
          assert.strictEqual(registry.get(state.connection).kind, "active");
          assert.strictEqual(reads, 2);
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live("keeps saved workspace settings visible while the list refresh waits or fails", () =>
    Effect.gen(function* () {
      const refreshed = yield* Deferred.make<readonly Workspace[], ApplicationError>();
      const staleStarted = yield* Deferred.make<void>();
      const staleReply = yield* Deferred.make<readonly Workspace[]>();
      const refreshStarted = yield* Deferred.make<void>();
      const saved = { ...webWorkspace, worktree: { branch: "main", prefix: "pico/" } };
      let reads = 0;
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot()),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
        listWorkspaces: () =>
          Effect.gen(function* () {
            reads++;
            if (reads === 1) return [webWorkspace];
            if (reads === 2) {
              yield* Deferred.succeed(staleStarted, undefined);
              return yield* Deferred.await(staleReply);
            }
            yield* Deferred.succeed(refreshStarted, undefined);
            return yield* Deferred.await(refreshed);
          }),
        updateWorkspace: () => Effect.succeed(saved),
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.workspaces);
        yield* AtomRegistry.getResult(registry, state.workspaces);
        yield* waitFor(registry, state.connection, (value) => value.kind === "active");
        registry.refresh(state.workspaces);
        yield* Deferred.await(staleStarted);
        registry.set(state.updateWorkspace, {
          workspaceId: webWorkspace.id,
          configuration: {
            kind: "worktree",
            repository: webWorkspace.defaultCwd,
            settings: saved.worktree,
          },
        });
        yield* AtomRegistry.getResult(registry, state.updateWorkspace, { suspendOnWaiting: true });
        assert.deepStrictEqual(
          Option.getOrThrow(AsyncResult.value(registry.get(state.workspaces))),
          [saved],
        );
        assert.isTrue(registry.get(state.workspaces).waiting);
        yield* Deferred.succeed(staleReply, [webWorkspace]);
        yield* Deferred.await(refreshStarted);
        assert.deepStrictEqual(
          Option.getOrThrow(AsyncResult.value(registry.get(state.workspaces))),
          [saved],
        );
        yield* Deferred.fail(
          refreshed,
          new ApplicationError({ reason: "operation", message: "Read failed" }),
        );
        yield* waitFor(
          registry,
          state.workspaces,
          (value) => value._tag === "Failure" && !value.waiting,
        );
        assert.deepStrictEqual(
          Option.getOrThrow(AsyncResult.value(registry.get(state.workspaces))),
          [saved],
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("preserves close outcomes and confirmed removal when chat-list refresh fails", () =>
    Effect.gen(function* () {
      const chats: readonly ChatListEntry[] = [firstChat, secondChat].map((id) => ({
        id,
        workspaceId: webWorkspace.id,
        cwd: webWorkspace.defaultCwd,
        externalId: null,
        title: null,
        createdAt: 1,
        archivedAt: null,
      }));
      let reads = 0;
      const staleStarted = yield* Deferred.make<void>();
      const staleReply = yield* Deferred.make<readonly ChatListEntry[]>();
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot()),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
        listChats: () =>
          Effect.gen(function* () {
            reads++;
            if (reads === 1) return chats;
            if (reads === 3) {
              yield* Deferred.succeed(staleStarted, undefined);
              return yield* Deferred.await(staleReply);
            }
            return yield* new ApplicationError({ reason: "operation", message: "Read failed" });
          }),
        closeChat: (_, options) =>
          options.allowDirtyWorktree
            ? Effect.succeed({ kind: "closed" })
            : Effect.succeed({ kind: "worktree-confirmation-required" }),
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        const list = state.chats(webWorkspace.id);
        const close = state.closeChat(webWorkspace.id);
        registry.mount(list);
        yield* AtomRegistry.getResult(registry, list);
        registry.set(close, { chatId: firstChat, allowDirtyWorktree: false });
        const confirmation = yield* AtomRegistry.getResult(registry, close, {
          suspendOnWaiting: true,
        });
        yield* waitFor(registry, list, (value) => value._tag === "Failure" && !value.waiting);
        assert.strictEqual(confirmation.kind, "worktree-confirmation-required");
        assert.deepStrictEqual(Option.getOrThrow(AsyncResult.value(registry.get(list))), chats);

        registry.refresh(list);
        yield* Deferred.await(staleStarted);
        registry.set(close, { chatId: firstChat, allowDirtyWorktree: true });
        const closed = yield* AtomRegistry.getResult(registry, close, { suspendOnWaiting: true });
        assert.deepStrictEqual(
          Option.getOrThrow(AsyncResult.value(registry.get(list))).map((chat) => chat.id),
          [secondChat],
        );
        yield* Deferred.succeed(staleReply, chats);
        yield* waitFor(registry, list, (value) => value._tag === "Failure" && !value.waiting);
        assert.strictEqual(closed.kind, "closed");
        assert.deepStrictEqual(
          Option.getOrThrow(AsyncResult.value(registry.get(list))).map((chat) => chat.id),
          [secondChat],
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("refreshes archived membership without replacing a failed close outcome", () =>
    Effect.gen(function* () {
      const chat: ChatListEntry = {
        id: firstChat,
        workspaceId: webWorkspace.id,
        cwd: webWorkspace.defaultCwd,
        externalId: null,
        title: null,
        createdAt: 1,
        archivedAt: null,
      };
      const cleanupFailure = new ApplicationError({
        reason: "operation",
        message: "Cleanup failed",
      });
      let archived = false;
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot()),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
        listChats: () => Effect.sync(() => (archived ? [] : [chat])),
        closeChat: () =>
          Effect.suspend(() => {
            archived = true;
            return Effect.fail(cleanupFailure);
          }),
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        const list = state.chats(webWorkspace.id);
        const close = state.closeChat(webWorkspace.id);
        registry.mount(list);
        yield* AtomRegistry.getResult(registry, list);
        registry.set(close, { chatId: firstChat, allowDirtyWorktree: false });
        const error = yield* AtomRegistry.getResult(registry, close, {
          suspendOnWaiting: true,
        }).pipe(Effect.flip);
        const refreshed = yield* AtomRegistry.getResult(registry, list, { suspendOnWaiting: true });
        assert.deepStrictEqual(error, cleanupFailure);
        assert.deepStrictEqual(refreshed, []);
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );
  it.live("retains workspace lists through refresh failures and fences superseded reads", () =>
    Effect.gen(function* () {
      const workspace = webWorkspace;
      const latest = { ...workspace, name: "Renamed project" };
      const requests = yield* Queue.unbounded<{
        readonly reply: Deferred.Deferred<readonly Workspace[], ApplicationError>;
        readonly returned: Deferred.Deferred<void>;
      }>();
      const pending: Array<Deferred.Deferred<readonly Workspace[], ApplicationError>> = [];
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot()),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
        listWorkspaces: () =>
          Effect.gen(function* () {
            const reply = yield* Deferred.make<readonly Workspace[], ApplicationError>();
            const returned = yield* Deferred.make<void>();
            pending.push(reply);
            yield* Queue.offer(requests, { reply, returned });
            return yield* Deferred.await(reply).pipe(
              Effect.ensuring(Deferred.succeed(returned, undefined)),
              Effect.uninterruptible,
            );
          }),
      });
      yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.forEach(pending, (reply) => Deferred.succeed(reply, []), { discard: true }),
        );
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.workspaces);
        yield* Deferred.succeed((yield* Queue.take(requests)).reply, [workspace]);
        yield* waitFor(
          registry,
          state.workspaces,
          (value) => value._tag === "Success" && !value.waiting,
        );
        registry.refresh(state.workspaces);
        const stale = yield* Queue.take(requests);
        assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.workspaces)), [workspace]);
        registry.refresh(state.workspaces);
        yield* Deferred.succeed(stale.reply, []);
        yield* Deferred.await(stale.returned);
        yield* Deferred.succeed((yield* Queue.take(requests)).reply, [latest]);
        yield* waitFor(
          registry,
          state.workspaces,
          (value) =>
            value._tag === "Success" && !value.waiting && value.value[0]?.name === latest.name,
        );
        assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.workspaces)), [latest]);
        registry.refresh(state.workspaces);
        yield* Deferred.fail(
          (yield* Queue.take(requests)).reply,
          new ApplicationError({ reason: "operation", message: "Read failed" }),
        );
        yield* waitFor(
          registry,
          state.workspaces,
          (value) => value._tag === "Failure" && !value.waiting,
        );
        assert.deepStrictEqual(
          Option.getOrNull(AsyncResult.value(registry.get(state.workspaces))),
          [latest],
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );
  it.live("fences stale snapshots and refreshes after concurrent sends fail or complete", () =>
    Effect.gen(function* () {
      const firstRead = yield* Deferred.make<void>();
      const releaseStale = yield* Deferred.make<void>();
      const staleReturned = yield* Deferred.make<void>();
      const sent = yield* Queue.unbounded<string>();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const releaseFailure = yield* Deferred.make<void>();
      const aborted = yield* Deferred.make<void>();
      let reads = 0;
      let stored: AgentTranscript = [message, message];
      const server = yield* fixture({
        transcript: () =>
          Effect.gen(function* () {
            reads += 1;
            if (reads === 1) {
              yield* Deferred.succeed(firstRead, undefined);
              return yield* Deferred.await(releaseStale).pipe(
                Effect.as(snapshot()),
                Effect.ensuring(Deferred.succeed(staleReturned, undefined)),
                Effect.uninterruptible,
              );
            }
            return snapshot(
              stored,
              { kind: "unavailable" },
              {
                publication: Publication.make(0),
                run: { kind: "running" },
                assistant: [],
                tools: [],
              },
            );
          }),
        sendMessage: (chatId, input) =>
          Effect.gen(function* () {
            yield* Queue.offer(sent, input.text);
            if (input.text === "reject") {
              yield* Deferred.await(releaseFailure);
              return yield* Effect.fail(new ChatClosed());
            }
            yield* Deferred.await(chatId === firstChat ? releaseFirst : releaseSecond);
            if (chatId === firstChat) stored = [...stored, { ...message, timestamp: 2 }];
            return { kind: "handled" } as const;
          }),
        abort: () => Deferred.succeed(aborted, undefined).pipe(Effect.asVoid),
      });

      yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseStale, undefined));
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.live(firstChat));
        registry.mount(state.live(secondChat));
        const route = yield* Queue.take(server.opened);
        yield* Deferred.await(firstRead);
        yield* Queue.offerAll(route.queue, [
          { chatId: firstChat, event: { type: "run-started" } },
          {
            chatId: firstChat,
            event: {
              type: "thinking-delta",
              messageId: firstMessageId,
              contentIndex: 2,
              text: "plan",
            },
          },
          {
            chatId: firstChat,
            event: {
              type: "text-delta",
              messageId: firstMessageId,
              contentIndex: 7,
              text: "partial",
            },
          },
          {
            chatId: secondChat,
            event: {
              type: "text-delta",
              messageId: secondMessageId,
              contentIndex: 7,
              text: "other",
            },
          },
          { chatId: firstChat, event: { type: "message-settled", message } },
        ]);
        yield* Deferred.succeed(releaseStale, undefined);
        yield* Deferred.await(staleReturned);
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) =>
            AsyncResult.isSuccess(value) && !value.waiting && value.value.length === stored.length,
        );
        assert.deepStrictEqual(
          AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))),
          stored,
        );
        assert.strictEqual(
          draftBlock(registry.get(state.live(firstChat)), firstMessageId, 2)?.text,
          "plan",
        );
        assert.strictEqual(
          draftBlock(registry.get(state.live(firstChat)), firstMessageId, 7)?.text,
          "partial",
        );
        assert.strictEqual(
          draftBlock(registry.get(state.live(secondChat)), secondMessageId, 7)?.text,
          "other",
        );

        const releaseSendView = registry.mount(state.send(firstChat));
        registry.set(state.send(firstChat), prompt("first"));
        assert.strictEqual(yield* Queue.take(sent), "first");
        registry.set(state.send(firstChat), prompt("reject"));
        assert.strictEqual(yield* Queue.take(sent), "reject");
        registry.set(state.send(secondChat), prompt("second"));
        assert.strictEqual(yield* Queue.take(sent), "second");
        releaseSendView();
        yield* Deferred.succeed(releaseFailure, undefined);
        yield* waitFor(registry, state.send(firstChat), AsyncResult.isFailure);
        const rejected = registry.get(state.send(firstChat));
        if (!AsyncResult.isFailure(rejected)) return yield* Effect.die("Expected send failure");
        assert.instanceOf(Cause.squash(rejected.cause), ChatClosed);
        assert.isTrue(rejected.waiting);
        assert.isTrue(registry.get(state.send(secondChat)).waiting);

        registry.set(state.abort(firstChat), undefined);
        yield* Deferred.await(aborted);
        yield* waitFor(
          registry,
          state.abort(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.isTrue(registry.get(state.send(firstChat)).waiting);
        assert.strictEqual(registry.get(state.live(firstChat)).run.kind, "running");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* waitFor(registry, state.send(firstChat), (value) => !value.waiting);
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting && value.value.length === 3,
        );
        assert.isTrue(AsyncResult.isFailure(registry.get(state.send(firstChat))));
        assert.deepStrictEqual(
          AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))),
          stored,
        );
        assert.isTrue(registry.get(state.send(secondChat)).waiting);
        yield* Deferred.succeed(releaseSecond, undefined);
        yield* waitFor(
          registry,
          state.send(secondChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.strictEqual(registry.get(state.live(firstChat)).run.kind, "running");
        registry.dispose();
        yield* Deferred.await(route.closed);
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live(
    "refreshes authoritative titles after invalidation without retaining unopened chat deltas",
    () =>
      Effect.gen(function* () {
        const historical: ChatListEntry = {
          id: firstChat,
          workspaceId: webWorkspace.id,
          cwd: webWorkspace.defaultCwd,
          externalId: null,
          createdAt: 1,
          archivedAt: null,
          title: "Original",
        };
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<readonly ChatListEntry[]>();
        let reads = 0;
        const server = yield* fixture({
          listChats: () =>
            Effect.gen(function* () {
              reads++;
              if (reads === 1) return [historical];
              if (reads === 2) {
                yield* Deferred.succeed(reading, undefined);
                return yield* Deferred.await(release);
              }
              return [{ ...historical, title: "Authoritative title" }];
            }),
          transcript: () => Effect.succeed(snapshot()),
          sendMessage: () => Effect.succeed({ kind: "handled" }),
          abort: () => Effect.void,
        });
        yield* Effect.gen(function* () {
          const state = make({ url: yield* endpoint });
          const registry = yield* registryInScope;
          const chats = state.chats(webWorkspace.id);
          registry.mount(chats);
          registry.mount(state.live(secondChat));
          const route = yield* Queue.take(server.opened);
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          registry.refresh(chats);
          yield* Deferred.await(reading);
          yield* Queue.offerAll(route.queue, [
            {
              chatId: firstChat,
              event: {
                type: "text-delta",
                messageId: orphanMessageId,
                contentIndex: 0,
                text: "unopened",
              },
            },
            { chatId: firstChat, event: { type: "title-changed", title: "Event title" } },
            {
              chatId: secondChat,
              event: { type: "notice", level: "info", message: "after title" },
            },
          ]);
          yield* waitFor(registry, state.live(secondChat), (value) =>
            value.notices.some((notice) => notice.message === "after title"),
          );
          yield* Deferred.succeed(release, [{ ...historical, title: "Stale read" }]);
          yield* waitFor(
            registry,
            chats,
            (value) =>
              value._tag === "Success" &&
              value.value[0]?.title === "Authoritative title" &&
              !value.waiting,
          );
          yield* AtomRegistry.getResult(registry, state.transcript(firstChat));
          assert.isUndefined(draftBlock(registry.get(state.live(firstChat)), orphanMessageId, 0));
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "isolates registries and rejects actions after Events ends while retaining partial content",
    () =>
      Effect.gen(function* () {
        let sends = 0;
        const server = yield* fixture({
          transcript: () => Effect.succeed(snapshot()),
          sendMessage: () =>
            Effect.sync(() => {
              sends += 1;
              return { kind: "handled" } as const;
            }),
          abort: () => Effect.void,
        });
        yield* Effect.gen(function* () {
          const state = make({ url: yield* endpoint });
          const first = yield* registryInScope;
          const second = yield* registryInScope;
          first.mount(state.live(firstChat));
          const firstRoute = yield* Queue.take(server.opened);
          second.mount(state.live(firstChat));
          const secondRoute = yield* Queue.take(server.opened);
          first.set(state.send(firstChat), { text: " ", attachments: [] });
          yield* waitFor(first, state.send(firstChat), AsyncResult.isFailure);
          const invalid = first.get(state.send(firstChat));
          if (!AsyncResult.isFailure(invalid)) return yield* Effect.die("Expected prompt failure");
          assert.instanceOf(Cause.squash(invalid.cause), Schema.SchemaError);
          assert.isFalse(Cause.hasDies(invalid.cause));
          assert.strictEqual(sends, 0);
          first.set(state.send(firstChat), prompt("new batch"));
          yield* waitFor(
            first,
            state.send(firstChat),
            (value) => AsyncResult.isSuccess(value) && !value.waiting,
          );
          assert.strictEqual(sends, 1);
          yield* Queue.offerAll(firstRoute.queue, [
            { chatId: firstChat, event: { type: "run-started" } },
            {
              chatId: firstChat,
              event: {
                type: "text-delta",
                messageId: firstMessageId,
                contentIndex: 3,
                text: "keep me",
              },
            },
            { chatId: firstChat, event: { type: "title-changed", title: "First registry" } },
          ]);
          yield* waitFor(
            first,
            state.live(firstChat),
            (live) => draftBlock(live, firstMessageId, 3)?.text === "keep me",
          );
          assert.isUndefined(draftBlock(second.get(state.live(firstChat)), firstMessageId, 3));
          yield* Queue.end(firstRoute.queue);
          yield* waitFor(first, state.connection, (value) => value.kind === "unavailable");
          assert.strictEqual(first.get(state.live(firstChat)).run.kind, "unknown");
          assert.strictEqual(
            draftBlock(first.get(state.live(firstChat)), firstMessageId, 3)?.text,
            "keep me",
          );
          first.set(state.send(firstChat), prompt("do not send"));
          yield* waitFor(first, state.send(firstChat), AsyncResult.isFailure);
          assert.strictEqual(sends, 1);
          const failed = first.get(state.send(firstChat));
          if (!AsyncResult.isFailure(failed))
            return yield* Effect.die("Expected unavailable action");
          assert.instanceOf(Cause.squash(failed.cause), ApplicationError);
          assert.isFalse(failed.waiting);
          first.dispose();
          yield* Deferred.await(firstRoute.closed);
          assert.isFalse(yield* Deferred.isDone(secondRoute.closed));
          second.set(state.send(firstChat), prompt("still connected"));
          yield* waitFor(
            second,
            state.send(firstChat),
            (value) => AsyncResult.isSuccess(value) && !value.waiting,
          );
          assert.strictEqual(sends, 2);
          assert.strictEqual(second.get(state.connection).kind, "active");
          second.dispose();
          yield* Deferred.await(secondRoute.closed);
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live("retains partial content and rejects actions when Events ownership lookup fails", () =>
    Effect.gen(function* () {
      let sends = 0;
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot()),
        sendMessage: () =>
          Effect.sync(() => {
            sends += 1;
            return { kind: "handled" } as const;
          }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.live(firstChat));
        const route = yield* Queue.take(server.opened);
        yield* Queue.offerAll(route.queue, [
          { chatId: firstChat, event: { type: "run-started" } },
          {
            chatId: firstChat,
            event: {
              type: "text-delta",
              messageId: firstMessageId,
              contentIndex: 0,
              text: "keep me",
            },
          },
        ]);
        yield* waitFor(
          registry,
          state.live(firstChat),
          (value) => draftBlock(value, firstMessageId, 0)?.text === "keep me",
        );
        const storeFile = yield* server.storeFile;
        const database = yield* Effect.acquireRelease(
          Effect.sync(() => new Database(storeFile)),
          (database) => Effect.sync(() => database.close()),
        );
        yield* Effect.sync(() => database.run("DROP TABLE workspaces"));
        yield* Queue.offer(route.queue, {
          chatId: secondChat,
          event: { type: "notice", level: "info", message: "must not reach the client" },
        });
        yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");
        const connection = registry.get(state.connection);
        if (connection.kind !== "unavailable")
          return yield* Effect.die("Expected unavailable connection");
        const error = Option.getOrThrow(Cause.findErrorOption(connection.cause));
        assert.instanceOf(error, ApplicationError);
        if (!(error instanceof ApplicationError))
          return yield* Effect.die("Expected application error");
        assert.strictEqual(error.reason, "operation");
        assert.strictEqual(
          draftBlock(registry.get(state.live(firstChat)), firstMessageId, 0)?.text,
          "keep me",
        );
        assert.strictEqual(registry.get(state.live(firstChat)).run.kind, "unknown");
        registry.set(state.send(firstChat), prompt("do not send"));
        yield* waitFor(registry, state.send(firstChat), AsyncResult.isFailure);
        assert.strictEqual(sends, 0);
        yield* Deferred.await(route.closed);
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("starts concurrent sends before any atom is mounted", () =>
    Effect.gen(function* () {
      const sent = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot()),
        sendMessage: (_chatId, input) =>
          Effect.gen(function* () {
            yield* Queue.offer(sent, input.text);
            yield* Deferred.await(release);
            return { kind: "handled" } as const;
          }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.set(state.send(firstChat), prompt("first"));
        registry.set(state.send(firstChat), prompt("second"));
        assert.isTrue(registry.get(state.send(firstChat)).waiting);
        const route = yield* Queue.take(server.opened);
        assert.deepStrictEqual([yield* Queue.take(sent), yield* Queue.take(sent)].sort(), [
          "first",
          "second",
        ]);
        yield* Deferred.succeed(release, undefined);
        yield* waitFor(
          registry,
          state.send(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.strictEqual(registry.get(state.connection).kind, "active");
        registry.dispose();
        yield* Deferred.await(route.closed);
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("settles overlapping Shake calls independently while a send remains pending", () =>
    Effect.gen(function* () {
      const sent = yield* Deferred.make<void>();
      const releaseSend = yield* Deferred.make<void>();
      const shaking = yield* Queue.unbounded<ShakeMode>();
      const releaseElide = yield* Deferred.make<ShakeResult>();
      const releaseImages = yield* Deferred.make<ShakeResult>();
      const releaseThinking = yield* Deferred.make<ShakeResult>();
      let usage = {
        kind: "available",
        contextWindow: 100_000,
        usedTokens: 1000,
        messagesTokens: 800,
        systemPromptTokens: 100,
        systemToolsTokens: 100,
        systemContextTokens: 0,
        skillsTokens: 0,
      } satisfies ContextUsage;
      const images: ShakeResult = { mode: "images", imagesDropped: 2, tokensFreed: 0 };
      const elide: ShakeResult = {
        mode: "elide",
        toolResultsDropped: 3,
        blocksDropped: 1,
        tokensFreed: 400,
      };
      const thinking: ShakeResult = {
        mode: "thinking",
        thinkingBlocksDropped: 0,
        tokensFreed: 0,
      };
      const server = yield* fixture({
        transcript: () => Effect.sync(() => snapshot([], usage)),
        contextUsage: () => Effect.sync(() => usage),
        sendMessage: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sent, undefined);
            yield* Deferred.await(releaseSend);
            return { kind: "handled" } as const;
          }),
        abort: () => Effect.void,
        shake: (_chatId, mode) =>
          Effect.gen(function* () {
            yield* Queue.offer(shaking, mode);
            return yield* Deferred.await(
              mode === "elide" ? releaseElide : mode === "images" ? releaseImages : releaseThinking,
            );
          }),
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.observeContext(firstChat));
        yield* waitFor(registry, state.connection, (value) => value.kind === "active");
        registry.set(state.send(firstChat), prompt("keep working"));
        yield* Deferred.await(sent);
        const elideInvocation = yield* Effect.forkScoped(state.shake(registry, firstChat, "elide"));
        yield* Queue.take(shaking);
        const imagesInvocation = yield* Effect.forkScoped(
          state.shake(registry, firstChat, "images"),
        );
        yield* Queue.take(shaking);
        yield* Deferred.succeed(releaseImages, images);
        assert.deepStrictEqual(yield* Fiber.join(imagesInvocation), images);
        assert.isTrue(registry.get(state.send(firstChat)).waiting);
        const thinkingInvocation = yield* Effect.forkScoped(
          state.shake(registry, firstChat, "thinking"),
        );
        yield* Queue.take(shaking);
        yield* Deferred.succeed(releaseThinking, thinking);
        assert.deepStrictEqual(yield* Fiber.join(thinkingInvocation), thinking);
        usage = { ...usage, usedTokens: 600, messagesTokens: 400 };
        yield* Deferred.succeed(releaseElide, elide);
        assert.deepStrictEqual(yield* Fiber.join(elideInvocation), elide);
        yield* waitFor(
          registry,
          state.contextUsage(firstChat),
          (value) =>
            value._tag === "Success" &&
            !value.waiting &&
            value.value.kind === "available" &&
            value.value.usedTokens === 600,
        );
        assert.isTrue(registry.get(state.send(firstChat)).waiting);
        yield* Deferred.succeed(releaseSend, undefined);
        yield* waitFor(
          registry,
          state.send(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("does not transfer an older Shake failure to a newer invocation", () =>
    Effect.gen(function* () {
      const shaking = yield* Queue.unbounded<ShakeMode>();
      const releaseElide = yield* Deferred.make<ShakeResult, ApplicationError>();
      const releaseThinking = yield* Deferred.make<ShakeResult>();
      const ready = yield* Deferred.make<void>();
      const current = snapshot();
      let usage: ContextUsage = { kind: "unavailable" };
      const rejection = new ApplicationError({
        reason: "operation",
        message: "Elide failed",
      });
      const thinking: ShakeResult = {
        mode: "thinking",
        thinkingBlocksDropped: 4,
        tokensFreed: 90,
      };
      const server = yield* fixture(
        {
          transcript: () => Effect.sync(() => current),
          contextUsage: () => Effect.sync(() => usage),
          sendMessage: () => Effect.succeed({ kind: "handled" }),
          abort: () => Effect.void,
          shake: (_chatId, mode) =>
            Effect.gen(function* () {
              yield* Queue.offer(shaking, mode);
              if (mode === "elide") return yield* Deferred.await(releaseElide);
              return yield* Deferred.await(releaseThinking);
            }),
        },
        Deferred.await(ready),
      );
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        const elideInvocation = yield* Effect.forkScoped(state.shake(registry, firstChat, "elide"));
        yield* Queue.take(server.opened);
        assert.strictEqual(registry.get(state.connection).kind, "opening");
        assert.strictEqual(yield* Queue.size(shaking), 0);
        yield* Deferred.succeed(ready, undefined);
        yield* Queue.take(shaking);
        const thinkingInvocation = yield* Effect.forkScoped(
          state.shake(registry, firstChat, "thinking"),
        );
        yield* Queue.take(shaking);
        registry.mount(state.observeContext(firstChat));
        registry.mount(state.contextUsage(firstChat));
        yield* waitFor(
          registry,
          state.contextUsage(firstChat),
          (value) =>
            value._tag === "Success" && !value.waiting && value.value.kind === "unavailable",
        );
        yield* Deferred.fail(releaseElide, rejection);
        const failed = yield* Fiber.await(elideInvocation);
        if (failed._tag !== "Failure") return yield* Effect.die("Expected Shake rejection");
        assert.deepStrictEqual(Option.getOrNull(Cause.findErrorOption(failed.cause)), rejection);
        usage = {
          kind: "available",
          contextWindow: 100_000,
          usedTokens: 42_000,
          messagesTokens: 30_000,
          systemPromptTokens: 3_000,
          systemToolsTokens: 4_000,
          systemContextTokens: 2_000,
          skillsTokens: 3_000,
        };
        registry.set(state.contextUsage(firstChat), undefined);
        yield* waitFor(
          registry,
          state.contextUsage(firstChat),
          (value) =>
            value._tag === "Success" &&
            !value.waiting &&
            value.value.kind === "available" &&
            value.value.usedTokens === 42_000,
        );
        yield* Deferred.succeed(releaseThinking, thinking);
        assert.deepStrictEqual(yield* Fiber.join(thinkingInvocation), thinking);
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("retains settled content through slow, failed, missing and canceled snapshots", () =>
    Effect.gen(function* () {
      const server = yield* snapshotFixture();
      yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() => server.release);
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        const first = assistant(firstMessageId, "first answer");
        const second = assistant(secondMessageId, "second answer");
        registry.mount(state.live(firstChat));
        const route = yield* Queue.take(server.opened);
        registry.mount(state.transcript(firstChat));
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, snapshot());
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        yield* Queue.offerAll(route.queue, [
          {
            chatId: firstChat,
            event: {
              type: "text-delta",
              messageId: first.id,
              contentIndex: 0,
              text: "first answer",
            },
          },
          { chatId: firstChat, event: { type: "message-settled", message: first } },
        ]);
        const slow = yield* Queue.take(server.requests);
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: {
            type: "text-delta",
            messageId: second.id,
            contentIndex: 0,
            text: "second answer",
          },
        });
        yield* waitFor(
          registry,
          state.live(firstChat),
          (value) => draftBlock(value, second.id, 0)?.text === "second answer",
        );
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [first]);
        yield* Deferred.fail(
          slow.reply,
          new ApplicationError({ reason: "operation", message: "storage unavailable" }),
        );
        yield* waitFor(registry, state.transcript(firstChat), AsyncResult.isFailure);
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [first]);

        registry.refresh(state.transcript(firstChat));
        const missing = snapshot([], undefined, {
          publication: Publication.make(publication),
          run: { kind: "running" },
          assistant: [
            { kind: "settled", message: first },
            {
              kind: "draft",
              messageId: second.id,
              blocks: [
                {
                  type: "text-delta",
                  messageId: second.id,
                  contentIndex: 0,
                  text: "second answer",
                },
              ],
            },
          ],
          tools: [],
        });
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, missing);
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [first]);
        registry.refresh(state.transcript(firstChat));
        const stale = yield* Queue.take(server.requests);
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: { type: "message-settled", message: second },
        });
        yield* waitFor(
          registry,
          state.live(firstChat),
          (value) => value.assistant.get(second.id)?.kind === "settled",
        );
        yield* Deferred.succeed(stale.reply, missing);
        yield* Deferred.await(stale.returned);
        const newer = yield* Queue.take(server.requests);
        yield* Deferred.succeed(
          newer.reply,
          snapshot([first], undefined, {
            publication: Publication.make(publication),
            run: { kind: "running" },
            assistant: [{ kind: "settled", message: second }],
            tools: [],
          }),
        );
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [second]);
        assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))), [
          first,
        ]);
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [second]);

        const continuity: Array<boolean> = [];
        const observe = () => {
          const snapshot = AsyncResult.value(registry.get(state.transcript(firstChat)));
          const persisted = snapshot._tag === "Some" ? snapshot.value : [];
          continuity.push(
            [...persisted, ...pendingMessages(registry.get(state.live(firstChat)))].some(
              (message) => message.role === "assistant" && message.id === second.id,
            ),
          );
        };
        registry.subscribe(state.live(firstChat), observe, { immediate: true });
        registry.subscribe(state.transcript(firstChat), observe, { immediate: true });
        registry.refresh(state.transcript(firstChat));
        yield* Deferred.succeed(
          (yield* Queue.take(server.requests)).reply,
          snapshot([first, second], undefined, {
            publication: Publication.make(publication),
            run: { kind: "running" },
            assistant: [],
            tools: [],
          }),
        );
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), []);
        assert.isTrue(continuity.every(Boolean));
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("acknowledges a settlement already persisted in an earlier snapshot", () =>
    Effect.gen(function* () {
      const server = yield* snapshotFixture();
      yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() => server.release);
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        const reply = assistant(firstMessageId, "PICO_WEB_OK");
        registry.mount(state.live(firstChat));
        const route = yield* Queue.take(server.opened);
        registry.mount(state.transcript(firstChat));
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, snapshot());
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        yield* Queue.offerAll(route.queue, [
          { chatId: firstChat, event: { type: "run-started" } },
          { chatId: firstChat, event: { type: "message-settled", message } },
        ]);
        const early = yield* Queue.take(server.requests);
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: { type: "text-delta", messageId: reply.id, contentIndex: 0, text: "PICO_WEB_OK" },
        });
        yield* waitFor(
          registry,
          state.live(firstChat),
          (value) => draftBlock(value, reply.id, 0)?.text === "PICO_WEB_OK",
        );
        yield* Deferred.succeed(
          early.reply,
          snapshot([message, reply], undefined, {
            publication: Publication.make(publication),
            run: { kind: "running" },
            assistant: [
              {
                kind: "draft",
                messageId: reply.id,
                blocks: [
                  {
                    type: "text-delta",
                    messageId: reply.id,
                    contentIndex: 0,
                    text: "PICO_WEB_OK",
                  },
                ],
              },
            ],
            tools: [],
          }),
        );
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))), [
          message,
          reply,
        ]);
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), []);
        assert.isUndefined(draftBlock(registry.get(state.live(firstChat)), reply.id, 0));
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: { type: "message-settled", message: reply },
        });
        const settled = yield* Queue.take(server.requests);
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), []);
        yield* Deferred.succeed(
          settled.reply,
          snapshot([message, reply], undefined, {
            publication: Publication.make(publication),
            run: { kind: "running" },
            assistant: [],
            tools: [],
          }),
        );
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), []);
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: { type: "run-finished", outcome: "completed" },
        });
        yield* Deferred.succeed(
          (yield* Queue.take(server.requests)).reply,
          snapshot([message, reply], undefined, {
            publication: Publication.make(publication),
            run: { kind: "finished", outcome: "completed" },
            assistant: [],
            tools: [],
          }),
        );
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))), [
          message,
          reply,
        ]);
        const live = registry.get(state.live(firstChat));
        assert.deepStrictEqual(pendingMessages(live), []);
        assert.isUndefined(draftBlock(live, reply.id, 0));
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("keeps equal messages distinct and retires orphan drafts only by their IDs", () =>
    Effect.gen(function* () {
      const server = yield* snapshotFixture();
      yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() => server.release);
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        const history = assistant(firstMessageId, "repeated");
        const first = assistant(secondMessageId, "repeated");
        const second = assistant(thirdMessageId, "repeated");
        registry.mount(state.live(firstChat));
        const route = yield* Queue.take(server.opened);
        registry.mount(state.transcript(firstChat));
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, snapshot([history]));
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: { type: "message-settled", message: first },
        });
        const stale = yield* Queue.take(server.requests);
        const staleSnapshot = snapshot([history], undefined, {
          publication: Publication.make(publication),
          run: { kind: "idle" },
          assistant: [{ kind: "settled", message: first }],
          tools: [],
        });
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: { type: "message-settled", message: second },
        });
        yield* waitFor(
          registry,
          state.live(firstChat),
          (value) => value.assistant.get(second.id)?.kind === "settled",
        );
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [
          first,
          second,
        ]);
        yield* Deferred.succeed(stale.reply, staleSnapshot);
        yield* Deferred.await(stale.returned);
        const newer = yield* Queue.take(server.requests);
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [
          first,
          second,
        ]);
        yield* Deferred.succeed(
          newer.reply,
          snapshot([history], undefined, {
            publication: Publication.make(publication),
            run: { kind: "idle" },
            assistant: [
              { kind: "settled", message: first },
              { kind: "settled", message: second },
            ],
            tools: [],
          }),
        );
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [
          first,
          second,
        ]);
        registry.refresh(state.transcript(firstChat));
        yield* Deferred.succeed(
          (yield* Queue.take(server.requests)).reply,
          snapshot([history, { ...first, model: "normalized-model" }], undefined, {
            publication: Publication.make(publication),
            run: { kind: "idle" },
            assistant: [{ kind: "settled", message: second }],
            tools: [],
          }),
        );
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [second]);
        yield* Queue.offerAll(route.queue, [
          {
            chatId: firstChat,
            event: {
              type: "text-delta",
              messageId: orphanMessageId,
              contentIndex: 0,
              text: "orphan",
            },
          },
          { chatId: firstChat, event: { type: "run-finished", outcome: "aborted" } },
        ]);
        const finish = yield* Queue.take(server.requests);
        const finishedSnapshot = snapshot([history, first, second], undefined, {
          publication: Publication.make(publication),
          run: { kind: "finished", outcome: "aborted" },
          assistant: [
            {
              kind: "draft",
              messageId: orphanMessageId,
              blocks: [
                {
                  type: "text-delta",
                  messageId: orphanMessageId,
                  contentIndex: 0,
                  text: "orphan",
                },
              ],
            },
          ],
          tools: [],
        });
        yield* Queue.offerAll(route.queue, [
          { chatId: firstChat, event: { type: "run-started" } },
          {
            chatId: firstChat,
            event: {
              type: "text-delta",
              messageId: nextMessageId,
              contentIndex: 0,
              text: "new run",
            },
          },
        ]);
        yield* waitFor(
          registry,
          state.live(firstChat),
          (value) => draftBlock(value, nextMessageId, 0)?.text === "new run",
        );
        yield* Deferred.succeed(finish.reply, finishedSnapshot);
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        const retained = registry.get(state.live(firstChat));
        assert.deepStrictEqual(pendingMessages(retained), []);
        assert.strictEqual(draftBlock(retained, orphanMessageId, 0)?.text, "orphan");
        assert.strictEqual(draftBlock(retained, nextMessageId, 0)?.text, "new run");
        registry.refresh(state.transcript(firstChat));
        yield* Deferred.succeed(
          (yield* Queue.take(server.requests)).reply,
          snapshot([history, first, second, assistant(orphanMessageId, "orphan")], undefined, {
            publication: Publication.make(publication),
            run: { kind: "running" },
            assistant: [
              {
                kind: "draft",
                messageId: nextMessageId,
                blocks: [
                  {
                    type: "text-delta",
                    messageId: nextMessageId,
                    contentIndex: 0,
                    text: "new run",
                  },
                ],
              },
            ],
            tools: [],
          }),
        );
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        const acknowledged = registry.get(state.live(firstChat));
        assert.isUndefined(draftBlock(acknowledged, orphanMessageId, 0));
        assert.strictEqual(draftBlock(acknowledged, nextMessageId, 0)?.text, "new run");
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("acknowledges a live-first settlement in the first snapshot without a baseline", () =>
    Effect.gen(function* () {
      const server = yield* snapshotFixture();
      yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() => server.release);
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        const repeated = assistant(firstMessageId, "same as history");
        registry.mount(state.live(firstChat));
        const route = yield* Queue.take(server.opened);
        const initial = yield* Queue.take(server.requests);
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: { type: "message-settled", message: repeated },
        });
        registry.mount(state.transcript(firstChat));
        yield* waitFor(
          registry,
          state.live(firstChat),
          (value) => value.assistant.get(repeated.id)?.kind === "settled",
        );
        assert.isTrue(Option.isNone(AsyncResult.value(registry.get(state.transcript(firstChat)))));
        const persisted = snapshot([repeated], undefined, {
          publication: Publication.make(publication),
          run: { kind: "idle" },
          assistant: [],
          tools: [],
        });
        yield* Deferred.succeed(initial.reply, persisted);
        yield* Deferred.await(initial.returned);
        const followup = yield* Queue.take(server.requests);
        assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))), [
          repeated,
        ]);
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), []);
        yield* Deferred.succeed(followup.reply, persisted);
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        yield* Queue.offerAll(route.queue, [
          {
            chatId: firstChat,
            event: { type: "text-delta", messageId: repeated.id, contentIndex: 0, text: "late" },
          },
          { chatId: firstChat, event: { type: "message-settled", message: repeated } },
        ]);
        const late = yield* Queue.take(server.requests);
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), []);
        assert.isUndefined(draftBlock(registry.get(state.live(firstChat)), repeated.id, 0));
        yield* Deferred.succeed(
          late.reply,
          snapshot([repeated], undefined, {
            publication: Publication.make(publication),
            run: { kind: "running" },
            assistant: [],
            tools: [],
          }),
        );
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live(
    "merges an ordinary snapshot cut with later deltas and tool completion exactly once",
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<TranscriptSnapshot>();
        let hold = false;
        const server = yield* fixture({
          transcript: () =>
            hold
              ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.succeed(snapshot()),
          sendMessage: () => Effect.succeed({ kind: "handled" }),
          abort: () => Effect.void,
        });
        yield* Effect.gen(function* () {
          const state = make({ url: yield* endpoint });
          const registry = yield* registryInScope;
          registry.mount(state.live(firstChat));
          const route = yield* Queue.take(server.opened);
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          const start = {
            type: "tool-started",
            toolCallId: "read-file",
            toolName: "read",
            argumentsJson: '{"path":"file.ts"}',
          } as const;
          yield* Queue.offerAll(route.queue, [
            { chatId: firstChat, event: { type: "run-started" } },
            {
              chatId: firstChat,
              event: {
                type: "text-delta",
                messageId: firstMessageId,
                contentIndex: 0,
                text: "prefix",
              },
            },
            { chatId: firstChat, event: start },
          ]);
          yield* waitFor(
            registry,
            state.live(firstChat),
            (value) => value.tools.get(start.toolCallId)?.kind === "running",
          );
          const cut = snapshot(
            [],
            { kind: "unavailable" },
            {
              publication: Publication.make(publication),
              run: { kind: "running" },
              assistant: [
                {
                  kind: "draft",
                  messageId: firstMessageId,
                  blocks: [
                    {
                      type: "text-delta",
                      messageId: firstMessageId,
                      contentIndex: 0,
                      text: "prefix",
                    },
                  ],
                },
              ],
              tools: [{ kind: "running", start }],
            },
          );
          hold = true;
          registry.refresh(state.transcript(firstChat));
          yield* Deferred.await(reading);
          yield* Queue.offerAll(route.queue, [
            {
              chatId: firstChat,
              event: {
                type: "text-delta",
                messageId: firstMessageId,
                contentIndex: 0,
                text: " suffix",
              },
            },
            {
              chatId: firstChat,
              event: {
                type: "tool-finished",
                toolCallId: start.toolCallId,
                toolName: "read",
                status: "succeeded",
              },
            },
          ]);
          yield* waitFor(
            registry,
            state.live(firstChat),
            (value) => value.tools.get(start.toolCallId)?.kind === "finished",
          );
          yield* Deferred.succeed(release, cut);
          yield* waitFor(
            registry,
            state.transcript(firstChat),
            (value) => value._tag === "Success" && !value.waiting,
          );
          const live = registry.get(state.live(firstChat));
          assert.strictEqual(draftBlock(live, firstMessageId, 0)?.text, "prefix suffix");
          assert.strictEqual(live.tools.get(start.toolCallId)?.kind, "finished");
          assert.strictEqual(live.run.kind, "running");
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live("preserves notices once across snapshot cuts and delayed Events frames", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<TranscriptSnapshot>();
      let current = snapshot();
      let hold = false;
      const server = yield* fixture({
        transcript: () =>
          hold
            ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(reply)))
            : Effect.succeed(current),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.live(firstChat));
        const route = yield* Queue.take(server.opened);
        yield* waitFor(registry, state.connection, (value) => value.kind === "active");
        const baseline = {
          type: "notice",
          level: "info",
          message: "Before refresh",
        } satisfies AgentEventEnvelope["event"];
        const buffered = {
          type: "notice",
          level: "warning",
          message: "Before snapshot cut",
        } satisfies AgentEventEnvelope["event"];
        const afterCut = {
          type: "notice",
          level: "error",
          message: "After snapshot cut",
        } satisfies AgentEventEnvelope["event"];
        yield* Queue.offer(route.queue, { chatId: firstChat, event: baseline });
        yield* waitFor(registry, state.live(firstChat), (value) => value.notices.length === 1);
        hold = true;
        registry.refresh(state.transcript(firstChat));
        yield* Deferred.await(reading);
        yield* Queue.offer(route.queue, { chatId: firstChat, event: buffered });
        yield* waitFor(registry, state.live(firstChat), (value) => value.notices.length === 2);
        const delayed = {
          chatId: firstChat,
          event: { type: "notice", level: "warning", message: "Delayed frame" },
          publication: Publication.make(++publication),
          origin: "session",
        } satisfies AgentEventEnvelope;
        current = snapshot(
          [],
          { kind: "unavailable" },
          {
            publication: delayed.publication,
            run: { kind: "idle" },
            assistant: [],
            tools: [],
          },
        );
        yield* Queue.offer(route.queue, { chatId: firstChat, event: afterCut });
        yield* waitFor(registry, state.live(firstChat), (value) => value.notices.length === 3);
        hold = false;
        yield* Deferred.succeed(reply, current);
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => value._tag === "Success" && !value.waiting,
        );
        assert.deepStrictEqual(registry.get(state.live(firstChat)).notices, [
          baseline,
          buffered,
          afterCut,
        ]);
        yield* Queue.offerAll(route.queue, [
          delayed,
          {
            chatId: firstChat,
            event: {
              type: "text-delta",
              messageId: firstMessageId,
              contentIndex: 0,
              text: "after delayed frame",
            },
          },
        ]);
        yield* waitFor(
          registry,
          state.live(firstChat),
          (value) => draftBlock(value, firstMessageId, 0)?.text === "after delayed frame",
        );
        assert.deepStrictEqual(registry.get(state.live(firstChat)).notices, [
          baseline,
          buffered,
          afterCut,
          delayed.event,
        ]);
        registry.refresh(state.transcript(firstChat));
        yield* AtomRegistry.getResult(registry, state.transcript(firstChat), {
          suspendOnWaiting: true,
        });
        assert.deepStrictEqual(registry.get(state.live(firstChat)).notices, [
          baseline,
          buffered,
          afterCut,
          delayed.event,
        ]);
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live(
    "retains delivery settlements outside an absent-session snapshot cut without duplicating IDs",
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const reply = yield* Deferred.make<TranscriptSnapshot>();
        let current = snapshot();
        let hold = false;
        const server = yield* fixture({
          transcript: () =>
            hold
              ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(reply)))
              : Effect.succeed(current),
          sendMessage: () => Effect.succeed({ kind: "handled" }),
          abort: () => Effect.void,
        });
        yield* Effect.gen(function* () {
          const state = make({ url: yield* endpoint });
          const registry = yield* registryInScope;
          registry.mount(state.live(firstChat));
          const route = yield* Queue.take(server.opened);
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          hold = true;
          registry.refresh(state.transcript(firstChat));
          yield* Deferred.await(reading);
          const delivered = {
            chatId: firstChat,
            publication: Publication.make(++publication),
            origin: "delivery",
            event: {
              type: "message-settled",
              message: assistant(firstMessageId, "Delivery failed"),
            },
          } satisfies AgentEventEnvelope;
          const delayed = {
            chatId: firstChat,
            publication: Publication.make(++publication),
            origin: "delivery",
            event: {
              type: "message-settled",
              message: assistant(secondMessageId, "Delayed delivery failure"),
            },
          } satisfies AgentEventEnvelope;
          yield* Queue.offer(route.queue, delivered);
          yield* waitFor(
            registry,
            state.live(firstChat),
            (value) => value.assistant.get(firstMessageId)?.kind === "settled",
          );
          current = snapshot(
            [],
            { kind: "unavailable" },
            {
              publication: delayed.publication,
              run: { kind: "idle" },
              assistant: [],
              tools: [],
            },
          );
          hold = false;
          yield* Deferred.succeed(reply, current);
          yield* waitFor(
            registry,
            state.transcript(firstChat),
            (value) => value._tag === "Success" && !value.waiting,
          );
          assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [
            delivered.event.message,
          ]);
          yield* Queue.offerAll(route.queue, [
            delivered,
            delayed,
            {
              chatId: firstChat,
              event: { type: "notice", level: "info", message: "After duplicate delivery" },
            },
          ]);
          yield* waitFor(registry, state.live(firstChat), (value) =>
            value.notices.some((notice) => notice.message === "After duplicate delivery"),
          );
          yield* AtomRegistry.getResult(registry, state.transcript(firstChat), {
            suspendOnWaiting: true,
          });
          assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [
            delivered.event.message,
            delayed.event.message,
          ]);
          assert.deepStrictEqual(registry.get(state.live(firstChat)).run, { kind: "idle" });
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "keeps shared recovery alive when its initiating query is refreshed before Events is ready",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        let holdReady = false;
        let rejectList = true;
        const recovered = { ...webWorkspace, name: "Recovered workspace" };
        const server = yield* fixture(
          {
            transcript: () => Effect.succeed(snapshot()),
            sendMessage: () => Effect.succeed({ kind: "handled" }),
            abort: () => Effect.void,
            listWorkspaces: () =>
              rejectList
                ? Effect.fail(
                    new ApplicationError({ reason: "operation", message: "List unavailable" }),
                  )
                : Effect.succeed([recovered]),
          },
          Effect.suspend(() => (holdReady ? Deferred.await(ready) : Effect.void)),
        );
        yield* Effect.gen(function* () {
          const state = make({ url: yield* endpoint });
          const registry = yield* registryInScope;
          registry.mount(state.workspaces);
          const first = yield* Queue.take(server.opened);
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          yield* waitFor(
            registry,
            state.workspaces,
            (value) => value._tag === "Failure" && !value.waiting,
          );
          yield* Queue.end(first.queue);
          yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");
          yield* Deferred.await(first.closed);
          holdReady = true;
          rejectList = false;
          registry.refresh(state.workspaces);
          const replacement = yield* Queue.take(server.opened);
          registry.set(state.ensure, undefined);
          yield* waitFor(registry, state.ensure, (value) => value.waiting);
          yield* Effect.yieldNow;
          registry.refresh(state.workspaces);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(ready, undefined);
          yield* AtomRegistry.getResult(registry, state.ensure, { suspendOnWaiting: true });
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          assert.deepStrictEqual(
            yield* AtomRegistry.getResult(registry, state.workspaces, { suspendOnWaiting: true }),
            [recovered],
          );
          assert.strictEqual(server.openCount(), 2);
          assert.isFalse(yield* Deferred.isDone(replacement.closed));
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "joins recovery, rehydrates active and finished runs, and fences old reads and writes without replay",
    () =>
      Effect.gen(function* () {
        const oldRead = {
          started: yield* Deferred.make<void>(),
          reply: yield* Deferred.make<TranscriptSnapshot>(),
          returned: yield* Deferred.make<void>(),
        };
        const recoveryRead = {
          started: yield* Deferred.make<void>(),
          reply: yield* Deferred.make<TranscriptSnapshot>(),
          returned: yield* Deferred.make<void>(),
        };
        let nextRead: typeof oldRead | undefined;
        const sent = yield* Deferred.make<void>();
        const shaken = yield* Deferred.make<void>();
        const releaseWrite = yield* Deferred.make<void>();
        const writeReturned = yield* Deferred.make<void>();
        const shakeReturned = yield* Deferred.make<void>();
        let sends = 0;
        let shakes = 0;
        let current = snapshot([message]);
        let workspace = webWorkspace;
        let title = "Before disconnect";
        const contextFromSnapshot = (): ContextUsage =>
          current.contextUsage.kind === "error" ? { kind: "unavailable" } : current.contextUsage;
        const server = yield* fixture({
          listWorkspaces: () => Effect.sync(() => [workspace]),
          listChats: () =>
            Effect.sync(() => [
              {
                id: firstChat,
                workspaceId: webWorkspace.id,
                cwd: webWorkspace.defaultCwd,
                externalId: null,
                createdAt: 1,
                archivedAt: null,
                title,
              },
            ]),
          transcript: () =>
            Effect.gen(function* () {
              const pending = nextRead;
              nextRead = undefined;
              if (pending === undefined) return current;
              yield* Deferred.succeed(pending.started, undefined);
              return yield* Deferred.await(pending.reply).pipe(
                Effect.ensuring(Deferred.succeed(pending.returned, undefined)),
                Effect.uninterruptible,
              );
            }),
          contextUsage: () => Effect.sync(contextFromSnapshot),
          sendMessage: () =>
            Effect.gen(function* () {
              sends++;
              yield* Deferred.succeed(sent, undefined);
              yield* Deferred.await(releaseWrite);
              yield* Deferred.succeed(writeReturned, undefined);
              return { kind: "handled" } as const;
            }).pipe(Effect.uninterruptible),
          abort: () => Effect.void,
          shake: () =>
            Effect.gen(function* () {
              shakes++;
              yield* Deferred.succeed(shaken, undefined);
              yield* Deferred.await(releaseWrite);
              yield* Deferred.succeed(shakeReturned, undefined);
              return { mode: "images", imagesDropped: 2, tokensFreed: 0 } as const;
            }).pipe(Effect.uninterruptible),
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.all([
              Deferred.succeed(oldRead.reply, snapshot()),
              Deferred.succeed(recoveryRead.reply, snapshot()),
              Deferred.succeed(releaseWrite, undefined),
            ]),
          );
          const state = make({ url: yield* endpoint });
          const registry = yield* registryInScope;
          registry.mount(state.workspaces);
          registry.mount(state.chats(webWorkspace.id));
          registry.mount(state.observeContext(firstChat));
          registry.mount(state.live(firstChat));
          const first = yield* Queue.take(server.opened);
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          yield* Queue.offer(first.queue, {
            chatId: firstChat,
            event: {
              type: "text-delta",
              messageId: orphanMessageId,
              contentIndex: 0,
              text: "local fragment",
            },
          });
          yield* waitFor(
            registry,
            state.live(firstChat),
            (value) => draftBlock(value, orphanMessageId, 0)?.text === "local fragment",
          );
          nextRead = oldRead;
          registry.refresh(state.transcript(firstChat));
          yield* Deferred.await(oldRead.started);
          registry.set(state.send(firstChat), prompt("execute once"));
          yield* Deferred.await(sent);
          const shakeInvocation = yield* Effect.forkScoped(
            state.shake(registry, firstChat, "images"),
          );
          yield* Deferred.await(shaken);
          yield* Queue.end(first.queue);
          yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");
          yield* waitFor(
            registry,
            state.send(firstChat),
            (value) => value._tag === "Failure" && !value.waiting,
          );
          const shakeExit = yield* Fiber.await(shakeInvocation);
          if (shakeExit._tag !== "Failure") return yield* Effect.die("Expected unconfirmed Shake");
          assert.instanceOf(Cause.squash(shakeExit.cause), ApplicationError);
          const start = {
            type: "tool-started",
            toolCallId: "active-tool",
            toolName: "read",
            argumentsJson: '{"path":"active.ts"}',
          } as const;
          current = snapshot(
            [message],
            {
              kind: "available",
              contextWindow: 100_000,
              usedTokens: 1234,
              messagesTokens: 1000,
              systemPromptTokens: 100,
              systemToolsTokens: 100,
              systemContextTokens: 34,
              skillsTokens: 0,
            },
            {
              publication: Publication.make(publication),
              run: { kind: "running" },
              assistant: [
                {
                  kind: "draft",
                  messageId: firstMessageId,
                  blocks: [
                    {
                      type: "text-delta",
                      messageId: firstMessageId,
                      contentIndex: 0,
                      text: "server prefix",
                    },
                  ],
                },
              ],
              tools: [{ kind: "running", start }],
            },
          );
          workspace = { ...webWorkspace, name: "Changed while disconnected" };
          title = "Recovered title";
          nextRead = recoveryRead;
          registry.set(state.ensure, undefined);
          registry.set(state.ensure, undefined);
          registry.set(state.ensure, undefined);
          const second = yield* Queue.take(server.opened);
          yield* Deferred.await(recoveryRead.started);
          assert.strictEqual(registry.get(state.connection).kind, "unavailable");
          yield* Deferred.succeed(recoveryRead.reply, current);
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          yield* Deferred.await(first.closed);
          assert.strictEqual(server.openCount(), 2);
          assert.strictEqual(
            draftBlock(registry.get(state.live(firstChat)), firstMessageId, 0)?.text,
            "server prefix",
          );
          assert.deepStrictEqual(registry.get(state.live(firstChat)).tools.get(start.toolCallId), {
            kind: "running",
            start,
          });
          assert.strictEqual(
            AsyncResult.getOrThrow(registry.get(state.workspaces))[0]?.name,
            workspace.name,
          );
          assert.strictEqual(
            AsyncResult.getOrThrow(registry.get(state.chats(webWorkspace.id)))[0]?.title,
            title,
          );
          yield* waitFor(
            registry,
            state.contextUsage(firstChat),
            (value) =>
              value._tag === "Success" &&
              !value.waiting &&
              value.value.kind === "available" &&
              value.value.usedTokens === 1234,
          );
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.contextUsage(firstChat))),
            contextFromSnapshot(),
          );
          const fragment = registry.get(state.live(firstChat)).assistant.get(orphanMessageId);
          assert.strictEqual(fragment?.kind === "draft" ? fragment.phase : undefined, "retained");
          yield* Deferred.succeed(oldRead.reply, snapshot());
          yield* Deferred.succeed(releaseWrite, undefined);
          yield* Deferred.await(oldRead.returned);
          yield* Deferred.await(writeReturned);
          yield* Deferred.await(shakeReturned);
          assert.strictEqual(
            draftBlock(registry.get(state.live(firstChat)), firstMessageId, 0)?.text,
            "server prefix",
          );
          assert.strictEqual(sends, 1);
          assert.strictEqual(shakes, 1);
          assert.isFalse(registry.get(state.send(firstChat)).waiting);
          registry.set(state.ensure, undefined);
          registry.set(state.ensure, undefined);
          yield* AtomRegistry.getResult(registry, state.ensure, { suspendOnWaiting: true });
          assert.strictEqual(server.openCount(), 2);
          yield* Queue.end(second.queue);
          yield* waitFor(registry, state.connection, (value) => value.kind === "unavailable");
          const completed = assistant(firstMessageId, "server completed");
          current = snapshot(
            [message, completed],
            { kind: "unavailable" },
            {
              publication: Publication.make(publication),
              run: { kind: "finished", outcome: "completed" },
              assistant: [],
              tools: [],
            },
          );
          registry.set(state.ensure, undefined);
          const third = yield* Queue.take(server.opened);
          yield* waitFor(registry, state.connection, (value) => value.kind === "active");
          const live = registry.get(state.live(firstChat));
          assert.deepStrictEqual(live.run, { kind: "finished", outcome: "completed" });
          assert.deepStrictEqual([...live.tools], []);
          assert.isUndefined(live.assistant.get(firstMessageId));
          assert.strictEqual(draftBlock(live, orphanMessageId, 0)?.text, "local fragment");
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))),
            [message, completed],
          );
          assert.strictEqual(sends, 1);
          assert.strictEqual(shakes, 1);
          registry.dispose();
          yield* Deferred.await(third.closed);
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "disposes a generation while rehydration is waiting without restoring registry state",
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const reply = yield* Deferred.make<TranscriptSnapshot>();
        const returned = yield* Deferred.make<void>();
        const server = yield* fixture({
          transcript: () =>
            Deferred.succeed(reading, undefined).pipe(
              Effect.andThen(Deferred.await(reply)),
              Effect.ensuring(Deferred.succeed(returned, undefined)),
              Effect.uninterruptible,
            ),
          sendMessage: () => Effect.succeed({ kind: "handled" }),
          abort: () => Effect.void,
        });
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(reply, snapshot()));
          const registry = yield* registryInScope;
          const state = make({ url: yield* endpoint });
          registry.mount(state.live(firstChat));
          const route = yield* Queue.take(server.opened);
          yield* Deferred.await(reading);
          registry.dispose();
          yield* Deferred.await(route.closed);
          yield* Deferred.succeed(reply, snapshot([message]));
          yield* Deferred.await(returned);
          assert.strictEqual(registry.getNodes().size, 0);
          assert.strictEqual(server.openCount(), 1);
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );
});
