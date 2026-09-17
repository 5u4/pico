import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import type { AgentEventEnvelope } from "@pico/contract/agent-event";
import { AgentMessageId } from "@pico/contract/agent-message";
import { AgentRuntime, type MessageDelivery } from "@pico/contract/agent-runtime";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ApplicationError, ChatClosed } from "@pico/contract/errors";
import { EventRouter } from "@pico/contract/event-router";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import { ChannelTypes } from "discordeno";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as EventRouterLayer from "../../event-router/src/layer.ts";
import { type DiscordInputBot, install } from "./discord-input.ts";
import * as DiscordOutput from "./discord-output.ts";
import type { DiscordMessage } from "./discord-prompt.ts";
import { pumpOutput } from "./layer.ts";

const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000001");
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const cwd = AbsolutePath.make("/tmp/pico-discord-delivery");
const chat: Chat.Chat = {
  id: chatId,
  workspaceId,
  cwd,
  externalId: "20",
  createdAt: 0,
  archivedAt: null,
};
const message = (id: bigint, channelId = 20n): DiscordMessage => ({
  id,
  channelId,
  guildId: 1n,
  author: { id: 100n },
  content: "same message",
  attachments: [],
});

const installInput = Effect.fn("test.installDeliveryInput")(function* (options: {
  readonly sendMessage: Application["Service"]["sendMessage"];
  readonly reactions: Pick<DiscordInputBot["helpers"], "addReaction" | "deleteOwnReaction">;
  readonly createChat?: Application["Service"]["createChat"];
  readonly reply?: DiscordInputBot["helpers"]["sendMessage"];
}) {
  const bot: DiscordInputBot = {
    id: 999n,
    events: {},
    helpers: {
      ...options.reactions,
      getChannel: async (channelId) =>
        channelId === 10n
          ? { id: 10n, guildId: 1n, type: ChannelTypes.GuildText, name: "general" }
          : { id: 20n, guildId: 1n, type: ChannelTypes.PublicThread, parentId: 10n },
      sendMessage: options.reply ?? (async () => undefined),
      editChannel: async () => undefined,
      startThreadWithoutMessage: async () => {
        throw new Error("unexpected schedule");
      },
      deleteChannel: async () => {
        throw new Error("unexpected schedule cleanup");
      },
      startThreadWithMessage: async () => ({ id: 20n }),
    },
  };
  const application = Application.of({
    deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
    updateWorkspace: () => Effect.die("unexpected workspace update"),
    availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
    setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
    availableModels: () => Effect.die("unexpected model discovery"),
    switchModel: () => Effect.die("unexpected model switch"),
    askBtw: () => Effect.die("unexpected side question"),
    listWorkspaces: () => Effect.die("unexpected workspace list"),
    createWorkspace: () => Effect.die("unexpected explicit workspace creation"),
    getOrCreateWorkspaceByBinding: () =>
      Effect.succeed({
        id: workspaceId,
        name: "general",
        platform: "discord",
        externalId: "1.10",
        defaultCwd: cwd,
        worktree: null,
        modelOverride: null,
        createdAt: 0,
      }),
    bindWorkspace: () => Effect.die("unexpected workspace binding"),
    listChats: () => Effect.die("unexpected chat list"),
    createChat: options.createChat ?? (() => Effect.succeed(chat)),
    findWorkspaceByPlatformId: () => Effect.succeed(Option.none()),
    findChatByPlatformId: () => Effect.succeed(Option.some(chat)),
    findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
    transcript: () => Effect.die("unexpected transcript read"),
    sendMessage: options.sendMessage,
    abort: () => Effect.die("unexpected chat abort"),
    contextUsage: () => Effect.die("unexpected context read"),
    shake: () => Effect.die("unexpected chat shake"),
    closeChat: () => Effect.die("unexpected chat close"),
  });
  yield* install(bot, {
    token: Redacted.make("test"),
    allowedGuildIds: ["1"],
    defaultCwd: cwd,
    showToolCalls: true,
    showThinking: false,
  }).pipe(Effect.provideService(Application, application), Effect.provide(BunCrypto.layer));
  const handle = bot.events.messageCreate;
  if (handle === undefined) return yield* Effect.die("Discord input handler was not installed");
  return handle;
});

describe("Discord message delivery", () => {
  it.effect(
    "sends scheduled text once while retaining local transcript and routed title events",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<AgentEventEnvelope>();
          const observed = yield* Deferred.make<void>();
          const titleDelivered = yield* Deferred.make<void>();
          const localEvents: AgentEventEnvelope[] = [];
          const sent: string[] = [];
          const titles: string[] = [];
          const unused = () => Effect.die("Unexpected agent operation");
          const runtime = AgentRuntime.of({
            events: Stream.fromQueue(events),
            drain: () => Effect.void,
            transcript: unused,
            send: unused,
            askBtw: unused,
            sendCaptured: unused,
            deliver: unused,
            publish: unused,
            close: unused,
            abort: unused,
            contextUsage: unused,
            availableModels: unused,
            switchModel: unused,
            shake: unused,
          });
          yield* Effect.gen(function* () {
            const router = yield* EventRouter;
            const local = yield* router.open(() => true);
            yield* local.events.pipe(
              Stream.runForEach((envelope) =>
                Effect.gen(function* () {
                  localEvents.push(envelope);
                  if (envelope.event.type === "run-finished")
                    yield* Deferred.succeed(observed, undefined);
                }),
              ),
              Effect.forkChild,
            );
            const client: DiscordOutput.DiscordOutputClient = {
              send: (_thread, output) =>
                Effect.sync(() => {
                  sent.push(output.content);
                  return 1n;
                }),
              edit: () => Effect.die("Unexpected scheduled edit"),
              renameThread: (_thread, title) =>
                Effect.gen(function* () {
                  titles.push(title);
                  yield* Deferred.succeed(titleDelivered, undefined);
                }),
              triggerTyping: () => Effect.void,
            };
            const dispatch = DiscordOutput.make(client, yield* Scope.Scope, {
              showToolCalls: false,
              showThinking: false,
            });
            yield* pumpOutput(router, () => Effect.succeed(Option.some(20n)), dispatch);
            yield* DiscordOutput.makeScheduledSender(client)({
              chatId,
              externalId: "20",
              content: "scheduled result",
            });
            const publication: AgentEventEnvelope = {
              chatId,
              localOnly: true,
              event: {
                type: "message-settled",
                message: {
                  role: "assistant",
                  id: AgentMessageId.make("scheduled-result"),
                  status: "completed",
                  stopReason: "stop",
                  model: "pico/schedule",
                  timestamp: 0,
                  content: [{ type: "text", text: "scheduled result" }],
                },
              },
            };
            yield* Queue.offer(events, publication);
            yield* Queue.offer(events, {
              chatId,
              event: { type: "title-changed", title: "Scheduled title" },
            });
            yield* Queue.offer(events, {
              chatId,
              event: { type: "run-finished", outcome: "completed" },
            });
            yield* Deferred.await(observed);
            yield* Deferred.await(titleDelivered);
            yield* router.drain();
            assert.deepStrictEqual(sent, ["scheduled result"]);
            assert.deepStrictEqual(titles, ["Scheduled title"]);
            assert.deepStrictEqual(localEvents[0], publication);
          }).pipe(
            Effect.provide(EventRouterLayer.layer),
            Effect.provideService(AgentRuntime, runtime),
          );
        }),
      ),
  );

  it.effect("distinguishes chat setup, admission, and completion failures in thread replies", () =>
    Effect.gen(function* () {
      const failure = new ApplicationError({
        reason: "operation",
        message: "private-stage-failure",
      });
      const stages = ["creation", "admission", "completion"] as const;
      const replies = yield* Effect.forEach(stages, (stage) =>
        Effect.scoped(
          Effect.gen(function* () {
            const replied = Promise.withResolvers<string>();
            const handle = yield* installInput({
              createChat: () =>
                stage === "creation" ? Effect.fail(failure) : Effect.succeed(chat),
              sendMessage: () =>
                stage === "admission"
                  ? Effect.fail(failure)
                  : Effect.succeed({ kind: "started", completed: Effect.fail(failure) }),
              reply: async (_channelId, options) => {
                replied.resolve(options.content);
              },
              reactions: {
                addReaction: async () => undefined,
                deleteOwnReaction: async () => undefined,
              },
            }).pipe(Effect.provide(Logger.layer([])));

            handle(message(101n, 10n));
            const content = yield* Effect.promise(() => replied.promise);
            assert.notInclude(content, failure.message);
            return content;
          }),
        ),
      );
      assert.strictEqual(new Set(replies).size, stages.length);
    }),
  );

  for (const reason of ["operation", "invalid-state"] as const) {
    it.effect(`notifies the new thread when chat creation fails with ${reason}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const replied = Promise.withResolvers<void>();
          const replies: Array<Parameters<DiscordInputBot["helpers"]["sendMessage"]>> = [];
          const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
          let admissions = 0;
          const handle = yield* installInput({
            createChat: () =>
              Effect.fail(new ApplicationError({ reason, message: "private-chat-setup-error" })),
            sendMessage: () =>
              Effect.sync(() => {
                admissions += 1;
                return { kind: "handled" };
              }),
            reply: async (channelId, options) => {
              replies.push([channelId, options]);
              replied.resolve();
            },
            reactions: {
              addReaction: async () => undefined,
              deleteOwnReaction: async () => undefined,
            },
          }).pipe(
            Effect.provide(
              Logger.layer([
                Logger.make((options) => logs.push(Logger.formatStructured.log(options))),
              ]),
            ),
          );

          handle(message(101n, 10n));
          yield* Effect.promise(() => replied.promise);
          assert.deepStrictEqual(
            replies.map(([channelId]) => channelId),
            [20n],
          );
          assert.strictEqual(admissions, 0);
          assert.notInclude(JSON.stringify(replies.map(([, options]) => options)), "private-");
          assert.deepStrictEqual(replies[0]?.[1].allowedMentions.parse, []);
          assert.strictEqual(logs.length, reason === "operation" ? 1 : 0);
          if (reason === "operation") {
            assert.deepStrictEqual(
              {
                phase: logs[0]?.annotations.phase,
                channelId: logs[0]?.annotations.channelId,
                threadId: logs[0]?.annotations.threadId,
                messageId: logs[0]?.annotations.messageId,
              },
              { phase: "create-chat", channelId: "10", threadId: "20", messageId: "101" },
            );
          }
        }),
      ),
    );
  }

  it.effect("reports a failed thread notification independently without retrying or leaking", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reported = Promise.withResolvers<void>();
        const replies: Array<Parameters<DiscordInputBot["helpers"]["sendMessage"]>> = [];
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const handle = yield* installInput({
          createChat: () => Effect.die(new Error("private-chat-defect")),
          sendMessage: () => Effect.die("unexpected admission after chat failure"),
          reply: async (channelId, options) => {
            replies.push([channelId, options]);
            throw new Error("private-discord-error", {
              cause: { status: 503, body: '{"code":50013,"message":"private-discord-body"}' },
            });
          },
          reactions: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
          },
        }).pipe(
          Effect.provide(
            Logger.layer([
              Logger.make((options) => {
                const entry = Logger.formatStructured.log(options);
                logs.push(entry);
                if (entry.annotations.operation === "reply-message-failure") reported.resolve();
              }),
            ]),
          ),
        );

        handle(message(101n, 10n));
        yield* Effect.promise(() => reported.promise);
        yield* TestClock.adjust("1 millis");
        assert.deepStrictEqual(
          replies.map(([channelId]) => channelId),
          [20n],
        );
        assert.deepStrictEqual(
          logs.map(({ annotations }) => ({
            operation: annotations.operation,
            channelId: annotations.channelId,
            threadId: annotations.threadId,
            status: annotations.status,
          })),
          [
            {
              operation: "message-request",
              channelId: "10",
              threadId: "20",
              status: undefined,
            },
            {
              operation: "reply-message-failure",
              channelId: "10",
              threadId: "20",
              status: 503,
            },
          ],
        );
        assert.notInclude(JSON.stringify(logs), "private-");
        assert.notInclude(JSON.stringify(replies.map(([, options]) => options)), "private-");
      }),
    ),
  );

  for (const failReply of [false, true]) {
    it.effect(
      `routes opening ChatClosed to the new thread${failReply ? " without retrying a failed reply" : ""}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const observed = Promise.withResolvers<void>();
            const channels: bigint[] = [];
            const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
            const handle = yield* installInput({
              sendMessage: () => Effect.fail(new ChatClosed()),
              reply: async (channelId) => {
                channels.push(channelId);
                if (failReply) throw { status: 403, body: "private-chat-closed-reply" };
                observed.resolve();
              },
              reactions: {
                addReaction: async () => undefined,
                deleteOwnReaction: async () => undefined,
              },
            }).pipe(
              Effect.provide(
                Logger.layer([
                  Logger.make((options) => {
                    logs.push(Logger.formatStructured.log(options));
                    observed.resolve();
                  }),
                ]),
              ),
            );

            handle(message(101n, 10n));
            yield* Effect.promise(() => observed.promise);
            yield* TestClock.adjust("1 millis");
            assert.deepStrictEqual(channels, [20n]);
            assert.deepStrictEqual(
              logs.map(({ annotations }) => annotations.operation),
              failReply ? ["reply-chat-closed"] : [],
            );
            assert.notInclude(JSON.stringify(logs), "private-");
          }),
        ),
    );
  }

  it.effect("keeps interrupted chat creation and opening completion quiet", () =>
    Effect.gen(function* () {
      const replies: bigint[] = [];
      const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      for (const stage of ["creation", "completion"] as const) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const interrupted = yield* Deferred.make<void>();
            const cancel = Effect.interrupt.pipe(
              Effect.ensuring(Deferred.succeed(interrupted, undefined)),
            );
            const handle = yield* installInput({
              createChat: () => (stage === "creation" ? cancel : Effect.succeed(chat)),
              sendMessage: () => Effect.succeed({ kind: "started", completed: cancel }),
              reply: async (channelId) => {
                replies.push(channelId);
              },
              reactions: {
                addReaction: async () => undefined,
                deleteOwnReaction: async () => undefined,
              },
            }).pipe(
              Effect.provide(
                Logger.layer([
                  Logger.make((options) => logs.push(Logger.formatStructured.log(options))),
                ]),
              ),
            );
            handle(message(101n, 10n));
            yield* Deferred.await(interrupted);
            yield* TestClock.adjust("1 millis");
          }),
        );
      }
      assert.deepStrictEqual(replies, []);
      assert.deepStrictEqual(logs, []);
    }),
  );

  it.effect("leaves normal agent terminal failures to event output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const finished = yield* Deferred.make<void>();
        const replies: bigint[] = [];
        const rendered: Array<{ readonly channelId: bigint; readonly content: string }> = [];
        const dispatch = DiscordOutput.make(
          {
            send: (channelId, output) =>
              Effect.sync(() => {
                rendered.push({ channelId, content: output.content });
                return 1n;
              }),
            edit: () => Effect.void,
            renameThread: () => Effect.void,
            triggerTyping: () => Effect.void,
          },
          yield* Scope.Scope,
          { showToolCalls: false, showThinking: false },
        );
        const handle = yield* installInput({
          sendMessage: () =>
            Effect.succeed({
              kind: "started",
              completed: Effect.gen(function* () {
                yield* dispatch(20n, { chatId, event: { type: "run-started" } });
                yield* dispatch(20n, {
                  chatId,
                  event: {
                    type: "message-settled",
                    message: {
                      role: "assistant",
                      id: AgentMessageId.make("failed-request"),
                      status: "failed",
                      stopReason: "error",
                      message: "private-terminal-error",
                      content: [],
                      model: "test",
                      timestamp: 0,
                    },
                  },
                });
                yield* dispatch(20n, {
                  chatId,
                  event: { type: "run-finished", outcome: "failed" },
                });
                yield* Deferred.succeed(finished, undefined);
              }).pipe(Effect.orDie),
            }),
          reply: async (channelId) => {
            replies.push(channelId);
          },
          reactions: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
          },
        });

        handle(message(101n, 10n));
        yield* Deferred.await(finished);
        yield* TestClock.adjust("1 millis");
        assert.deepStrictEqual(replies, []);
        assert.deepStrictEqual(
          rendered.map(({ channelId }) => channelId),
          [20n],
        );
        assert.notInclude(rendered[0]?.content ?? "", "private-terminal-error");
      }),
    ),
  );

  it.effect("admits the next message before completion and retains the first failure context", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const completionObserved = yield* Deferred.make<void>();
        const completion = yield* Deferred.make<void, ApplicationError>();
        const secondAdmitted = yield* Deferred.make<void>();
        const replied = Promise.withResolvers<void>();
        const replies: Array<{ readonly channelId: bigint; readonly content: string }> = [];
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const reactions: string[] = [];
        let admissions = 0;
        const logger = Logger.make((options) => {
          const entry = Logger.formatStructured.log(options);
          logs.push(entry);
        });
        const handle = yield* installInput({
          sendMessage: () =>
            Effect.gen(function* () {
              admissions += 1;
              if (admissions === 1) {
                return {
                  kind: "started",
                  completed: Deferred.succeed(completionObserved, undefined).pipe(
                    Effect.andThen(Deferred.await(completion)),
                  ),
                } satisfies MessageDelivery<ApplicationError>;
              }
              yield* Deferred.succeed(secondAdmitted, undefined);
              return { kind: "handled" } satisfies MessageDelivery<ApplicationError>;
            }),
          reply: async (channelId, options) => {
            replies.push({ channelId, content: options.content });
            replied.resolve();
          },
          reactions: {
            addReaction: async (_channelId, _messageId, reaction) => {
              reactions.push(reaction);
            },
            deleteOwnReaction: async (_channelId, _messageId, reaction) => {
              reactions.push(reaction);
            },
          },
        }).pipe(Effect.provide(Logger.layer([logger])));

        handle(message(101n, 10n));
        yield* Deferred.await(completionObserved);
        handle(message(102n));
        yield* Deferred.await(secondAdmitted);
        assert.isFalse(yield* Deferred.isDone(completion));
        assert.deepStrictEqual(reactions, []);
        yield* Deferred.fail(
          completion,
          new ApplicationError({ reason: "operation", message: "private-completion-failure" }),
        );
        yield* Effect.promise(() => replied.promise);
        assert.deepStrictEqual(
          replies.map(({ channelId }) => channelId),
          [20n],
        );
        assert.notInclude(replies[0]?.content ?? "", "private-completion-failure");
        assert.strictEqual(logs.length, 1);
        assert.deepStrictEqual(
          {
            operation: logs[0]?.annotations.operation,
            phase: logs[0]?.annotations.phase,
            chatId: logs[0]?.annotations.chatId,
            threadId: logs[0]?.annotations.threadId,
            channelId: logs[0]?.annotations.channelId,
            messageId: logs[0]?.annotations.messageId,
          },
          {
            operation: "message-request",
            phase: "send-prompt",
            chatId,
            threadId: "20",
            channelId: "10",
            messageId: "101",
          },
        );
      }),
    ),
  );

  it.effect(
    "tracks equal messages separately and removes discarded input without a consumed mark",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstConsumed = yield* Deferred.make<"consumed" | "discarded">();
          const secondConsumed = yield* Deferred.make<"consumed" | "discarded">();
          const firstPending = Promise.withResolvers<void>();
          const secondPending = Promise.withResolvers<void>();
          const secondMarked = Promise.withResolvers<void>();
          const firstRemoved = Promise.withResolvers<void>();
          const actions: string[] = [];
          const prompts: string[] = [];
          const deliveries: Array<MessageDelivery<ApplicationError>> = [
            { kind: "steered", consumed: Deferred.await(firstConsumed), completed: Effect.void },
            { kind: "steered", consumed: Deferred.await(secondConsumed), completed: Effect.void },
          ];
          const handle = yield* installInput({
            sendMessage: (_chatId, prompt) =>
              Effect.sync(() => {
                prompts.push(prompt.text);
                const delivery = deliveries.shift();
                if (delivery === undefined) throw new Error("unexpected extra admission");
                return delivery;
              }),
            reactions: {
              addReaction: async (channelId, messageId, reaction) => {
                actions.push(`add:${channelId}:${messageId}:${reaction}`);
                if (reaction === "⏳") {
                  (messageId === 101n ? firstPending : secondPending).resolve();
                } else {
                  secondMarked.resolve();
                }
              },
              deleteOwnReaction: async (channelId, messageId, reaction) => {
                actions.push(`remove:${channelId}:${messageId}:${reaction}`);
                if (messageId === 101n) firstRemoved.resolve();
              },
            },
          });

          handle(message(101n, 10n));
          yield* Effect.promise(() => firstPending.promise);
          handle(message(102n));
          yield* Effect.promise(() => secondPending.promise);
          assert.deepStrictEqual(prompts, ["same message", "same message"]);
          assert.deepStrictEqual(actions, ["add:10:101:⏳", "add:20:102:⏳"]);
          yield* Deferred.succeed(secondConsumed, "consumed");
          yield* Effect.promise(() => secondMarked.promise);
          assert.deepStrictEqual(actions, [
            "add:10:101:⏳",
            "add:20:102:⏳",
            "remove:20:102:⏳",
            "add:20:102:↩️",
          ]);
          assert.isFalse(yield* Deferred.isDone(firstConsumed));
          yield* Deferred.succeed(firstConsumed, "discarded");
          yield* Effect.promise(() => firstRemoved.promise);
          yield* TestClock.adjust("1 millis");
          assert.deepStrictEqual(actions, [
            "add:10:101:⏳",
            "add:20:102:⏳",
            "remove:20:102:⏳",
            "add:20:102:↩️",
            "remove:10:101:⏳",
          ]);
        }),
      ),
  );

  it.effect(
    "serializes a delayed pending reaction after admission without blocking later messages",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const admissionStarted = yield* Deferred.make<void>();
          const releaseAdmission = yield* Deferred.make<void>();
          const consumed = yield* Deferred.make<"consumed" | "discarded">();
          const secondAdmitted = yield* Deferred.make<void>();
          const pendingStarted = Promise.withResolvers<void>();
          const releasePending = Promise.withResolvers<void>();
          const marked = Promise.withResolvers<void>();
          const actions: string[] = [];
          let admissions = 0;
          const handle = yield* installInput({
            sendMessage: () =>
              Effect.gen(function* () {
                admissions += 1;
                if (admissions === 1) {
                  yield* Deferred.succeed(admissionStarted, undefined);
                  yield* Deferred.await(releaseAdmission);
                  return {
                    kind: "steered",
                    consumed: Deferred.await(consumed),
                    completed: Effect.void,
                  } satisfies MessageDelivery<ApplicationError>;
                }
                yield* Deferred.succeed(secondAdmitted, undefined);
                return { kind: "handled" } satisfies MessageDelivery<ApplicationError>;
              }),
            reactions: {
              addReaction: async (_channelId, _messageId, reaction) => {
                if (reaction === "⏳") {
                  actions.push("pending-start");
                  pendingStarted.resolve();
                  await releasePending.promise;
                  actions.push("pending-end");
                } else {
                  actions.push("consumed");
                  marked.resolve();
                }
              },
              deleteOwnReaction: async () => {
                actions.push("remove-pending");
              },
            },
          });

          handle(message(101n));
          yield* Deferred.await(admissionStarted);
          handle(message(102n));
          yield* TestClock.adjust("1 millis");
          assert.strictEqual(admissions, 1);
          assert.deepStrictEqual(actions, []);
          yield* Deferred.succeed(releaseAdmission, undefined);
          yield* Effect.promise(() => pendingStarted.promise);
          yield* Deferred.await(secondAdmitted);
          yield* Deferred.succeed(consumed, "consumed");
          yield* TestClock.adjust("1 millis");
          assert.deepStrictEqual(actions, ["pending-start"]);
          releasePending.resolve();
          yield* Effect.promise(() => marked.promise);
          assert.deepStrictEqual(actions, [
            "pending-start",
            "pending-end",
            "remove-pending",
            "consumed",
          ]);
        }),
      ),
  );

  it.effect(
    "reports each reaction failure without canceling completion or suppressing later updates",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const consumed = yield* Deferred.make<"consumed" | "discarded">();
          const completed = yield* Deferred.make<void>();
          const completionObserved = yield* Deferred.make<void>();
          const completionFinished = yield* Deferred.make<void>();
          const pendingReported = Promise.withResolvers<void>();
          const finalReported = Promise.withResolvers<void>();
          const actions: string[] = [];
          const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
          const logger = Logger.make((options) => {
            const entry = Logger.formatStructured.log(options);
            logs.push(entry);
            if (entry.annotations.operation === "add-pending-reaction") pendingReported.resolve();
            if (entry.annotations.operation === "add-consumed-reaction") finalReported.resolve();
          });
          const handle = yield* installInput({
            sendMessage: () =>
              Effect.succeed({
                kind: "steered",
                consumed: Deferred.await(consumed),
                completed: Effect.gen(function* () {
                  yield* Deferred.succeed(completionObserved, undefined);
                  yield* Deferred.await(completed);
                  yield* Deferred.succeed(completionFinished, undefined);
                }),
              } satisfies MessageDelivery<ApplicationError>),
            reactions: {
              addReaction: async (_channelId, _messageId, reaction) => {
                actions.push(`add:${reaction}`);
                throw { status: 403, body: '{"code":50013}' };
              },
              deleteOwnReaction: async (_channelId, _messageId, reaction) => {
                actions.push(`remove:${reaction}`);
                throw { status: 500 };
              },
            },
          }).pipe(Effect.provide(Logger.layer([logger])));

          handle(message(101n));
          yield* Deferred.await(completionObserved);
          yield* Effect.promise(() => pendingReported.promise);
          assert.deepStrictEqual(actions, ["add:⏳"]);
          yield* Deferred.succeed(consumed, "consumed");
          yield* Effect.promise(() => finalReported.promise);
          assert.deepStrictEqual(actions, ["add:⏳", "remove:⏳", "add:↩️"]);
          assert.deepStrictEqual(
            logs.map(({ annotations }) => ({
              operation: annotations.operation,
              status: annotations.status,
              channelId: annotations.channelId,
              messageId: annotations.messageId,
            })),
            [
              { operation: "add-pending-reaction", status: 403, channelId: "20", messageId: "101" },
              {
                operation: "remove-pending-reaction",
                status: 500,
                channelId: "20",
                messageId: "101",
              },
              {
                operation: "add-consumed-reaction",
                status: 403,
                channelId: "20",
                messageId: "101",
              },
            ],
          );
          assert.isFalse(yield* Deferred.isDone(completionFinished));
          yield* Deferred.succeed(completed, undefined);
          yield* Deferred.await(completionFinished);
        }),
      ),
  );

  it.effect("stops observing receipts when the Discord service scope closes", () =>
    Effect.gen(function* () {
      const consumed = yield* Deferred.make<"consumed" | "discarded">();
      const consumptionObserved = yield* Deferred.make<void>();
      const completionObserved = yield* Deferred.make<void>();
      const consumptionInterrupted = yield* Deferred.make<void>();
      const completionInterrupted = yield* Deferred.make<void>();
      const actions: string[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* installInput({
            sendMessage: () =>
              Effect.succeed({
                kind: "steered",
                consumed: Deferred.succeed(consumptionObserved, undefined).pipe(
                  Effect.andThen(Deferred.await(consumed)),
                  Effect.onInterrupt(() => Deferred.succeed(consumptionInterrupted, undefined)),
                ),
                completed: Deferred.succeed(completionObserved, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(completionInterrupted, undefined)),
                ),
              } satisfies MessageDelivery<ApplicationError>),
            reactions: {
              addReaction: async (_channelId, _messageId, reaction) => {
                actions.push(`add:${reaction}`);
              },
              deleteOwnReaction: async (_channelId, _messageId, reaction) => {
                actions.push(`remove:${reaction}`);
              },
            },
          });
          handle(message(101n));
          yield* Deferred.await(consumptionObserved);
          yield* Deferred.await(completionObserved);
          assert.isFalse(yield* Deferred.isDone(consumptionInterrupted));
          assert.isFalse(yield* Deferred.isDone(completionInterrupted));
        }),
      );
      assert.isTrue(yield* Deferred.isDone(consumptionInterrupted));
      assert.isTrue(yield* Deferred.isDone(completionInterrupted));
      yield* Deferred.succeed(consumed, "consumed");
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(actions, ["add:⏳"]);
    }),
  );
});
