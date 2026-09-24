import { assert, describe, it } from "@effect/vitest";
import type { TelegramConfig } from "@pico/config/config";
import { type AgentEventEnvelope, Publication } from "@pico/contract/agent-event";
import * as AgentMessage from "@pico/contract/agent-message";
import { Application } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ApplicationError } from "@pico/contract/errors";
import { EventRouter } from "@pico/contract/event-router";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { type TelegramClient, TelegramError } from "./client.ts";
import { layer } from "./layer.ts";
import type { TelegramAddress, TelegramInput } from "./telegram-model.ts";

const baseChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000222");
const baseWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000111");

const baseConfig: TelegramConfig = {
  token: Redacted.make("token-value"),
  allowedChatIds: ["-1001"],
  allowedUserIds: ["42"],
};

const topicInput = (
  input: Omit<Extract<TelegramInput, { readonly kind: "forum-topic" }>, "kind">,
): TelegramInput => ({ kind: "forum-topic", ...input });

const unsupportedInput = (
  input: Omit<Extract<TelegramInput, { readonly kind: "unsupported" }>, "kind">,
): TelegramInput => ({ kind: "unsupported", ...input });

const settledEnvelope = (
  publication: number,
  options: { readonly text: string; readonly localOnly?: true },
): AgentEventEnvelope => ({
  chatId: baseChatId,
  publication: Publication.make(publication),
  origin: "session",
  ...(options.localOnly === true ? { localOnly: true } : {}),
  event: {
    type: "message-settled",
    message: {
      role: "assistant",
      id: AgentMessage.AgentMessageId.make(`message-${publication}`),
      status: "completed",
      stopReason: "stop",
      content: [{ type: "text", text: options.text }],
      model: "test",
      timestamp: publication,
    },
  },
});

const unexpected = () => Effect.die("unexpected application operation");

const applicationBase = {
  listWorkspaces: unexpected,
  createWorkspace: unexpected,
  updateWorkspace: unexpected,
  deleteWorkspace: unexpected,
  getOrCreateWorkspaceByBinding: unexpected,
  bindWorkspace: unexpected,
  availableWorkspaceModels: unexpected,
  availableWorkspaceSkills: unexpected,
  setWorkspaceModel: unexpected,
  listChats: unexpected,
  createChat: unexpected,
  findWorkspaceByPlatformId: unexpected,
  findChatByPlatformId: unexpected,
  findChatPlatformBinding: unexpected,
  transcript: unexpected,
  history: unexpected,
  previewHistory: unexpected,
  navigateHistory: unexpected,
  chatResults: (_input) => Effect.succeed([]),
  closeChat: unexpected,
  sendMessage: unexpected,
  askBtw: unexpected,
  abort: unexpected,
  contextUsage: unexpected,
  availableModels: unexpected,
  availableSkills: unexpected,
  switchModel: unexpected,
  shake: unexpected,
} satisfies Application["Service"];

const makeRouter = (events: Queue.Queue<AgentEventEnvelope, never>): EventRouter["Service"] =>
  EventRouter.of({
    open: (filter) =>
      Effect.succeed({
        events: Stream.fromQueue(events).pipe(Stream.filter(filter)),
        setFilter: () => Effect.void,
      }),
    drain: () => Effect.void,
  });

const startLayer = (
  config: TelegramConfig,
  client: TelegramClient,
  application: Application["Service"],
  router: EventRouter["Service"],
) =>
  Layer.build(layer(config, { client })).pipe(
    Effect.provideService(Application, application),
    Effect.provideService(EventRouter, router),
  );

describe("telegram layer", () => {
  it.effect("requires both user and chat authorization and ignores unsupported updates", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inputs = yield* Queue.unbounded<TelegramInput, never>();
        const events = yield* Queue.unbounded<AgentEventEnvelope, never>();
        const processed = yield* Deferred.make<void>();
        let handled = 0;
        let applicationCalls = 0;
        const topicReplies: string[] = [];
        const generalReplies: string[] = [];

        const client: TelegramClient = {
          identity: { id: "1", username: "pico_bot" },
          consume: (handle) =>
            Effect.forever(
              Queue.take(inputs).pipe(
                Effect.flatMap(handle),
                Effect.flatMap(() => {
                  handled += 1;
                  return handled === 3 ? Deferred.succeed(processed, undefined) : Effect.void;
                }),
              ),
            ),
          sendText: (_address, text) =>
            Effect.sync(() => {
              topicReplies.push(text);
            }),
          sendGeneral: (_chatId, text) =>
            Effect.sync(() => {
              generalReplies.push(text);
            }),
        };

        const application = Application.of({
          ...applicationBase,
          findWorkspaceByPlatformId: () =>
            Effect.sync(() => {
              applicationCalls += 1;
              return Option.none();
            }),
        });
        yield* startLayer(baseConfig, client, application, makeRouter(events));

        yield* Queue.offer(
          inputs,
          topicInput({
            chatId: "-1001",
            userId: "99",
            text: "hello",
            chatTitle: "Engineering",
            command: null,
            address: { chatId: "-1001", topicId: 7 },
          }),
        );
        yield* Queue.offer(
          inputs,
          unsupportedInput({
            reason: "private-chat",
            chatId: "123",
            userId: "42",
          }),
        );
        yield* Queue.offer(
          inputs,
          topicInput({
            chatId: "-2000",
            userId: "42",
            text: "ignored",
            chatTitle: "Off-topic",
            command: null,
            address: { chatId: "-2000", topicId: 7 },
          }),
        );

        yield* Deferred.await(processed);
        assert.strictEqual(applicationCalls, 0);
        assert.deepStrictEqual(topicReplies, []);
        assert.deepStrictEqual(generalReplies, []);
      }),
    ),
  );

  it.effect.each([
    { operation: "createChat", reason: "invalid-state", withDefect: false },
    { operation: "sendMessage", reason: "operation", withDefect: false },
    { operation: "createChat", reason: "invalid-state", withDefect: true },
  ] as const)(
    "replies safely when $operation fails with $reason and a co-present defect is $withDefect",
    ({ operation, reason, withDefect }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const inputs = yield* Queue.unbounded<TelegramInput, never>();
          const events = yield* Queue.unbounded<AgentEventEnvelope, never>();
          const processed = yield* Deferred.make<void>();
          const replies: { readonly address: TelegramAddress; readonly text: string }[] = [];
          const generalReplies: string[] = [];
          const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
          const sensitiveDetails = [
            "/private/telegram-secret-workspace",
            "https://provider.invalid/private-request",
            "secret-provider-token",
          ];
          const failure = new ApplicationError({
            reason,
            message: sensitiveDetails.join(" "),
          });
          const admissionFailure = withDefect
            ? Effect.failCause(
                Cause.combine(Cause.fail(failure), Cause.die(sensitiveDetails.join(" "))),
              )
            : Effect.fail(failure);
          const workspace: Workspace.Workspace = {
            id: baseWorkspaceId,
            name: "Workspace",
            platform: "telegram",
            externalId: "-1001",
            defaultCwd: AbsolutePath.make("/tmp/workspace"),
            worktree: null,
            modelOverride: null,
            createdAt: 0,
          };
          const chat: Chat.Chat = {
            id: baseChatId,
            workspaceId: baseWorkspaceId,
            cwd: AbsolutePath.make("/tmp/chat"),
            externalId: "-1001.77",
            createdAt: 0,
            archivedAt: null,
          };
          const application = Application.of({
            ...applicationBase,
            findWorkspaceByPlatformId: () => Effect.succeed(Option.some(workspace)),
            findChatByPlatformId: () =>
              Effect.succeed(operation === "createChat" ? Option.none() : Option.some(chat)),
            createChat: () => admissionFailure,
            sendMessage: () => admissionFailure,
          });
          const client: TelegramClient = {
            identity: { id: "1", username: "pico_bot" },
            consume: (handle) =>
              Effect.forever(
                Queue.take(inputs).pipe(
                  Effect.flatMap(handle),
                  Effect.andThen(Deferred.succeed(processed, undefined)),
                ),
              ),
            sendText: (address, text) =>
              Effect.sync(() => {
                replies.push({ address, text });
              }),
            sendGeneral: (_chatId, text) =>
              Effect.sync(() => {
                generalReplies.push(text);
              }),
          };

          yield* startLayer(baseConfig, client, application, makeRouter(events)).pipe(
            Effect.provide(
              Logger.layer([
                Logger.make((options) => logs.push(Logger.formatStructured.log(options))),
              ]),
            ),
          );
          yield* Queue.offer(
            inputs,
            topicInput({
              chatId: "-1001",
              userId: "42",
              text: "hello",
              chatTitle: "Engineering",
              command: null,
              address: { chatId: "-1001", topicId: 77 },
            }),
          );

          yield* Deferred.await(processed);
          assert.deepStrictEqual(
            replies.map(({ address }) => address),
            [{ chatId: "-1001", topicId: 77 }],
          );
          assert.deepStrictEqual(generalReplies, []);
          for (const reply of replies) {
            assert.notStrictEqual(reply.text.trim(), "");
            for (const detail of sensitiveDetails) assert.notInclude(reply.text, detail);
          }
          assert.deepStrictEqual(
            logs
              .filter((entry) => entry.annotations.operation === "consume-input")
              .map((entry) => entry.annotations.category),
            withDefect || reason === "operation" ? ["unexpected"] : [],
          );
          for (const detail of sensitiveDetails) assert.notInclude(JSON.stringify(logs), detail);
        }),
      ),
  );

  it.effect.each(["typed failure", "synchronous defect"] as const)(
    "attempts an error reply once after a %s and continues processing later inputs",
    (failureKind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const inputs = yield* Queue.unbounded<TelegramInput, never>();
          const events = yield* Queue.unbounded<AgentEventEnvelope, never>();
          const processed = yield* Deferred.make<void>();
          let handled = 0;
          const attempts: { readonly address: TelegramAddress; readonly text: string }[] = [];
          const delivered: { readonly address: TelegramAddress; readonly text: string }[] = [];
          const workspace: Workspace.Workspace = {
            id: baseWorkspaceId,
            name: "Workspace",
            platform: "telegram",
            externalId: "-1001",
            defaultCwd: AbsolutePath.make("/tmp/workspace"),
            worktree: null,
            modelOverride: null,
            createdAt: 0,
          };
          const application = Application.of({
            ...applicationBase,
            findWorkspaceByPlatformId: () => Effect.succeed(Option.some(workspace)),
            findChatByPlatformId: () => Effect.succeed(Option.none()),
            createChat: () =>
              Effect.fail(
                new ApplicationError({
                  reason: "invalid-state",
                  message: "/private/telegram-secret-workspace no longer exists",
                }),
              ),
          });
          const client: TelegramClient = {
            identity: { id: "1", username: "pico_bot" },
            consume: (handle) =>
              Effect.forever(
                Queue.take(inputs).pipe(
                  Effect.flatMap(handle),
                  Effect.flatMap(() => {
                    handled += 1;
                    return handled === 2 ? Deferred.succeed(processed, undefined) : Effect.void;
                  }),
                ),
              ),
            sendText: (address, text) => {
              attempts.push({ address, text });
              if (address.topicId === 77 && failureKind === "synchronous defect") {
                throw new Error("sendText threw before returning an Effect");
              }
              return Effect.gen(function* () {
                if (address.topicId === 77) {
                  return yield* Effect.fail(
                    new TelegramError({
                      message: "error reply delivery failed",
                      operation: "send-message",
                      category: "network",
                    }),
                  );
                }
                delivered.push({ address, text });
              });
            },
            sendGeneral: () => Effect.void,
          };

          yield* startLayer(baseConfig, client, application, makeRouter(events));
          yield* Queue.offer(
            inputs,
            topicInput({
              chatId: "-1001",
              userId: "42",
              text: "hello",
              chatTitle: "Engineering",
              command: null,
              address: { chatId: "-1001", topicId: 77 },
            }),
          );
          yield* Queue.offer(
            inputs,
            topicInput({
              chatId: "-1001",
              userId: "42",
              text: "/bind",
              chatTitle: "Engineering",
              command: { name: "bind", target: "self", argument: "" },
              address: { chatId: "-1001", topicId: 88 },
            }),
          );

          yield* Deferred.await(processed);
          assert.deepStrictEqual(
            attempts.map(({ address }) => address),
            [
              { chatId: "-1001", topicId: 77 },
              { chatId: "-1001", topicId: 88 },
            ],
          );
          assert.deepStrictEqual(
            delivered.map(({ address }) => address),
            [{ chatId: "-1001", topicId: 88 }],
          );
          for (const reply of attempts) assert.notStrictEqual(reply.text.trim(), "");
        }),
      ),
  );

  it.effect("keeps /abort responsive while completion remains pending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inputs = yield* Queue.unbounded<TelegramInput, never>();
        const events = yield* Queue.unbounded<AgentEventEnvelope, never>();
        const completion = yield* Deferred.make<void>();
        const abortCalled = yield* Deferred.make<void>();

        const workspace: Workspace.Workspace = {
          id: baseWorkspaceId,
          name: "Workspace",
          platform: "telegram",
          externalId: "-1001",
          defaultCwd: AbsolutePath.make("/tmp/workspace"),
          worktree: null,
          modelOverride: null,
          createdAt: 0,
        };
        const chat: Chat.Chat = {
          id: baseChatId,
          workspaceId: baseWorkspaceId,
          cwd: AbsolutePath.make("/tmp/chat"),
          externalId: "-1001.77",
          createdAt: 0,
          archivedAt: null,
        };

        const application = Application.of({
          ...applicationBase,
          findWorkspaceByPlatformId: () => Effect.succeed(Option.some(workspace)),
          findChatByPlatformId: () => Effect.succeed(Option.some(chat)),
          sendMessage: () =>
            Effect.succeed({
              kind: "started",
              completed: Deferred.await(completion),
            }),
          abort: () =>
            Effect.sync(() => {
              Deferred.doneUnsafe(abortCalled, Effect.void);
            }),
        });

        const client: TelegramClient = {
          identity: { id: "1", username: "pico_bot" },
          consume: (handle) => Effect.forever(Queue.take(inputs).pipe(Effect.flatMap(handle))),
          sendText: () => Effect.void,
          sendGeneral: () => Effect.void,
        };

        yield* startLayer(baseConfig, client, application, makeRouter(events));

        yield* Queue.offer(
          inputs,
          topicInput({
            chatId: "-1001",
            userId: "42",
            text: "start",
            chatTitle: "Engineering",
            command: null,
            address: { chatId: "-1001", topicId: 77 },
          }),
        );
        yield* Queue.offer(
          inputs,
          topicInput({
            chatId: "-1001",
            userId: "42",
            text: "/abort",
            chatTitle: "Engineering",
            command: { name: "abort", target: "self", argument: "" },
            address: { chatId: "-1001", topicId: 77 },
          }),
        );

        yield* Deferred.await(abortCalled);
      }),
    ),
  );

  it.effect("never forwards localOnly output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inputs = yield* Queue.unbounded<TelegramInput, never>();
        const events = yield* Queue.unbounded<AgentEventEnvelope, never>();
        const sent = yield* Deferred.make<void>();
        const delivered: string[] = [];

        const application = Application.of({
          ...applicationBase,
          findChatPlatformBinding: () =>
            Effect.succeed(
              Option.some({
                platform: "telegram",
                externalId: "-1001.7",
              }),
            ),
        });

        const client: TelegramClient = {
          identity: { id: "1", username: "pico_bot" },
          consume: (handle) => Effect.forever(Queue.take(inputs).pipe(Effect.flatMap(handle))),
          sendText: (_address, text) =>
            Effect.sync(() => {
              delivered.push(text);
              if (delivered.length === 1) Deferred.doneUnsafe(sent, Effect.void);
            }),
          sendGeneral: () => Effect.void,
        };

        yield* startLayer(baseConfig, client, application, makeRouter(events));
        yield* Queue.offer(events, settledEnvelope(1, { text: "local", localOnly: true }));
        yield* Queue.offer(events, settledEnvelope(2, { text: "visible" }));

        yield* Deferred.await(sent);
        assert.deepStrictEqual(delivered, ["visible"]);
      }),
    ),
  );
  it.effect("releases its event route when polling stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failPoll = yield* Deferred.make<void>();
        const routeClosed = yield* Deferred.make<void>();
        const router = EventRouter.of({
          open: () =>
            Effect.acquireRelease(
              Effect.succeed({ events: Stream.never, setFilter: () => Effect.void }),
              () => Deferred.succeed(routeClosed, undefined),
            ),
          drain: () => Effect.void,
        });
        const client: TelegramClient = {
          identity: { id: "1", username: "pico_bot" },
          consume: () =>
            Deferred.await(failPoll).pipe(
              Effect.andThen(
                Effect.fail(
                  new TelegramError({
                    message: "Telegram polling conflict",
                    operation: "get-updates",
                    category: "conflict",
                    status: 409,
                  }),
                ),
              ),
            ),
          sendText: () => Effect.void,
          sendGeneral: () => Effect.void,
        };
        yield* startLayer(baseConfig, client, Application.of(applicationBase), router);
        yield* Deferred.succeed(failPoll, undefined);
        yield* Deferred.await(routeClosed);
        assert.isTrue(yield* Deferred.isDone(routeClosed));
      }),
    ),
  );
});
