import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { assert, describe, it } from "@effect/vitest";
import type {
  ContextUsage,
  MessageDelivery,
  ModelInfo,
  ModelSwitchResult,
} from "@pico/contract/agent-runtime";
import { Application, type BindWorkspace } from "@pico/contract/application";
import * as Chat from "@pico/contract/chat-model";
import { ApplicationError, ChatClosed, WorkspaceBindingInvalid } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import type * as Workspace from "@pico/contract/workspace-model";
import {
  ApplicationCommandOptionTypes,
  ButtonStyles,
  ChannelTypes,
  InteractionTypes,
  MessageComponentTypes,
} from "discordeno";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  bindOptions,
  boundWorkspace,
  chatId,
  config,
  defaultCwd,
  handlerFor,
  interaction,
  interactionHandlerFor,
  message,
  modelOptions,
  modelSuggestions,
  privateCommandReply,
  workspaceId,
} from "./discord-input.fixture.ts";
import { type DiscordInputBot, type DiscordInteraction, install } from "./discord-input.ts";

const failingChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000003");

const worktreeOptions = (repository: string, branch: string, prefix: string) => [
  {
    name: "worktree",
    type: ApplicationCommandOptionTypes.SubCommand,
    options: [
      { name: "prefix", type: ApplicationCommandOptionTypes.String, value: prefix },
      { name: "repository", type: ApplicationCommandOptionTypes.String, value: repository },
      { name: "branch", type: ApplicationCommandOptionTypes.String, value: branch },
    ],
  },
];

const installThreadInput = Effect.fn("test.installThreadInput")(function* (options: {
  readonly askBtw?: Application["Service"]["askBtw"];
  readonly sendMessage?: Application["Service"]["sendMessage"];
  readonly closeChat?: Application["Service"]["closeChat"];
  readonly availableModels?: Application["Service"]["availableModels"];
  readonly availableWorkspaceModels?: Application["Service"]["availableWorkspaceModels"];
  readonly setWorkspaceModel?: Application["Service"]["setWorkspaceModel"];
  readonly getOrCreateWorkspaceByBinding?: Application["Service"]["getOrCreateWorkspaceByBinding"];
  readonly switchModel?: Application["Service"]["switchModel"];
  readonly getChannel?: DiscordInputBot["helpers"]["getChannel"];
  readonly editChannel?: DiscordInputBot["helpers"]["editChannel"];
  readonly drainOutput?: () => Effect.Effect<void>;
}) {
  const bot: DiscordInputBot = {
    id: 999n,
    events: {},
    helpers: {
      addReaction: async () => undefined,
      deleteOwnReaction: async () => undefined,
      getChannel:
        options.getChannel ??
        (async (id) => ({
          id,
          guildId: 1n,
          type: id === 10n ? ChannelTypes.GuildText : ChannelTypes.PublicThread,
          parentId: 10n,
        })),
      sendMessage: async () => {
        throw new Error("btw must use its public interaction");
      },
      editChannel:
        options.editChannel ??
        (async () => {
          throw new Error("btw must not archive its thread");
        }),
      startThreadWithoutMessage: async () => {
        throw new Error("unexpected schedule");
      },
      deleteChannel: async () => {
        throw new Error("unexpected schedule cleanup");
      },
      startThreadWithMessage: async () => {
        throw new Error("btw must not create a thread");
      },
    },
  };
  const application = Application.of({
    deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
    updateWorkspace: () => Effect.die("unexpected workspace update"),
    availableWorkspaceModels:
      options.availableWorkspaceModels ??
      (() => Effect.die("unexpected workspace model discovery")),
    setWorkspaceModel:
      options.setWorkspaceModel ?? (() => Effect.die("unexpected workspace model update")),
    availableModels: options.availableModels ?? (() => Effect.die("unexpected model discovery")),
    switchModel: options.switchModel ?? (() => Effect.die("unexpected model switch")),
    listWorkspaces: () => Effect.die("unexpected workspace list"),
    createWorkspace: () => Effect.die("btw must not create a workspace"),
    getOrCreateWorkspaceByBinding:
      options.getOrCreateWorkspaceByBinding ?? (() => Effect.succeed(boundWorkspace)),
    bindWorkspace: () => Effect.die("btw must not bind a workspace"),
    listChats: () => Effect.die("unexpected chat list"),
    createChat: () => Effect.die("btw must not create a chat"),
    findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
    findChatByPlatformId: (_platform, _workspace, thread) =>
      Effect.succeed(
        thread === "20"
          ? Option.some({
              id: chatId,
              workspaceId,
              cwd: defaultCwd,
              externalId: thread,
              createdAt: 0,
              archivedAt: null,
            })
          : Option.none(),
      ),
    findChatPlatformBinding: () => Effect.die("unexpected binding lookup"),
    transcript: () => Effect.die("btw must not read a separate transcript"),
    closeChat: options.closeChat ?? (() => Effect.die("unexpected close")),
    sendMessage: options.sendMessage ?? (() => Effect.die("btw must not send a main prompt")),
    askBtw: options.askBtw ?? (() => Effect.die("unexpected side question")),
    abort: () => Effect.die("btw must not abort the main request"),
    contextUsage: () => Effect.die("unexpected context read"),
    shake: () => Effect.die("unexpected shake"),
  });
  yield* install(bot, config, options.drainOutput).pipe(
    Effect.provideService(Application, application),
    Effect.provide(BunCrypto.layer),
  );
  return bot;
});

describe("discord interactions", () => {
  it.effect(
    "keeps workspace autocomplete read-only and rejects stale selections before clearing",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const longModel = {
            provider: "native",
            id: "long-model-".repeat(20),
            name: "Long model",
          };
          const sentinelLikeModel = {
            provider: "pico:omp-default",
            id: "real-model",
            name: "Real model",
          };
          let models: readonly ModelInfo[] = [
            longModel,
            sentinelLikeModel,
            ...Array.from({ length: 30 }, (_, index) => ({
              provider: "native",
              id: `model-${index}`,
              name: `Model ${index}`,
            })),
          ];
          let workspace: Workspace.Workspace = boundWorkspace;
          let creations = 0;
          let writes = 0;
          let catalogUnavailable = false;
          const bot = yield* installThreadInput({
            availableWorkspaceModels: () =>
              catalogUnavailable
                ? Effect.fail(
                    new ApplicationError({ reason: "operation", message: "Catalog offline" }),
                  )
                : Effect.succeed(models),
            getOrCreateWorkspaceByBinding: () =>
              Effect.sync(() => {
                creations += 1;
                return workspace;
              }),
            setWorkspaceModel: (id, modelOverride) =>
              Effect.sync(() => {
                if (workspace.id !== id) throw new Error("Missing workspace");
                writes += 1;
                workspace = { ...workspace, modelOverride };
                return workspace;
              }),
          });
          const query = (value: string) =>
            modelSuggestions(
              bot,
              interaction({
                channelId: 10n,
                data: { name: "set-workspace-model", options: modelOptions(value, true) },
              }),
            );
          const select = (value: string) =>
            privateCommandReply(
              bot,
              interaction({
                channelId: 10n,
                data: { name: "set-workspace-model", options: modelOptions(value) },
              }),
            );
          const suggestions = yield* query("");
          assert.strictEqual(suggestions.length, 25);
          for (const choice of suggestions) {
            assert.isAtMost(choice.name.length, 100);
            assert.isAtMost(String(choice.value).length, 100);
          }
          const inherited = suggestions.find(({ name }) => name === "Use OMP default");
          const selected = (yield* query("LONG-MODEL"))[0];
          if (inherited === undefined || selected === undefined) {
            return yield* Effect.die("Missing workspace model choices");
          }
          assert.deepStrictEqual(yield* query(" OMP DEFAULT "), [inherited]);
          assert.deepStrictEqual(yield* query("no-match"), []);
          assert.strictEqual(creations, 0);
          assert.strictEqual(writes, 0);
          assert.match(String(selected.value), /^sha256:/);
          const reply = yield* select(String(selected.value));
          assert.match(reply, /Only new chats/i);
          assert.include(reply, "native/long-model-");
          assert.strictEqual(creations, 1);
          assert.deepStrictEqual(workspace.modelOverride, {
            provider: longModel.provider,
            id: longModel.id,
          });
          models = [sentinelLikeModel];
          const beforeInvalid = workspace;
          assert.match(yield* select(String(selected.value)), /unavailable/i);
          assert.strictEqual(workspace, beforeInvalid);
          assert.strictEqual(writes, 1);
          const sentinelLikeChoice = (yield* query("real-model"))[0];
          if (sentinelLikeChoice === undefined)
            return yield* Effect.die("Missing real model choice");
          assert.notStrictEqual(sentinelLikeChoice.value, inherited.value);
          yield* select(String(sentinelLikeChoice.value));
          assert.deepStrictEqual(workspace.modelOverride, {
            provider: sentinelLikeModel.provider,
            id: sentinelLikeModel.id,
          });
          catalogUnavailable = true;
          const cleared = yield* select(String(inherited.value));
          assert.match(cleared, /inherit the OMP default/i);
          assert.match(cleared, /Only new chats/i);
          assert.isNull(workspace.modelOverride);
        }),
      ),
  );

  it.effect("rejects workspace model commands outside configured ordinary text channels", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let mutations = 0;
        let catalogReads = 0;
        const channelTypes = new Map([
          [20n, ChannelTypes.PublicThread],
          [21n, ChannelTypes.PrivateThread],
          [22n, ChannelTypes.AnnouncementThread],
          [23n, ChannelTypes.GuildAnnouncement],
          [24n, ChannelTypes.GuildForum],
          [25n, ChannelTypes.DM],
        ]);
        const bot = yield* installThreadInput({
          getChannel: async (id) => ({
            id,
            guildId: id === 26n ? 2n : 1n,
            type: channelTypes.get(id) ?? ChannelTypes.GuildText,
            parentId: 10n,
          }),
          availableWorkspaceModels: () =>
            Effect.sync(() => {
              catalogReads += 1;
              return [];
            }),
          getOrCreateWorkspaceByBinding: () =>
            Effect.sync(() => {
              mutations += 1;
              return boundWorkspace;
            }),
          setWorkspaceModel: () =>
            Effect.sync(() => {
              mutations += 1;
              return boundWorkspace;
            }),
        });
        const guildless = interaction({ channelId: 10n });
        Reflect.deleteProperty(guildless, "guildId");
        for (const target of [
          guildless,
          interaction({ guildId: 2n, channelId: 10n }),
          ...[20n, 21n, 22n, 23n, 24n, 25n, 26n].map((channelId) => interaction({ channelId })),
        ]) {
          assert.deepStrictEqual(
            yield* modelSuggestions(bot, {
              ...target,
              data: { name: "set-workspace-model", options: modelOptions("", true) },
            }),
            [],
          );
          const reply = yield* privateCommandReply(bot, {
            ...target,
            data: { name: "set-workspace-model", options: modelOptions("native/model") },
          });
          assert.match(reply, /configured server text channel/i);
        }
        assert.strictEqual(catalogReads, 0);
        assert.strictEqual(mutations, 0);
      }),
    ),
  );

  it.effect("ignores guild-less commands and autocomplete before resolving a conversation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const bot = yield* installThreadInput({
          availableModels: () =>
            Effect.sync(() => {
              calls.push("models");
              return [];
            }),
          getChannel: async (id) => {
            calls.push("channel");
            return { id, guildId: 1n, type: ChannelTypes.PublicThread, parentId: 10n };
          },
        });
        const stale = interaction({
          channelId: 20n,
          data: { name: "switch", options: modelOptions("model", true) },
          defer: async () => {
            calls.push("defer");
          },
          edit: async () => {
            calls.push("edit");
          },
          respond: async () => {
            calls.push("respond");
          },
        });
        Reflect.deleteProperty(stale, "guildId");
        const handle = interactionHandlerFor(bot);
        handle(stale);
        handle({ ...stale, type: InteractionTypes.ApplicationCommandAutocomplete });
        yield* Effect.yieldNow;
        assert.deepStrictEqual(calls, []);
      }),
    ),
  );

  it.effect(
    "autocompletes a bound thread outside its input lock and changes only its current chat",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const incoming = yield* Deferred.make<void>();
          const releaseInput = yield* Deferred.make<void>();
          const laterModel = yield* Deferred.make<string>();
          const selected = { provider: "native", id: "thread-model", name: "Thread model" };
          let active = "original";
          const bot = yield* installThreadInput({
            availableModels: (id) => Effect.succeed(id === chatId ? [selected] : []),
            switchModel: (id, model) =>
              Effect.sync(() => {
                if (id !== chatId) throw new Error("wrong chat selected");
                active = `${model.provider}/${model.id}`;
                return { kind: "persisted", model: selected } satisfies ModelSwitchResult;
              }),
            sendMessage: (_id, prompt) =>
              Effect.gen(function* () {
                if (prompt.text === "first") {
                  yield* Deferred.succeed(incoming, undefined);
                  yield* Deferred.await(releaseInput);
                } else {
                  yield* Deferred.succeed(laterModel, active);
                }
                return { kind: "handled" } satisfies MessageDelivery<ApplicationError>;
              }),
          });
          handlerFor(bot)(message({ channelId: 20n, content: "first" }));
          yield* Deferred.await(incoming);
          const suggestions = yield* modelSuggestions(
            bot,
            interaction({
              channelId: 20n,
              data: { name: "switch", options: modelOptions("thread", true) },
            }),
          );
          assert.deepStrictEqual(
            suggestions.map(({ value }) => value),
            ["native/thread-model"],
          );
          yield* Deferred.succeed(releaseInput, undefined);
          const reply = yield* privateCommandReply(
            bot,
            interaction({
              channelId: 20n,
              data: { name: "switch", options: modelOptions("native/thread-model") },
            }),
          );
          assert.include(reply, "native/thread-model");
          handlerFor(bot)(message({ channelId: 20n, content: "later" }));
          assert.strictEqual(yield* Deferred.await(laterModel), "native/thread-model");
        }),
      ),
  );

  it.effect(
    "keeps guild, fetched-channel and persisted-thread restrictions on model discovery and selection",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const model = { provider: "native", id: "model", name: "Model" };
          let catalogReads = 0;
          let switches = 0;
          const bot = yield* installThreadInput({
            getChannel: async (id) =>
              id === 23n
                ? { id, guildId: 1n, type: ChannelTypes.PublicThread }
                : {
                    id,
                    guildId: id === 22n ? 2n : 1n,
                    type: id === 10n ? ChannelTypes.GuildText : ChannelTypes.PublicThread,
                    parentId: 10n,
                  },
            availableModels: () =>
              Effect.sync(() => {
                catalogReads += 1;
                return [model];
              }),
            switchModel: () =>
              Effect.sync(() => {
                switches += 1;
                return { kind: "persisted", model } satisfies ModelSwitchResult;
              }),
          });
          yield* modelSuggestions(
            bot,
            interaction({
              channelId: 20n,
              data: { name: "switch", options: modelOptions("", true) },
            }),
          );
          for (const target of [
            { guildId: 2n, channelId: 20n },
            { guildId: 1n, channelId: 10n },
            { guildId: 1n, channelId: 21n },
            { guildId: 1n, channelId: 22n },
            { guildId: 1n, channelId: 23n },
          ]) {
            assert.deepStrictEqual(
              yield* modelSuggestions(
                bot,
                interaction({
                  ...target,
                  data: { name: "switch", options: modelOptions("", true) },
                }),
              ),
              [],
            );
            yield* privateCommandReply(
              bot,
              interaction({
                ...target,
                data: { name: "switch", options: modelOptions("native/model") },
              }),
            );
          }
          assert.strictEqual(catalogReads, 1);
          assert.strictEqual(switches, 0);
        }),
      ),
  );

  it.effect("privately confirms a thread switch when saving its selection is unconfirmed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const model = {
          provider: "private-provider-selection",
          id: "thread-model",
          name: "Chosen",
        };
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const bot = yield* installThreadInput({
          availableModels: () => Effect.succeed([model]),
          switchModel: () => Effect.succeed({ kind: "persistence-unconfirmed", model }),
        }).pipe(
          Effect.provide(
            Logger.layer([
              Logger.make((options) => {
                logs.push(Logger.formatStructured.log(options));
              }),
            ]),
          ),
        );
        const reply = yield* privateCommandReply(
          bot,
          interaction({
            channelId: 20n,
            data: {
              name: "switch",
              options: modelOptions("private-provider-selection/thread-model"),
            },
          }),
        );
        assert.match(reply, /Switched.*private-provider-selection\/thread-model/);
        assert.match(reply, /saving.*could not be confirmed/i);
        assert.match(reply, /restart may lose/i);
        assert.notInclude(reply, "could not switch");
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]?.level, "WARN");
        assert.strictEqual(logs[0]?.annotations.operation, "persist-model-selection");
        assert.notInclude(JSON.stringify(logs), model.provider);
      }),
    ),
  );

  it.effect(
    "privately reports rejected and closed thread switches without exposing native failures",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const model = { provider: "native", id: "model", name: "Model" };
          let closed = false;
          const bot = yield* installThreadInput({
            availableModels: () => Effect.succeed([model]),
            switchModel: () =>
              closed
                ? Effect.fail(new ChatClosed())
                : Effect.fail(
                    new ApplicationError({ reason: "invalid-state", message: "secret-provider" }),
                  ),
          });
          const command = interaction({
            channelId: 20n,
            data: { name: "switch", options: modelOptions("native/model") },
          });
          const busyReply = yield* privateCommandReply(bot, command);
          assert.include(busyReply, "could not switch");
          assert.notInclude(busyReply, "secret-provider");
          assert.notInclude(busyReply, "native/model");
          closed = true;
          const closedReply = yield* privateCommandReply(bot, command);
          assert.notInclude(closedReply, "native/model");
          assert.notStrictEqual(closedReply, busyReply);
        }),
      ),
  );

  it.effect("keeps long side questions and answers public while normal input continues", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mainStarted = yield* Deferred.make<void>();
        const mainFinished = yield* Deferred.make<void>();
        const sideStarted = yield* Deferred.make<void>();
        const sideFinished = yield* Deferred.make<string>();
        const laterSent = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        const question = `Why ${"x".repeat(2_200)}?`;
        const answer = `${"Answer ".repeat(700)}last-answer-marker`;
        const publicMessages: Array<{ kind: "edit" | "followup"; content: string }> = [];
        let deferred = false;
        const bot = yield* installThreadInput({
          sendMessage: (_id, prompt) =>
            Deferred.succeed(prompt.text === "main" ? mainStarted : laterSent, undefined).pipe(
              Effect.as({ kind: "started", completed: Deferred.await(mainFinished) }),
            ),
          askBtw: () =>
            Deferred.succeed(sideStarted, undefined).pipe(
              Effect.andThen(Deferred.await(sideFinished)),
            ),
        });
        const receive = async (
          kind: "edit" | "followup",
          response: Parameters<DiscordInteraction["edit"]>[0],
        ) => {
          assert.deepStrictEqual(response.allowedMentions, { parse: [], repliedUser: false });
          assert.isUndefined(response.flags);
          const content = response.content ?? "";
          assert.isAtMost(content.length, 2_000);
          publicMessages.push({ kind, content });
          if (content.includes("last-answer-marker")) {
            Effect.runSync(Deferred.succeed(delivered, undefined));
          }
        };
        handlerFor(bot)(message({ channelId: 20n, content: "main" }));
        yield* Deferred.await(mainStarted);
        interactionHandlerFor(bot)(
          interaction({
            channelId: 20n,
            data: {
              name: "btw",
              options: [
                {
                  name: "question",
                  type: ApplicationCommandOptionTypes.String,
                  value: ` ${question} `,
                },
              ],
            },
            defer: async (isPrivate) => {
              assert.isFalse(isPrivate);
              deferred = true;
            },
            edit: (response) => receive("edit", response),
            respond: (response) => receive("followup", response),
          }),
        );
        yield* Deferred.await(sideStarted);
        assert.isTrue(deferred);
        assert.isFalse(yield* Deferred.isDone(mainFinished));
        handlerFor(bot)(message({ channelId: 20n, content: "later" }));
        yield* Deferred.await(laterSent);
        yield* Deferred.succeed(sideFinished, answer);
        yield* Deferred.await(delivered);
        assert.strictEqual(publicMessages[0]?.kind, "edit");
        assert.isTrue(publicMessages.slice(1).every(({ kind }) => kind === "followup"));
        yield* Deferred.succeed(mainFinished, undefined);
      }),
    ),
  );

  it.effect("drains successful and cancelled side replies before archiving their thread", () =>
    Effect.gen(function* () {
      for (const outcome of ["answer", "cancelled"] as const) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const asked = yield* Deferred.make<void>();
            const cancelled = yield* Deferred.make<void>();
            const replyStarted = yield* Deferred.make<void>();
            const draining = yield* Deferred.make<void>();
            const closeReplied = yield* Deferred.make<void>();
            const releaseReply = Promise.withResolvers<void>();
            const question = outcome === "answer" ? `Explain ${"x".repeat(2_200)}` : "Explain this";
            const answer = "The complete answer.";
            const order: string[] = [];
            const bot = yield* installThreadInput({
              askBtw: () =>
                Deferred.succeed(asked, undefined).pipe(
                  Effect.andThen(
                    outcome === "answer"
                      ? Effect.succeed(answer)
                      : Deferred.await(cancelled).pipe(Effect.andThen(Effect.interrupt)),
                  ),
                ),
              closeChat: () =>
                Deferred.succeed(cancelled, undefined).pipe(Effect.as({ kind: "closed" })),
              drainOutput: () => Deferred.succeed(draining, undefined).pipe(Effect.asVoid),
              editChannel: async () => {
                order.push("archive");
              },
            });
            const receive = async (response: Parameters<DiscordInteraction["edit"]>[0]) => {
              const content = response.content ?? "";
              if (outcome === "cancelled" || content.includes(answer)) {
                Effect.runSync(Deferred.succeed(replyStarted, undefined));
                await releaseReply.promise;
              }
              order.push("public-reply");
            };
            yield* Effect.gen(function* () {
              interactionHandlerFor(bot)(
                interaction({
                  channelId: 20n,
                  data: {
                    name: "btw",
                    options: [
                      {
                        name: "question",
                        type: ApplicationCommandOptionTypes.String,
                        value: question,
                      },
                    ],
                  },
                  edit: receive,
                  respond: receive,
                }),
              );
              yield* Deferred.await(asked);
              if (outcome === "answer") yield* Deferred.await(replyStarted);
              interactionHandlerFor(bot)(
                interaction({
                  channelId: 20n,
                  data: { name: "close" },
                  edit: async () => {
                    Effect.runSync(Deferred.succeed(closeReplied, undefined));
                  },
                }),
              );
              yield* Deferred.await(draining);
              yield* Deferred.await(replyStarted);
              assert.notInclude(order, "archive");
              releaseReply.resolve();
              yield* Deferred.await(closeReplied);
              assert.strictEqual(order.at(-1), "archive");
            }).pipe(Effect.ensuring(Effect.sync(() => releaseReply.resolve())));
          }),
        );
      }
    }),
  );

  it.effect("drains side replies accepted before their Discord deferral completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const deferStarted = yield* Deferred.make<void>();
        const draining = yield* Deferred.make<void>();
        const sideReplied = yield* Deferred.make<void>();
        const closeReplied = yield* Deferred.make<void>();
        const releaseDefer = Promise.withResolvers<void>();
        const order: string[] = [];
        const bot = yield* installThreadInput({
          askBtw: () => Effect.fail(new ChatClosed()),
          closeChat: () =>
            Effect.sync(() => {
              order.push("close");
              return { kind: "closed" } as const;
            }),
          drainOutput: () => Deferred.succeed(draining, undefined).pipe(Effect.asVoid),
          editChannel: async () => {
            order.push("archive");
          },
        });
        yield* Effect.gen(function* () {
          interactionHandlerFor(bot)(
            interaction({
              channelId: 20n,
              data: {
                name: "btw",
                options: [
                  {
                    name: "question",
                    type: ApplicationCommandOptionTypes.String,
                    value: "Explain this",
                  },
                ],
              },
              defer: async () => {
                Effect.runSync(Deferred.succeed(deferStarted, undefined));
                await releaseDefer.promise;
              },
              edit: async (response) => {
                assert.include(response.content ?? "", "closed");
                order.push("public-reply");
                Effect.runSync(Deferred.succeed(sideReplied, undefined));
              },
            }),
          );
          yield* Deferred.await(deferStarted);
          interactionHandlerFor(bot)(
            interaction({
              channelId: 20n,
              data: { name: "close" },
              edit: async () => {
                Effect.runSync(Deferred.succeed(closeReplied, undefined));
              },
            }),
          );
          yield* Deferred.await(draining);
          releaseDefer.resolve();
          yield* Deferred.await(sideReplied);
          yield* Deferred.await(closeReplied);
          assert.deepStrictEqual(order, ["close", "public-reply", "archive"]);
        }).pipe(Effect.ensuring(Effect.sync(() => releaseDefer.resolve())));
      }),
    ),
  );

  it.effect("rejects late side questions privately while thread archival is in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const archiveStarted = yield* Deferred.make<void>();
        const sideDeferred = yield* Deferred.make<void>();
        const sideReplied = yield* Deferred.make<string>();
        const closeReplied = yield* Deferred.make<void>();
        const releaseArchive = Promise.withResolvers<void>();
        const releaseDefer = Promise.withResolvers<void>();
        const deferrals: boolean[] = [];
        const publicFollowups: string[] = [];
        let asked = 0;
        const bot = yield* installThreadInput({
          askBtw: () =>
            Effect.sync(() => {
              asked += 1;
              return "Unexpected answer.";
            }),
          closeChat: () => Effect.succeed({ kind: "closed" }),
          editChannel: async () => {
            Effect.runSync(Deferred.succeed(archiveStarted, undefined));
            await releaseArchive.promise;
          },
        });
        yield* Effect.gen(function* () {
          interactionHandlerFor(bot)(
            interaction({
              channelId: 20n,
              data: { name: "close" },
              edit: async () => {
                Effect.runSync(Deferred.succeed(closeReplied, undefined));
              },
            }),
          );
          yield* Deferred.await(archiveStarted);
          interactionHandlerFor(bot)(
            interaction({
              channelId: 20n,
              data: {
                name: "btw",
                options: [
                  {
                    name: "question",
                    type: ApplicationCommandOptionTypes.String,
                    value: "Explain this",
                  },
                ],
              },
              defer: async (isPrivate) => {
                deferrals.push(isPrivate === true);
                Effect.runSync(Deferred.succeed(sideDeferred, undefined));
                await releaseDefer.promise;
              },
              edit: async (response) => {
                Effect.runSync(Deferred.succeed(sideReplied, response.content ?? ""));
              },
              respond: async (response) => {
                publicFollowups.push(response.content ?? "");
              },
            }),
          );
          yield* Deferred.await(sideDeferred);
          releaseArchive.resolve();
          yield* Deferred.await(closeReplied);
          releaseDefer.resolve();
          const reply = yield* Deferred.await(sideReplied);
          assert.deepStrictEqual(deferrals, [true]);
          assert.strictEqual(asked, 0);
          assert.include(reply, "closed");
          assert.notInclude(reply, "/btw");
          assert.deepStrictEqual(publicFollowups, []);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              releaseArchive.resolve();
              releaseDefer.resolve();
            }),
          ),
        );
      }),
    ),
  );

  it.effect(
    "terminates cancelled, timed out, and failed side replies without losing the question",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const waiting = yield* Deferred.make<void>();
          const cancelled = yield* Deferred.make<void>();
          const releaseCleanup = yield* Deferred.make<void>();
          const settled = yield* Deferred.make<void>();
          const archived = yield* Deferred.make<void>();
          const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
          const bot = yield* installThreadInput({
            askBtw: (_id, question) => {
              if (question === "cancel") return Effect.interrupt;
              if (question === "closed") return Effect.fail(new ChatClosed());
              if (question === "timeout")
                return Deferred.succeed(waiting, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Deferred.succeed(cancelled, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseCleanup)),
                      Effect.andThen(Deferred.succeed(settled, undefined)),
                    ),
                  ),
                );
              return Effect.die(new Error("private-provider-payload"));
            },
            closeChat: () => Effect.succeed({ kind: "closed" }),
            editChannel: async () => {
              Effect.runSync(Deferred.succeed(archived, undefined));
            },
          }).pipe(
            Effect.provide(
              Logger.layer([
                Logger.make((options) => {
                  logs.push(Logger.formatStructured.log(options));
                }),
              ]),
            ),
          );
          const invoke = (question: string) =>
            new Promise<string>((resolve) => {
              interactionHandlerFor(bot)(
                interaction({
                  channelId: 20n,
                  data: {
                    name: "btw",
                    options: [
                      {
                        name: "question",
                        type: ApplicationCommandOptionTypes.String,
                        value: question,
                      },
                    ],
                  },
                  defer: async (isPrivate) => {
                    assert.isFalse(isPrivate);
                  },
                  edit: async (response) => {
                    resolve(response.content ?? "");
                  },
                }),
              );
            });
          for (const question of ["cancel", "closed", "fail"]) {
            const reply = yield* Effect.promise(() => invoke(question));
            assert.isFalse(reply.includes("private-provider-payload"));
          }
          yield* Effect.gen(function* () {
            const timedOut = invoke("timeout");
            yield* Deferred.await(waiting);
            yield* TestClock.adjust("10 minutes");
            const reply = yield* Effect.promise(() => timedOut);
            assert.include(reply, "timed out");
            yield* Deferred.await(cancelled);
            interactionHandlerFor(bot)(interaction({ channelId: 20n, data: { name: "close" } }));
            yield* Deferred.await(archived);
            assert.isFalse(yield* Deferred.isDone(settled));
            yield* Deferred.succeed(releaseCleanup, undefined);
            yield* Deferred.await(settled);
            assert.isFalse(JSON.stringify(logs).includes("private-provider-payload"));
          }).pipe(Effect.ensuring(Deferred.succeed(releaseCleanup, undefined)));
        }),
      ),
  );

  it.effect("rejects side questions outside existing Pico threads without creating chats", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let asked = false;
        const bot = yield* installThreadInput({
          askBtw: () =>
            Effect.sync(() => {
              asked = true;
              return "unexpected answer";
            }),
        });
        for (const [channelId, guildId, question] of [
          [10n, 1n, "channel question"],
          [21n, 1n, "unbound thread question"],
          [20n, 2n, "other guild question"],
          [20n, 1n, " \n "],
        ] as const) {
          const reply = yield* Effect.promise(
            () =>
              new Promise<string>((resolve) => {
                interactionHandlerFor(bot)(
                  interaction({
                    channelId,
                    guildId,
                    data: {
                      name: "btw",
                      options: [
                        {
                          name: "question",
                          type: ApplicationCommandOptionTypes.String,
                          value: question,
                        },
                      ],
                    },
                    edit: async (response) => {
                      resolve(response.content ?? "");
                    },
                  }),
                );
              }),
          );
          assert.notInclude(reply, "unexpected answer");
        }
        assert.isFalse(asked);
      }),
    ),
  );

  it.effect("defers and completes bind interactions under guild and channel policy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bindings: Array<BindWorkspace> = [];
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async (channelId: bigint) => {
              switch (channelId) {
                case 10n:
                  return {
                    id: channelId,
                    guildId: 1n,
                    type: ChannelTypes.GuildText,
                    name: "general",
                  };
                case 20n:
                  return {
                    id: channelId,
                    guildId: 1n,
                    type: ChannelTypes.PublicThread,
                    parentId: 10n,
                    name: "thread",
                  };
                case 30n:
                  return {
                    id: channelId,
                    guildId: 2n,
                    type: ChannelTypes.GuildText,
                    name: "foreign",
                  };
                default:
                  return {
                    id: channelId,
                    guildId: 1n,
                    type: ChannelTypes.GuildVoice,
                    name: "voice",
                  };
              }
            },
            sendMessage: async () => undefined,
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => ({ id: 50n }),
          },
        } satisfies DiscordInputBot;
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
          getOrCreateWorkspaceByBinding: () => Effect.die("unexpected workspace creation"),
          bindWorkspace: (input) => {
            bindings.push(input);
            if (input.configuration.kind === "direct") {
              if (input.configuration.cwd === "/missing") {
                return Effect.fail(
                  new WorkspaceBindingInvalid({ issue: { field: "cwd", reason: "not-found" } }),
                );
              }
              return Effect.succeed({
                id: workspaceId,
                name: "general",
                ...input.binding,
                defaultCwd: AbsolutePath.make(input.configuration.cwd),
                worktree: null,
                modelOverride: null,
                createdAt: 0,
              });
            }
            if (input.configuration.repository === "/not-git") {
              return Effect.fail(
                new WorkspaceBindingInvalid({
                  issue: { field: "repository", reason: "not-repository" },
                }),
              );
            }
            if (input.configuration.settings.branch === "missing") {
              return Effect.fail(
                new WorkspaceBindingInvalid({ issue: { field: "branch", reason: "not-commit" } }),
              );
            }
            if (input.configuration.settings.prefix === "bad") {
              return Effect.fail(
                new WorkspaceBindingInvalid({ issue: { field: "prefix", reason: "invalid-ref" } }),
              );
            }
            return Effect.succeed({
              id: workspaceId,
              name: "general",
              ...input.binding,
              defaultCwd: AbsolutePath.make(input.configuration.repository),
              worktree: input.configuration.settings,
              modelOverride: null,
              createdAt: 0,
            });
          },
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () => Effect.die("unexpected chat lookup"),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("unexpected message send"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
        });

        yield* install(bot, config).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        const handleInteraction = interactionHandlerFor(bot);
        const invoke = (overrides: Partial<DiscordInteraction> = {}, omittedId?: "channelId") =>
          new Promise<string>((resolve) => {
            const candidate = interaction({
              defer: async (isPrivate) => {
                assert.isTrue(isPrivate);
              },
              edit: async (options) => {
                assert.deepStrictEqual(options.allowedMentions, {
                  parse: [],
                  repliedUser: false,
                });
                resolve(options.content ?? "");
              },
              ...overrides,
            });
            if (omittedId !== undefined) Reflect.deleteProperty(candidate, omittedId);
            handleInteraction(candidate);
          });

        const policyCopy = "This command can only be used in a configured server text channel.";
        assert.strictEqual(yield* Effect.promise(() => invoke({}, "channelId")), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke({ guildId: 2n })), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke({ channelId: 30n })), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke({ channelId: 20n })), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke({ channelId: 40n })), policyCopy);
        assert.deepStrictEqual(bindings, []);

        assert.strictEqual(
          yield* Effect.promise(() => invoke({ data: { name: "bind", options: [] } })),
          "Use /bind set with cwd, or /bind worktree with repository, branch, and prefix.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({ data: { name: "bind", options: bindOptions("/missing") } }),
          ),
          "That working directory does not exist.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({ data: { name: "bind", options: bindOptions("/repo") } }),
          ),
          "Workspace binding updated to /repo. Worktrees are disabled for new chats.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({
              data: { name: "bind", options: worktreeOptions("/not-git", "main", "chat/") },
            }),
          ),
          "That path is not a Git repository.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({
              data: { name: "bind", options: worktreeOptions("/repo", "missing", "chat/") },
            }),
          ),
          "The branch must resolve to a commit in that repository.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({
              data: { name: "bind", options: worktreeOptions("/repo", "main", "bad") },
            }),
          ),
          "The prefix cannot form valid Git branch names.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke({
              data: { name: "bind", options: worktreeOptions("/repo", "main", "chat/") },
            }),
          ),
          "Workspace worktrees configured from /repo. This affects new chats only.",
        );

        let ignoredDefers = 0;
        handleInteraction(
          interaction({
            type: InteractionTypes.Ping,
            defer: async () => {
              ignoredDefers += 1;
            },
          }),
        );
        handleInteraction(
          interaction({
            data: { name: "other", options: bindOptions("/repo") },
            defer: async () => {
              ignoredDefers += 1;
            },
          }),
        );
        assert.strictEqual(ignoredDefers, 0);
      }),
    ),
  );

  it.effect("resolves persisted shake chats and returns private mode-specific responses", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shakes: Array<[Chat.ChatId, string]> = [];
        let privateDefers = 0;
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async (channelId: bigint) => {
              if (channelId === 10n) {
                return { id: channelId, guildId: 1n, type: ChannelTypes.GuildText };
              }
              if (channelId === 30n) {
                return {
                  id: channelId,
                  guildId: 2n,
                  type: ChannelTypes.PublicThread,
                  parentId: 10n,
                };
              }
              return {
                id: channelId,
                guildId: 1n,
                type: ChannelTypes.PublicThread,
                parentId: 10n,
              };
            },
            sendMessage: async () => {
              throw new Error("shake must not use Discord sendMessage");
            },
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("shake must not create a thread");
            },
          },
        } satisfies DiscordInputBot;
        const chat: Chat.Chat = {
          id: chatId,
          workspaceId,
          cwd: defaultCwd,
          externalId: "20",
          createdAt: 0,
          archivedAt: null,
        };
        const failedChat = { ...chat, id: failingChatId, externalId: "22" };
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
          getOrCreateWorkspaceByBinding: () => Effect.succeed(boundWorkspace),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("shake must not create a chat"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: (_platform, _workspaceExternalId, threadId) =>
            Effect.sync(() => {
              if (threadId === "20") return Option.some(chat);
              if (threadId === "22") return Option.some(failedChat);
              return Option.none();
            }),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("shake must not use application.sendMessage"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: (requestedChatId, mode) => {
            shakes.push([requestedChatId, mode]);
            if (requestedChatId === failingChatId) {
              return Effect.fail(
                new ApplicationError({ reason: "operation", message: "shake failed" }),
              );
            }
            switch (mode) {
              case "elide":
                return Effect.succeed({
                  mode,
                  toolResultsDropped: 2,
                  blocksDropped: 1,
                  tokensFreed: 300,
                });
              case "images":
                return Effect.succeed({ mode, imagesDropped: 4, tokensFreed: 0 });
              case "thinking":
                return Effect.succeed({ mode, thinkingBlocksDropped: 3, tokensFreed: 125 });
              default: {
                const exhaustive: never = mode;
                return exhaustive;
              }
            }
          },
          closeChat: () => Effect.die("unexpected chat close"),
        });

        yield* install(bot, config).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        const handleInteraction = interactionHandlerFor(bot);
        const invoke = (
          channelId: bigint,
          options?: NonNullable<DiscordInteraction["data"]>["options"],
        ) =>
          new Promise<string>((resolve) => {
            handleInteraction(
              interaction({
                channelId,
                data: options === undefined ? { name: "shake" } : { name: "shake", options },
                defer: async (isPrivate) => {
                  assert.isTrue(isPrivate);
                  privateDefers += 1;
                },
                edit: async (response) => {
                  assert.deepStrictEqual(response.allowedMentions, {
                    parse: [],
                    repliedUser: false,
                  });
                  resolve(response.content ?? "");
                },
              }),
            );
          });

        assert.strictEqual(
          yield* Effect.promise(() => invoke(20n)),
          "Shook 2 tool results + 1 block (~300 tokens freed).",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke(20n, [
              { name: "mode", type: ApplicationCommandOptionTypes.String, value: "images" },
            ]),
          ),
          "Dropped 4 images from this chat.",
        );
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke(20n, [
              { name: "mode", type: ApplicationCommandOptionTypes.String, value: "thinking" },
            ]),
          ),
          "Dropped 3 thinking blocks from this chat.",
        );
        assert.deepStrictEqual(shakes, [
          [chatId, "elide"],
          [chatId, "images"],
          [chatId, "thinking"],
        ]);

        const policyCopy = "This command can only be used in a pico-owned Discord thread.";
        assert.strictEqual(yield* Effect.promise(() => invoke(10n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(21n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(30n)), policyCopy);
        assert.strictEqual(
          yield* Effect.promise(() =>
            invoke(20n, [
              { name: "mode", type: ApplicationCommandOptionTypes.Integer, value: "elide" },
            ]),
          ),
          "The /shake command accepts one mode: elide, images, or thinking.",
        );
        assert.strictEqual(
          yield* Effect.promise(() => invoke(22n)),
          "pico could not shake this chat.",
        );
        assert.strictEqual(privateDefers, 8);
        assert.deepStrictEqual(shakes, [
          [chatId, "elide"],
          [chatId, "images"],
          [chatId, "thinking"],
          [failingChatId, "elide"],
        ]);
      }),
    ),
  );

  it.effect("reads persisted context privately and caches the resolved chat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unavailableChatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000004");
        const contextReads: Array<Chat.ChatId> = [];
        let privateDefers = 0;
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async (channelId: bigint) => {
              if (channelId === 10n) {
                return { id: channelId, guildId: 1n, type: ChannelTypes.GuildText };
              }
              if (channelId === 30n) {
                return {
                  id: channelId,
                  guildId: 2n,
                  type: ChannelTypes.PublicThread,
                  parentId: 10n,
                };
              }
              if (channelId === 31n) {
                return { id: channelId, guildId: 1n, type: ChannelTypes.PublicThread };
              }
              return {
                id: channelId,
                guildId: 1n,
                type: ChannelTypes.PublicThread,
                parentId: 10n,
              };
            },
            sendMessage: async () => {
              throw new Error("context must not use Discord sendMessage");
            },
            editChannel: async () => undefined,
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("context must not create a thread");
            },
          },
        } satisfies DiscordInputBot;
        const chat = (id: Chat.ChatId, externalId: string): Chat.Chat => ({
          id,
          workspaceId,
          cwd: defaultCwd,
          externalId,
          createdAt: 0,
          archivedAt: null,
        });
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
          getOrCreateWorkspaceByBinding: () => Effect.succeed(boundWorkspace),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("context must not create a chat"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: (_platform, _workspaceExternalId, threadId) =>
            Effect.sync(() => {
              if (threadId === "20") return Option.some(chat(chatId, threadId));
              if (threadId === "22") return Option.some(chat(failingChatId, threadId));
              if (threadId === "23") return Option.some(chat(unavailableChatId, threadId));
              return Option.none();
            }),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("context must not use application.sendMessage"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: (requestedChatId) => {
            contextReads.push(requestedChatId);
            if (requestedChatId === failingChatId) {
              return Effect.fail(
                new ApplicationError({ reason: "operation", message: "context failed" }),
              );
            }
            if (requestedChatId === unavailableChatId) {
              return Effect.succeed<ContextUsage>({ kind: "unavailable" });
            }
            return Effect.succeed<ContextUsage>({
              kind: "available",
              contextWindow: 200_000,
              usedTokens: 12_345,
              systemPromptTokens: 1_000,
              systemToolsTokens: 0,
              systemContextTokens: 3_000,
              skillsTokens: 0,
              messagesTokens: 8_345,
            });
          },
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
        });

        yield* install(bot, config).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
        );
        const handleInteraction = interactionHandlerFor(bot);
        const invoke = (channelId: bigint, guildId = 1n) =>
          new Promise<string>((resolve) => {
            handleInteraction(
              interaction({
                guildId,
                channelId,
                data: { name: "context" },
                defer: async (isPrivate) => {
                  assert.isTrue(isPrivate);
                  privateDefers += 1;
                },
                edit: async (response) => {
                  assert.deepStrictEqual(response.allowedMentions, {
                    parse: [],
                    repliedUser: false,
                  });
                  resolve(response.content ?? "");
                },
              }),
            );
          });

        const availableCopy = [
          "Context: 12,345 / 200,000 tokens (6% used)",
          "System prompt: 1,000 tokens",
          "System context: 3,000 tokens",
          "Messages: 8,345 tokens",
        ].join("\n");
        const firstAvailable = yield* Effect.promise(() => invoke(20n));
        assert.strictEqual(firstAvailable, availableCopy);
        assert.isBelow(firstAvailable.length, 2_000);
        assert.strictEqual(yield* Effect.promise(() => invoke(20n)), availableCopy);
        assert.strictEqual(
          yield* Effect.promise(() => invoke(23n)),
          "Context usage is unavailable for this chat.",
        );

        const policyCopy = "This command can only be used in a pico-owned Discord thread.";
        assert.strictEqual(yield* Effect.promise(() => invoke(10n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(21n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(30n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(31n)), policyCopy);
        assert.strictEqual(yield* Effect.promise(() => invoke(20n, 2n)), policyCopy);
        assert.strictEqual(
          yield* Effect.promise(() => invoke(22n)),
          "pico could not read this chat's context.",
        );
        assert.deepStrictEqual(contextReads, [chatId, chatId, unavailableChatId, failingChatId]);
        assert.strictEqual(privateDefers, 9);
      }),
    ),
  );

  it.effect("rejects unbound aborts and replies privately without exposing failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secret = "private-abort-error";
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const logger = Logger.make((options) => {
          logs.push(Logger.formatStructured.log(options));
        });
        let aborts = 0;
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async (channelId: bigint) => {
              if (channelId === 32n) throw { status: 503, body: secret };
              return {
                id: channelId,
                guildId: channelId === 30n ? 2n : 1n,
                type: channelId === 10n ? ChannelTypes.GuildText : ChannelTypes.PublicThread,
                ...(channelId === 31n ? {} : { parentId: 10n }),
              };
            },
            sendMessage: async () => {
              throw new Error("abort must not send a public reply");
            },
            editChannel: async () => {
              throw new Error("abort must not archive the thread");
            },
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("abort must not create a thread");
            },
          },
        } satisfies DiscordInputBot;
        const application = Application.of({
          deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
          updateWorkspace: () => Effect.die("unexpected workspace update"),
          availableWorkspaceModels: () => Effect.die("unexpected workspace model discovery"),
          setWorkspaceModel: () => Effect.die("unexpected workspace model update"),
          availableModels: () => Effect.die("unexpected model discovery"),
          switchModel: () => Effect.die("unexpected model switch"),
          askBtw: () => Effect.die("unexpected side question"),
          listWorkspaces: () => Effect.die("unexpected workspace list"),
          createWorkspace: () => Effect.die("unexpected workspace creation"),
          getOrCreateWorkspaceByBinding: () => Effect.succeed(boundWorkspace),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: (_platform, _parentId, threadId) =>
            Effect.succeed(
              threadId === "21"
                ? Option.none()
                : Option.some({
                    id: threadId === "22" ? failingChatId : chatId,
                    workspaceId,
                    cwd: defaultCwd,
                    externalId: threadId,
                    createdAt: 0,
                    archivedAt: null,
                  }),
            ),
          findChatPlatformBinding: () => Effect.die("unexpected binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          sendMessage: () => Effect.die("unexpected message send"),
          abort: (id) =>
            id === failingChatId
              ? Effect.fail(
                  new ApplicationError({ reason: "operation", message: "Failed to abort chat" }),
                )
              : Effect.sync(() => {
                  aborts += 1;
                }),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
          closeChat: () => Effect.die("unexpected chat close"),
        });
        yield* install(bot, config).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
          Effect.provide(Logger.layer([logger])),
        );
        const handleInteraction = interactionHandlerFor(bot);
        const invoke = (channelId: bigint, guildId = 1n) =>
          new Promise<string>((resolve) => {
            handleInteraction(
              interaction({
                channelId,
                guildId,
                data: { name: "abort" },
                defer: async (isPrivate) => {
                  assert.isTrue(isPrivate);
                },
                edit: async (response) => {
                  assert.deepStrictEqual(response.allowedMentions, {
                    parse: [],
                    repliedUser: false,
                  });
                  resolve(response.content ?? "");
                },
              }),
            );
          });

        const unboundReply = yield* Effect.promise(() => invoke(21n));
        for (const [channelId, guildId] of [
          [20n, 2n],
          [30n, 1n],
          [10n, 1n],
          [31n, 1n],
        ] as const) {
          assert.strictEqual(yield* Effect.promise(() => invoke(channelId, guildId)), unboundReply);
        }
        assert.strictEqual(aborts, 0);
        assert.deepStrictEqual(logs, []);

        const applicationFailure = yield* Effect.promise(() => invoke(22n));
        const discordFailure = yield* Effect.promise(() => invoke(32n));
        assert.strictEqual(applicationFailure, discordFailure);
        assert.notStrictEqual(applicationFailure, unboundReply);
        assert.notInclude(applicationFailure, secret);
        assert.notInclude(applicationFailure, "Failed to abort chat");
        assert.notInclude(JSON.stringify(logs), secret);
        assert.deepStrictEqual(
          logs.map((entry) => entry.annotations.phase),
          ["abort-chat", "resolve-interaction-channel"],
        );
        assert.strictEqual(aborts, 0);

        const successReply = yield* Effect.promise(() => invoke(20n));
        assert.notStrictEqual(successReply, unboundReply);
        assert.notStrictEqual(successReply, applicationFailure);
        assert.strictEqual(aborts, 1);
      }),
    ),
  );

  it.effect("authorizes destructive close and archives only after core success", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const order: Array<string> = [];
        const sent: Array<string> = [];
        const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
        const logger = Logger.make((options) => logs.push(Logger.formatStructured.log(options)));
        let failChannelLookup = false;
        let resolveSent: (() => void) | undefined;
        const delivered = new Promise<void>((resolve) => {
          resolveSent = resolve;
        });
        const drainStarted = yield* Deferred.make<void>();
        const releaseDrain = yield* Deferred.make<void>();
        let componentDeferrals = 0;
        let closed = false;
        const bot = {
          id: 999n,
          events: {},
          helpers: {
            addReaction: async () => undefined,
            deleteOwnReaction: async () => undefined,
            getChannel: async () => {
              if (failChannelLookup) throw { status: 403, body: '{"code":50013}' };
              return {
                id: 20n,
                guildId: 1n,
                type: ChannelTypes.PublicThread,
                parentId: 10n,
              };
            },
            sendMessage: async (_channelId, options) => {
              sent.push(options.content);
              resolveSent?.();
            },
            editChannel: async (_channelId, options) => {
              assert.deepStrictEqual(options, { archived: true, locked: true });
              order.push("archive-thread");
            },
            startThreadWithoutMessage: async () => {
              throw new Error("unexpected schedule");
            },
            deleteChannel: async () => {
              throw new Error("unexpected schedule cleanup");
            },
            startThreadWithMessage: async () => {
              throw new Error("close must not create a thread");
            },
          },
        } satisfies DiscordInputBot;
        const chat: Chat.Chat = {
          id: chatId,
          workspaceId,
          cwd: defaultCwd,
          externalId: "20",
          createdAt: 0,
          archivedAt: null,
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
          getOrCreateWorkspaceByBinding: () => Effect.succeed(boundWorkspace),
          bindWorkspace: () => Effect.die("unexpected workspace binding"),
          listChats: () => Effect.die("unexpected chat list"),
          createChat: () => Effect.die("unexpected chat creation"),
          findWorkspaceByPlatformId: () => Effect.die("unexpected workspace lookup"),
          findChatByPlatformId: () => Effect.succeed(Option.some(chat)),
          findChatPlatformBinding: () => Effect.die("unexpected chat binding lookup"),
          transcript: () => Effect.die("unexpected transcript read"),
          closeChat: (_id, options) =>
            Effect.sync(() => {
              order.push(options.allowDirtyWorktree ? "core-force" : "core-safe");
              if (options.allowDirtyWorktree) {
                closed = true;
                return { kind: "closed" };
              }
              return { kind: "worktree-confirmation-required" };
            }),
          sendMessage: () =>
            closed ? Effect.fail(new ChatClosed()) : Effect.die("unexpected open message"),
          abort: () => Effect.die("unexpected chat abort"),
          contextUsage: () => Effect.die("unexpected context read"),
          shake: () => Effect.die("unexpected chat shake"),
        });

        yield* install(bot, config, () =>
          Effect.gen(function* () {
            order.push("drain-start");
            yield* Deferred.succeed(drainStarted, undefined);
            yield* Deferred.await(releaseDrain);
            order.push("drain-end");
          }),
        ).pipe(
          Effect.provideService(Application, application),
          Effect.provide(BunCrypto.layer),
          Effect.provide(Logger.layer([logger])),
        );
        const handleInteraction = interactionHandlerFor(bot);
        const invoke = (overrides: Partial<DiscordInteraction>) =>
          new Promise<Parameters<DiscordInteraction["edit"]>[0]>((resolve) => {
            handleInteraction(
              interaction({
                channelId: 20n,
                data: { name: "close" },
                deferEdit: async () => {
                  componentDeferrals += 1;
                },
                edit: async (options) => {
                  order.push("reply");
                  resolve(options);
                },
                ...overrides,
              }),
            );
          });

        yield* TestClock.setTime(0);
        const first = yield* Effect.promise(() => invoke({}));
        const actionRow = first.components?.[0];
        if (actionRow?.type !== MessageComponentTypes.ActionRow) {
          return yield* Effect.die("missing close confirmation row");
        }
        const button = actionRow.components[0];
        if (button?.type !== MessageComponentTypes.Button || button.customId === undefined) {
          return yield* Effect.die("missing close confirmation button");
        }
        const customId = button.customId;
        assert.strictEqual(
          first.content,
          "Git requires destructive removal for this worktree. Closing may discard changes or nested repositories. Local and remote branches will be kept.",
        );
        assert.strictEqual(button.label, "Close with force");
        assert.strictEqual(button.style, ButtonStyles.Danger);
        assert.deepStrictEqual(order, ["core-safe", "reply"]);

        const unauthorized = yield* Effect.promise(() =>
          invoke({
            type: InteractionTypes.MessageComponent,
            user: { id: 101n },
            message: { id: 50n, channelId: 20n },
            data: { customId },
          }),
        );
        assert.strictEqual(
          unauthorized.content,
          "Only the person who requested this close can confirm it.",
        );
        assert.notInclude(order, "clear-button");

        yield* TestClock.setTime(300_001);
        const expired = yield* Effect.promise(() =>
          invoke({
            type: InteractionTypes.MessageComponent,
            message: { id: 50n, channelId: 20n },
            data: { customId },
          }),
        );
        assert.strictEqual(expired.content, "This close confirmation is no longer valid.");
        assert.deepStrictEqual(expired.components, []);
        assert.deepStrictEqual(order.slice(-1), ["reply"]);

        const second = yield* Effect.promise(() => invoke({}));
        const secondActionRow = second.components?.[0];
        if (secondActionRow?.type !== MessageComponentTypes.ActionRow) {
          return yield* Effect.die("missing close confirmation row");
        }
        const secondButton = secondActionRow.components[0];
        if (
          secondButton?.type !== MessageComponentTypes.Button ||
          secondButton.customId === undefined
        ) {
          return yield* Effect.die("missing close confirmation button");
        }
        const secondCustomId = secondButton.customId;
        failChannelLookup = true;
        const failedLookup = yield* Effect.promise(() =>
          invoke({
            type: InteractionTypes.MessageComponent,
            message: { id: 51n, channelId: 20n },
            data: { customId: secondCustomId },
          }),
        );
        assert.deepStrictEqual(failedLookup.components, []);
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0]?.annotations.operation, "close-confirmation");
        assert.strictEqual(logs[0]?.annotations.phase, "resolve-interaction-channel");
        assert.strictEqual(logs[0]?.annotations.chatId, chatId);
        failChannelLookup = false;
        const beforeConfirm = order.length;
        const confirming = yield* Effect.promise(() =>
          invoke({
            type: InteractionTypes.MessageComponent,
            message: { id: 51n, channelId: 20n },
            data: { customId: secondCustomId },
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(drainStarted);
        assert.notInclude(order, "archive-thread");
        yield* Deferred.succeed(releaseDrain, undefined);
        const confirmed = yield* Fiber.join(confirming);
        assert.strictEqual(
          confirmed.content,
          "Chat closed. The transcript remains available in this archived thread.",
        );
        assert.deepStrictEqual(confirmed.components, []);
        assert.deepStrictEqual(order.slice(beforeConfirm), [
          "core-force",
          "drain-start",
          "drain-end",
          "archive-thread",
          "reply",
        ]);
        assert.strictEqual(componentDeferrals, 4);

        const repeated = yield* Effect.promise(() =>
          invoke({
            type: InteractionTypes.MessageComponent,
            message: { id: 51n, channelId: 20n },
            data: { customId: secondCustomId },
          }),
        );
        assert.strictEqual(repeated.content, "This close confirmation is no longer valid.");
        assert.strictEqual(order.filter((entry) => entry === "core-force").length, 1);
        assert.strictEqual(componentDeferrals, 5);

        handlerFor(bot)(message({ channelId: 20n, content: "late" }));
        yield* Effect.promise(() => delivered);
        assert.strictEqual(sent.at(-1), "This chat is closed. Start a new thread to continue.");
      }),
    ),
  );
});
