import { Database } from "bun:sqlite";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import {
  type AgentAssistantMessage,
  AgentMessageId,
  AgentPrompt,
  type AgentTranscript,
} from "@pico/contract/agent-message";
import type { ContextUsage, TranscriptSnapshot } from "@pico/contract/agent-runtime";
import { Application } from "@pico/contract/application";
import { ChatId, type ChatListEntry } from "@pico/contract/chat-model";
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
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
const snapshot = (
  messages: AgentTranscript = [],
  contextUsage: ContextUsage = { kind: "unavailable" },
): TranscriptSnapshot => ({ messages, contextUsage, todo: { kind: "ready", phases: [] } });
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

interface Route {
  readonly queue: Queue.Queue<AgentEventEnvelope, Cause.Done>;
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
      >
    >,
) {
  const opened = yield* Queue.unbounded<Route>();
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
    listWorkspaces: () => Effect.die("unexpected workspace list"),
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
    setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
    availableModels: () => Effect.die("unexpected model discovery"),
    switchModel: () => Effect.die("unexpected model switch"),
    shake: () => Effect.die("unexpected chat shake"),
    closeChat: () => Effect.die("unexpected chat close"),
    ...procedures,
  });
  const router = EventRouter.of({
    drain: () => Effect.void,
    open: () =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<AgentEventEnvelope, Cause.Done>();
          const closed = yield* Deferred.make<void>();
          const route = { queue, closed };
          yield* Queue.offer(opened, route);
          return route;
        }),
        (route) => Deferred.succeed(route.closed, undefined),
      ).pipe(
        Effect.map((route) => ({
          events: Stream.fromQueue(route.queue),
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

const snapshotFixture = Effect.fnUntraced(function* () {
  const requests = yield* Queue.unbounded<{
    readonly reply: Deferred.Deferred<AgentTranscript, ApplicationError>;
    readonly returned: Deferred.Deferred<void>;
  }>();
  const pending: Array<Deferred.Deferred<AgentTranscript, ApplicationError>> = [];
  const server = yield* fixture({
    transcript: () =>
      Effect.gen(function* () {
        const reply = yield* Deferred.make<AgentTranscript, ApplicationError>();
        const returned = yield* Deferred.make<void>();
        pending.push(reply);
        yield* Queue.offer(requests, { reply, returned });
        return yield* Deferred.await(reply).pipe(
          Effect.map((messages) => snapshot(messages)),
          Effect.ensuring(Deferred.succeed(returned, undefined)),
          Effect.uninterruptible,
        );
      }),
    sendMessage: () => Effect.succeed({ kind: "handled" }),
    abort: () => Effect.void,
  });
  return {
    ...server,
    requests,
    release: Effect.forEach(pending, (reply) => Deferred.succeed(reply, []), { discard: true }),
  };
});

describe("frontend state over WebSocket", () => {
  it.live(
    "keeps a rejected workspace and removes a confirmed deletion even when refresh fails",
    () =>
      Effect.gen(function* () {
        let rejectDeletion = true;
        let refreshFails = false;
        const server = yield* fixture({
          transcript: () => Effect.succeed(snapshot()),
          sendMessage: () => Effect.succeed({ kind: "handled" }),
          abort: () => Effect.void,
          listWorkspaces: () =>
            refreshFails
              ? Effect.fail(
                  new ApplicationError({ reason: "operation", message: "Refresh unavailable" }),
                )
              : Effect.succeed([webWorkspace]),
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
            assert.strictEqual(rejected.message, "Archive the existing conversation first");
          }
          yield* AtomRegistry.getResult(registry, state.workspaces, { suspendOnWaiting: true });
          assert.deepStrictEqual(
            Option.getOrThrow(AsyncResult.value(registry.get(state.workspaces))),
            [webWorkspace],
          );
          assert.strictEqual(registry.get(state.connection).kind, "active");
          rejectDeletion = false;
          registry.set(state.deleteWorkspace, { workspaceId: webWorkspace.id });
          yield* AtomRegistry.getResult(registry, state.deleteWorkspace, {
            suspendOnWaiting: true,
          });
          yield* waitFor(
            registry,
            state.workspaces,
            (value) => value._tag === "Failure" && !value.waiting,
          );
          assert.deepStrictEqual(
            Option.getOrThrow(AsyncResult.value(registry.get(state.workspaces))),
            [],
          );
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
        transcript: (chatId) =>
          Effect.sync(() =>
            snapshot([message], chatId === firstChat ? usage : { kind: "unavailable" }),
          ),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.contextUsage(firstChat));
        registry.mount(state.contextUsage(secondChat));
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
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: { type: "context-invalidated" },
        });
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
      const saved = { ...webWorkspace, worktree: { branch: "main", prefix: "pico/" } };
      let reads = 0;
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot()),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
        listWorkspaces: () =>
          Effect.suspend(() =>
            ++reads === 1 ? Effect.succeed([webWorkspace]) : Deferred.await(refreshed),
          ),
        updateWorkspace: () => Effect.succeed(saved),
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        registry.mount(state.workspaces);
        yield* AtomRegistry.getResult(registry, state.workspaces);
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
      const server = yield* fixture({
        transcript: () => Effect.succeed(snapshot()),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
        listChats: () =>
          Effect.suspend(() =>
            ++reads === 1
              ? Effect.succeed(chats)
              : Effect.fail(new ApplicationError({ reason: "operation", message: "Read failed" })),
          ),
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

        registry.set(close, { chatId: firstChat, allowDirtyWorktree: true });
        const closed = yield* AtomRegistry.getResult(registry, close, { suspendOnWaiting: true });
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
        yield* Deferred.succeed((yield* Queue.take(requests)).reply, [latest]);
        yield* waitFor(
          registry,
          state.workspaces,
          (value) =>
            value._tag === "Success" && !value.waiting && value.value[0]?.name === latest.name,
        );
        yield* Deferred.succeed(stale.reply, []);
        yield* Deferred.await(stale.returned);
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
            return snapshot(stored);
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
        const observed: Array<AgentTranscript> = [];
        registry.subscribe(
          state.transcript(firstChat),
          (value) => {
            if (AsyncResult.isSuccess(value)) observed.push(value.value);
          },
          { immediate: true },
        );
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
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(
          AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))),
          stored,
        );
        yield* Deferred.succeed(releaseStale, undefined);
        yield* Deferred.await(staleReturned);
        assert.deepStrictEqual(observed, [[message, message]]);
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
        assert.strictEqual(reads, 2);

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

  it.live("keeps historical list titles separate from newer events during a delayed refresh", () =>
    Effect.gen(function* () {
      const historical: ChatListEntry = {
        id: firstChat,
        workspaceId: webWorkspace.id,
        cwd: webWorkspace.defaultCwd,
        externalId: null,
        createdAt: 1,
        archivedAt: null,
        title: "Persisted inventory review",
      };
      const refreshing = yield* Deferred.make<void>();
      const refreshed = yield* Deferred.make<readonly ChatListEntry[]>();
      let listReads = 0;
      let transcriptReads = 0;
      const server = yield* fixture({
        listChats: () =>
          Effect.gen(function* () {
            if (++listReads === 1) return [historical];
            yield* Deferred.succeed(refreshing, undefined);
            return yield* Deferred.await(refreshed);
          }),
        transcript: () =>
          Effect.sync(() => {
            transcriptReads++;
            return snapshot();
          }),
        sendMessage: () => Effect.succeed({ kind: "handled" }),
        abort: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        const chats = state.chats(webWorkspace.id);
        registry.mount(chats);
        registry.mount(state.titles);
        const route = yield* Queue.take(server.opened);
        const initial = yield* AtomRegistry.getResult(registry, chats);
        assert.strictEqual(initial.find((chat) => chat.id === firstChat)?.title, historical.title);
        assert.isFalse(registry.get(state.titles).has(firstChat));

        registry.refresh(chats);
        yield* Deferred.await(refreshing);
        yield* Queue.offerAll(route.queue, [
          {
            chatId: firstChat,
            event: {
              type: "text-delta",
              messageId: orphanMessageId,
              contentIndex: 0,
              text: "unopened background response",
            },
          },
          {
            chatId: firstChat,
            event: {
              type: "message-settled",
              message: assistant(firstMessageId, "saved background response"),
            },
          },
          { chatId: firstChat, event: { type: "title-changed", title: "Live inventory review" } },
        ]);
        yield* waitFor(
          registry,
          state.titles,
          (titles) => titles.get(firstChat) === "Live inventory review",
        );
        yield* Deferred.succeed(refreshed, [{ ...historical, title: "Older inventory review" }]);
        yield* waitFor(registry, chats, (value) => value._tag === "Success" && !value.waiting);
        assert.strictEqual(
          AsyncResult.getOrThrow(registry.get(chats)).find((chat) => chat.id === firstChat)?.title,
          "Older inventory review",
        );
        assert.strictEqual(registry.get(state.titles).get(firstChat), "Live inventory review");
        assert.strictEqual(transcriptReads, 0);
        registry.mount(state.live(firstChat));
        assert.deepStrictEqual([...registry.get(state.live(firstChat)).assistant], []);
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live("observes unopened chat titles without retaining background assistant events", () =>
    Effect.gen(function* () {
      const server = yield* snapshotFixture();
      yield* Effect.gen(function* () {
        yield* Effect.addFinalizer(() => server.release);
        const state = make({ url: yield* endpoint });
        const registry = yield* registryInScope;
        const stored = assistant(firstMessageId, "saved background response");
        const releaseTitles = registry.mount(state.titles);
        const route = yield* Queue.take(server.opened);
        yield* Queue.offerAll(route.queue, [
          { chatId: firstChat, event: { type: "title-changed", title: "Background chat" } },
          {
            chatId: firstChat,
            event: {
              type: "text-delta",
              messageId: orphanMessageId,
              contentIndex: 0,
              text: "unseen partial response",
            },
          },
          { chatId: firstChat, event: { type: "message-settled", message: stored } },
          { chatId: firstChat, event: { type: "title-changed", title: "Renamed background chat" } },
        ]);
        yield* waitFor(
          registry,
          state.titles,
          (titles) => titles.get(firstChat) === "Renamed background chat",
        );
        releaseTitles();
        yield* Effect.yieldNow;
        registry.mount(state.titles);
        assert.strictEqual(registry.get(state.titles).get(firstChat), "Renamed background chat");

        registry.mount(state.live(firstChat));
        assert.deepStrictEqual([...registry.get(state.live(firstChat)).assistant], []);
        registry.mount(state.transcript(firstChat));
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [stored]);
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))), [
          stored,
        ]);
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: {
            type: "text-delta",
            messageId: nextMessageId,
            contentIndex: 0,
            text: "visible response",
          },
        });
        yield* waitFor(
          registry,
          state.live(firstChat),
          (live) => draftBlock(live, nextMessageId, 0)?.text === "visible response",
        );
        assert.isUndefined(draftBlock(registry.get(state.live(firstChat)), orphanMessageId, 0));
        assert.strictEqual(registry.get(state.titles).get(firstChat), "Renamed background chat");
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
            state.titles,
            (titles) => titles.get(firstChat) === "First registry",
          );
          assert.isFalse(second.get(state.titles).has(firstChat));
          yield* Queue.offer(secondRoute.queue, {
            chatId: firstChat,
            event: { type: "title-changed", title: "Second registry" },
          });
          yield* waitFor(
            second,
            state.titles,
            (titles) => titles.get(firstChat) === "Second registry",
          );
          assert.strictEqual(first.get(state.titles).get(firstChat), "First registry");
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
          assert.isTrue(Cause.hasDies(failed.cause));
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
        assert.deepStrictEqual((yield* Queue.takeN(sent, 2)).sort(), ["first", "second"]);
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
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, []);
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
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, []);
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
        const newer = yield* Queue.take(server.requests);
        yield* Deferred.succeed(newer.reply, [first]);
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [second]);
        yield* Deferred.succeed(stale.reply, [first, second]);
        yield* Deferred.await(stale.returned);
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
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [first, second]);
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
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, []);
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
        yield* Deferred.succeed(early.reply, [message, reply]);
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
        yield* Deferred.succeed(settled.reply, [message, reply]);
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
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [message, reply]);
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
        assert.deepStrictEqual(live.run, { kind: "finished", outcome: "completed" });
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
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [history]);
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
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: { type: "message-settled", message: second },
        });
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [history]);
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [
          first,
          second,
        ]);
        yield* Deferred.succeed(stale.reply, [history, first, second]);
        yield* Deferred.await(stale.returned);
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [
          first,
          second,
        ]);
        registry.refresh(state.transcript(firstChat));
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [
          history,
          { ...first, model: "normalized-model" },
        ]);
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
        yield* Deferred.succeed(finish.reply, [history, first, second]);
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
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [
          history,
          first,
          second,
          assistant(orphanMessageId, "orphan"),
        ]);
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
        yield* Queue.offerAll(route.queue, [
          { chatId: firstChat, event: { type: "message-settled", message: repeated } },
          { chatId: firstChat, event: { type: "title-changed", title: "settlement received" } },
        ]);
        yield* waitFor(
          registry,
          state.titles,
          (titles) => titles.get(firstChat) === "settlement received",
        );
        registry.mount(state.transcript(firstChat));
        yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [repeated]);
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
        assert.deepStrictEqual(AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))), [
          repeated,
        ]);
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), []);
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
        yield* Deferred.succeed(late.reply, [repeated]);
        yield* waitFor(
          registry,
          state.transcript(firstChat),
          (value) => AsyncResult.isSuccess(value) && !value.waiting,
        );
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );
});
