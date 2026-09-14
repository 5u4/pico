import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import {
  type AgentAssistantMessage,
  AgentPrompt,
  type AgentTranscript,
} from "@pico/contract/agent-message";
import { Application } from "@pico/contract/application";
import { ChatId } from "@pico/contract/chat-model";
import { ApplicationError, ChatClosed } from "@pico/contract/errors";
import { EventRouter } from "@pico/contract/event-router";
import { AbsolutePath } from "@pico/contract/path";
import { type Workspace, WorkspaceId } from "@pico/contract/workspace-model";
import * as RpcServer from "@pico/rpc/server";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
import { type LiveChat, make } from "../src/client.ts";

const firstChat = ChatId.make("018f47a0-0000-7000-8000-000000000001");
const secondChat = ChatId.make("018f47a0-0000-7000-8000-000000000002");
const message = { role: "user", content: [{ type: "text", text: "same" }], timestamp: 1 } as const;
const prompt = (text: string) => AgentPrompt.make({ text, attachments: [] });
const assistant = (text: string, timestamp: number): AgentAssistantMessage => ({
  role: "assistant",
  status: "completed",
  stopReason: "stop",
  content: [{ type: "text", text }],
  model: "test",
  timestamp,
});
const pendingMessages = (live: LiveChat) =>
  live.pending.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));

interface Route {
  readonly queue: Queue.Queue<AgentEventEnvelope, Cause.Done>;
  readonly closed: Deferred.Deferred<void>;
}

const fixture = Effect.fnUntraced(function* (
  procedures: Pick<Application["Service"], "transcript" | "sendMessage" | "abort"> &
    Partial<
      Pick<
        Application["Service"],
        "listWorkspaces" | "listChats" | "createWorkspace" | "createChat"
      >
    >,
) {
  const opened = yield* Queue.unbounded<Route>();
  const application = Application.of({
    listWorkspaces: () => Effect.die("unexpected workspace list"),
    listChats: () => Effect.die("unexpected chat list"),
    askBtw: () => Effect.die("unexpected side question"),
    createWorkspace: () => Effect.die("unexpected workspace creation"),
    getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
    bindWorkspace: () => Effect.die("unexpected workspace binding"),
    createChat: () => Effect.die("unexpected chat creation"),
    getOrCreateBotChat: () => Effect.die("unexpected bot chat creation"),
    sendBotMessage: () => Effect.die("unexpected bot message send"),
    findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
    findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
    findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
    contextUsage: () => Effect.die("unexpected context read"),
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
  const layer = HttpRouter.serve(RpcServer.routes).pipe(
    Layer.provide(
      Layer.merge(Layer.succeed(Application, application), Layer.succeed(EventRouter, router)),
    ),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );
  return { opened, layer };
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
    "activates the connection after an initial list rejection and allows a successful retry",
    () =>
      Effect.gen(function* () {
        const workspace: Workspace = {
          id: WorkspaceId.make("018f47a0-0000-7000-8000-000000000003"),
          name: "Project",
          defaultCwd: AbsolutePath.make("/tmp/project"),
          binding: null,
          worktree: null,
          createdAt: 1,
        };
        const rejection = new ApplicationError({ reason: "operation", message: "Read failed" });
        let reads = 0;
        const server = yield* fixture({
          transcript: () => Effect.succeed([]),
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
  it.live("retains workspace lists through refresh failures and fences superseded reads", () =>
    Effect.gen(function* () {
      const workspace: Workspace = {
        id: WorkspaceId.make("018f47a0-0000-7000-8000-000000000003"),
        name: "Project",
        defaultCwd: AbsolutePath.make("/tmp/project"),
        binding: null,
        worktree: null,
        createdAt: 1,
      };
      const latest = { ...workspace, name: "Renamed project" };
      const requests = yield* Queue.unbounded<{
        readonly reply: Deferred.Deferred<readonly Workspace[], ApplicationError>;
        readonly returned: Deferred.Deferred<void>;
      }>();
      const pending: Array<Deferred.Deferred<readonly Workspace[], ApplicationError>> = [];
      const server = yield* fixture({
        transcript: () => Effect.succeed([]),
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
                Effect.as([]),
                Effect.ensuring(Deferred.succeed(staleReturned, undefined)),
                Effect.uninterruptible,
              );
            }
            return stored;
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
          { chatId: firstChat, event: { type: "thinking-delta", contentIndex: 2, text: "plan" } },
          { chatId: firstChat, event: { type: "text-delta", contentIndex: 7, text: "partial" } },
          { chatId: secondChat, event: { type: "text-delta", contentIndex: 7, text: "other" } },
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
        assert.deepStrictEqual(registry.get(state.live(firstChat)).blocks.get(2), {
          type: "thinking-delta",
          contentIndex: 2,
          text: "plan",
        });
        assert.strictEqual(registry.get(state.live(firstChat)).blocks.get(7)?.text, "partial");
        assert.strictEqual(registry.get(state.live(secondChat)).blocks.get(7)?.text, "other");
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

  it.live(
    "isolates registries and rejects actions after Events ends while retaining partial content",
    () =>
      Effect.gen(function* () {
        let sends = 0;
        const server = yield* fixture({
          transcript: () => Effect.succeed([]),
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
            { chatId: firstChat, event: { type: "text-delta", contentIndex: 3, text: "keep me" } },
            { chatId: firstChat, event: { type: "title-changed", title: "First registry" } },
          ]);
          yield* waitFor(first, state.live(firstChat), (value) => value.title === "First registry");
          assert.strictEqual(second.get(state.live(firstChat)).title, null);
          assert.strictEqual(second.get(state.live(firstChat)).blocks.size, 0);
          yield* Queue.end(firstRoute.queue);
          yield* waitFor(first, state.connection, (value) => value.kind === "unavailable");
          assert.strictEqual(first.get(state.live(firstChat)).run.kind, "unknown");
          assert.strictEqual(first.get(state.live(firstChat)).blocks.get(3)?.text, "keep me");
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

  it.live("starts concurrent sends before any atom is mounted", () =>
    Effect.gen(function* () {
      const sent = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      const server = yield* fixture({
        transcript: () => Effect.succeed([]),
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
        const first = assistant("first answer", 1);
        const second = assistant("second answer", 2);
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
            event: { type: "text-delta", contentIndex: 0, text: "first answer" },
          },
          { chatId: firstChat, event: { type: "message-settled", message: first } },
        ]);
        const slow = yield* Queue.take(server.requests);
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: { type: "text-delta", contentIndex: 0, text: "second answer" },
        });
        yield* waitFor(
          registry,
          state.live(firstChat),
          (value) => value.blocks.get(0)?.text === "second answer",
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
              (message) => message.timestamp === second.timestamp,
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
        const reply = assistant("PICO_WEB_OK", 2);
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
          event: { type: "text-delta", contentIndex: 0, text: "PICO_WEB_OK" },
        });
        yield* waitFor(
          registry,
          state.live(firstChat),
          (value) => value.blocks.get(0)?.text === "PICO_WEB_OK",
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
        yield* Queue.offer(route.queue, {
          chatId: firstChat,
          event: { type: "message-settled", message: reply },
        });
        const settled = yield* Queue.take(server.requests);
        assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [reply]);
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
        assert.deepStrictEqual(live.pending, []);
        assert.deepStrictEqual([...live.blocks], []);
        assert.deepStrictEqual(live.run, { kind: "finished", outcome: "completed" });
      }).pipe(Effect.scoped, Effect.provide(server.layer));
    }),
  );

  it.live(
    "requires new equivalent occurrences and never confirms orphan drafts from snapshots",
    () =>
      Effect.gen(function* () {
        const server = yield* snapshotFixture();
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => server.release);
          const state = make({ url: yield* endpoint });
          const registry = yield* registryInScope;
          const repeated = assistant("repeated", 1);
          registry.mount(state.live(firstChat));
          const route = yield* Queue.take(server.opened);
          registry.mount(state.transcript(firstChat));
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [repeated]);
          yield* waitFor(
            registry,
            state.transcript(firstChat),
            (value) => AsyncResult.isSuccess(value) && !value.waiting,
          );
          yield* Queue.offer(route.queue, {
            chatId: firstChat,
            event: { type: "message-settled", message: repeated },
          });
          const one = yield* Queue.take(server.requests);
          yield* Queue.offer(route.queue, {
            chatId: firstChat,
            event: { type: "message-settled", message: repeated },
          });
          const two = yield* Queue.take(server.requests);
          yield* Deferred.succeed(two.reply, [repeated]);
          yield* waitFor(
            registry,
            state.transcript(firstChat),
            (value) => AsyncResult.isSuccess(value) && !value.waiting,
          );
          assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [
            repeated,
            repeated,
          ]);
          yield* Deferred.succeed(one.reply, [repeated, repeated, repeated]);
          yield* Deferred.await(one.returned);
          registry.refresh(state.transcript(firstChat));
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [
            repeated,
            { ...repeated, model: "different-model" },
          ]);
          yield* waitFor(
            registry,
            state.transcript(firstChat),
            (value) => AsyncResult.isSuccess(value) && !value.waiting,
          );
          assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [
            repeated,
            repeated,
          ]);
          registry.refresh(state.transcript(firstChat));
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [repeated, repeated]);
          yield* waitFor(
            registry,
            state.transcript(firstChat),
            (value) => AsyncResult.isSuccess(value) && !value.waiting,
          );
          assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [repeated]);
          yield* Queue.offerAll(route.queue, [
            { chatId: firstChat, event: { type: "text-delta", contentIndex: 0, text: "orphan" } },
            { chatId: firstChat, event: { type: "run-finished", outcome: "aborted" } },
          ]);
          const finish = yield* Queue.take(server.requests);
          yield* Queue.offerAll(route.queue, [
            { chatId: firstChat, event: { type: "run-started" } },
            { chatId: firstChat, event: { type: "text-delta", contentIndex: 0, text: "new run" } },
          ]);
          yield* waitFor(
            registry,
            state.live(firstChat),
            (value) => value.blocks.get(0)?.text === "new run",
          );
          yield* Deferred.succeed(finish.reply, [
            repeated,
            repeated,
            repeated,
            assistant("orphan", 2),
          ]);
          yield* waitFor(
            registry,
            state.transcript(firstChat),
            (value) => AsyncResult.isSuccess(value) && !value.waiting,
          );
          const live = registry.get(state.live(firstChat));
          assert.deepStrictEqual(pendingMessages(live), []);
          assert.deepStrictEqual(
            live.pending.flatMap((entry) =>
              entry.kind === "blocks" ? [...entry.blocks.values()].map((block) => block.text) : [],
            ),
            ["orphan"],
          );
          assert.strictEqual(live.blocks.get(0)?.text, "new run");
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );

  it.live(
    "retains a live-first settlement when the first snapshot may contain an old identical message",
    () =>
      Effect.gen(function* () {
        const server = yield* snapshotFixture();
        yield* Effect.gen(function* () {
          yield* Effect.addFinalizer(() => server.release);
          const state = make({ url: yield* endpoint });
          const registry = yield* registryInScope;
          const repeated = assistant("same as history", 1);
          registry.mount(state.live(firstChat));
          const route = yield* Queue.take(server.opened);
          yield* Queue.offerAll(route.queue, [
            { chatId: firstChat, event: { type: "message-settled", message: repeated } },
            { chatId: firstChat, event: { type: "title-changed", title: "settlement received" } },
          ]);
          yield* waitFor(
            registry,
            state.live(firstChat),
            (value) => value.title === "settlement received",
          );
          registry.mount(state.transcript(firstChat));
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [repeated]);
          yield* waitFor(
            registry,
            state.transcript(firstChat),
            (value) => AsyncResult.isSuccess(value) && !value.waiting,
          );
          assert.deepStrictEqual(
            AsyncResult.getOrThrow(registry.get(state.transcript(firstChat))),
            [repeated],
          );
          assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [repeated]);
          registry.refresh(state.transcript(firstChat));
          yield* Deferred.succeed((yield* Queue.take(server.requests)).reply, [repeated, repeated]);
          yield* waitFor(
            registry,
            state.transcript(firstChat),
            (value) => AsyncResult.isSuccess(value) && !value.waiting,
          );
          assert.deepStrictEqual(pendingMessages(registry.get(state.live(firstChat))), [repeated]);
        }).pipe(Effect.scoped, Effect.provide(server.layer));
      }),
  );
});
