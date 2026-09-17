import NodeFileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type * as AgentEvent from "@pico/contract/agent-event";
import * as AgentMessage from "@pico/contract/agent-message";
import * as Chat from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const importNative = async () => {
  const modules = await Promise.all([
    import("@oh-my-pi/pi-agent-core"),
    import("@oh-my-pi/pi-ai/utils/event-stream"),
    import("@oh-my-pi/pi-coding-agent/session/agent-session"),
    import("@oh-my-pi/pi-coding-agent/session/session-manager"),
    import("@oh-my-pi/pi-coding-agent/session/auth-storage"),
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    import("@oh-my-pi/pi-coding-agent/config/model-registry"),
    import("@oh-my-pi/pi-coding-agent/session/messages"),
    import("@oh-my-pi/pi-coding-agent/extensibility/extensions/runner"),
    import("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"),
    import("@oh-my-pi/pi-coding-agent/utils/event-bus"),
    import("./omp-prompt-sender.ts"),
    import("./session-pool.ts"),
    import("./agent-event.ts"),
    import("./layer.ts"),
    import("./session-settings.ts"),
    import("@oh-my-pi/pi-coding-agent/session/session-loader"),
    import("@oh-my-pi/pi-coding-agent/session/session-context"),
  ]);
  const [
    core,
    streams,
    sessions,
    managers,
    auth,
    settings,
    registries,
    messages,
    extensions,
    loaders,
    events,
    sender,
    pool,
    normalized,
    adapter,
    sessionSettings,
    sessionLoader,
    sessionContext,
  ] = modules;
  return {
    ...core,
    ...streams,
    ...sessions,
    ...managers,
    ...auth,
    ...settings,
    ...registries,
    ...messages,
    ...extensions,
    ...loaders,
    ...events,
    ...sender,
    ...pool,
    ...normalized,
    ...sessionSettings,
    ...sessionLoader,
    ...sessionContext,
    makeSessionHandle: adapter.makeSessionHandle,
    makeBtw: adapter.makeBtw,
    makeShake: adapter.makeShake,
    makeSwitchModel: adapter.makeSwitchModel,
  };
};

let native: Awaited<ReturnType<typeof importNative>>;
let root: string;

beforeAll(async () => {
  root = await NodeFileSystem.mkdtemp(join(tmpdir(), "pico-native-pool-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("OMP_PROFILE", "default");
  vi.stubEnv("PI_PROFILE", "default");
  vi.stubEnv("PI_TEST_RUNTIME", "1");
  vi.stubEnv("PI_NO_TITLE", "1");
  native = await importNative();
}, 30_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (root) await NodeFileSystem.rm(root, { recursive: true, force: true });
});

const platform = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001");
const runId = Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003");
const prompt = (text: string) => AgentMessage.AgentPrompt.make({ text, attachments: [] });
const providerTurn = (
  text: string,
  abortReason: "aborted" | "error" = "aborted",
  options: {
    readonly streaming?: true;
    readonly messageId?: string;
    readonly timestamp?: number;
    readonly thinking?: string;
  } = {},
) => ({
  text,
  abortReason,
  ...options,
  entered: Promise.withResolvers<Context>(),
  release: Promise.withResolvers<void>(),
  aborted: Promise.withResolvers<void>(),
  settled: Promise.withResolvers<void>(),
  finishAbort: Promise.resolve(),
});

const withSession = async (
  turns: ReturnType<typeof providerTurn>[],
  run: (session: AgentSession, reopen: () => Promise<AgentSession>) => Promise<void>,
  extensionFactory?: ExtensionFactory,
) => {
  const directory = await NodeFileSystem.mkdtemp(join(root, "session-"));
  const auth = new native.AuthStorage(
    await native.SqliteAuthCredentialStore.open(join(directory, "auth.db")),
  );
  auth.setRuntimeApiKey("openai", "local-provider-only");
  const settings = native.Settings.isolated({
    "compaction.enabled": false,
    "retry.enabled": false,
    "retry.usageAwareFallback": false,
    "memory.backend": "off",
    "power.sleepPrevention": "off",
    "todo.enabled": false,
    "ttsr.enabled": false,
    "magicKeywords.enabled": false,
    "secrets.enabled": false,
    "git.enabled": false,
    "lsp.enabled": false,
  });
  const registry = new native.ModelRegistry(auth, join(directory, "models.yml"), {
    settings,
    ignoreLocalModelConfig: true,
    fetch: () => Promise.reject(new Error("Network is not part of pool ownership tests")),
  });
  const model = registry.find("openai", "gpt-4.1");
  if (!model) throw new Error("Pinned OMP catalog has no gpt-4.1 model");
  let nextTurn = 0;
  const streamFn: StreamFn = (requestedModel, context, options) => {
    const turn = turns[nextTurn++];
    if (!turn) throw new Error("Unexpected native provider turn");
    const stream = new native.AssistantMessageEventStream();
    const response: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: turn.text }],
      api: requestedModel.api,
      provider: requestedModel.provider,
      model: requestedModel.id,
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: turn.timestamp ?? Date.now(),
    };
    if (turn.messageId !== undefined) Object.assign(response, { messageId: turn.messageId });
    if (turn.thinking !== undefined) {
      response.content.unshift({ type: "thinking", thinking: turn.thinking });
    }
    const textIndex = turn.thinking === undefined ? 0 : 1;
    if (turn.streaming) {
      stream.push({ type: "start", partial: response });
      if (turn.thinking !== undefined) {
        stream.push({
          type: "thinking_delta",
          contentIndex: 0,
          delta: turn.thinking,
          partial: response,
        });
      }
      stream.push({
        type: "text_delta",
        contentIndex: textIndex,
        delta: turn.text,
        partial: response,
      });
    }
    const abort = () => {
      turn.aborted.resolve();
      turn.release.resolve();
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    turn.entered.resolve(context);
    if (options?.signal?.aborted) abort();
    void turn.release.promise.then(async () => {
      options?.signal?.removeEventListener("abort", abort);
      if (options?.signal?.aborted) {
        await turn.finishAbort;
        response.stopReason = turn.abortReason;
        response.errorMessage = "Request was aborted";
        stream.push({ type: "error", reason: turn.abortReason, error: response });
      } else {
        if (!turn.streaming) {
          stream.push({
            type: "text_delta",
            contentIndex: textIndex,
            delta: turn.text,
            partial: response,
          });
        }
        stream.push({ type: "done", reason: "stop", message: response });
      }
      stream.end();
      turn.settled.resolve();
    });
    return stream;
  };
  const sessions: AgentSession[] = [];
  const openSession = async (sessionFile?: string) => {
    const agent = new native.Agent({
      initialState: {
        model,
        systemPrompt: ["Use the local pool ownership test provider."],
        tools: [],
      },
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      convertToLlm: native.convertToLlm,
      streamFn,
      getApiKey: () => "local-provider-only",
    });
    const sessionManager =
      sessionFile === undefined
        ? native.SessionManager.create(directory, join(directory, "sessions"))
        : await native.SessionManager.open(sessionFile, join(directory, "sessions"));
    const runtime = new native.ExtensionRuntime();
    const extensionRunner = extensionFactory
      ? new native.ExtensionRunner(
          [
            await native.loadExtensionFromFactory(
              extensionFactory,
              directory,
              new native.EventBus(),
              runtime,
            ),
          ],
          runtime,
          directory,
          sessionManager,
          registry,
          undefined,
          settings,
        )
      : undefined;
    const session = new native.AgentSession({
      agent,
      settings,
      modelRegistry: registry,
      sessionManager,
      sideStreamFn: streamFn,
      ...(extensionRunner === undefined ? {} : { extensionRunner }),
      skills: [],
      skillsSettings: { enableSkillCommands: true },
      memoryAgentDir: join(directory, "agent"),
      disableExtensionDiscovery: true,
    });
    sessions.push(session);
    return session;
  };
  try {
    const session = await openSession();
    await run(session, () => {
      const sessionFile = session.sessionManager.getSessionFile();
      if (sessionFile === undefined) throw new Error("Expected native session journal");
      return openSession(sessionFile);
    });
  } finally {
    for (const session of sessions) {
      session.beginDispose();
      session.agent.abort("Pool ownership test cleanup");
    }
    for (const turn of turns) turn.release.resolve();
    try {
      await Promise.all(sessions.map((session) => session.dispose()));
    } finally {
      auth.close();
    }
  }
};

const makePool = Effect.fn("NativePoolTest.make")(function* (
  session: AgentSession,
  options: {
    readonly fileSystem?: FileSystem.FileSystem;
    readonly settlePersistence?: () => Promise<void>;
    readonly reopen?: () => Promise<AgentSession>;
  } = {},
) {
  const fileSystem = options.fileSystem ?? (yield* FileSystem.FileSystem);
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  let opened = false;
  return yield* native.makeSessionPool({
    factory: {
      open: (_id, emit) =>
        Effect.promise(async () => {
          if (opened && options.reopen) session = await options.reopen();
          opened = true;
          const currentSession = session;
          const sendPrompt = native.makeOmpPromptSender(currentSession, fileSystem, path, crypto, {
            chatId,
            runEffect: Effect.runPromise,
          });
          return {
            session: native.makeSessionHandle(
              {
                get isStreaming() {
                  return currentSession.isStreaming;
                },
                waitForIdle: () => currentSession.waitForIdle(),
                settleInFlightMessagePersistence:
                  options.settlePersistence ??
                  (() => currentSession.settleInFlightMessagePersistence()),
                abort: (options) => currentSession.abort(options),
                beginDispose: () => currentSession.beginDispose(),
                dispose: () => currentSession.dispose(),
              },
              sendPrompt.settle,
            ),
            sendPrompt,
            askBtw: native.makeBtw(currentSession),
            shake: native.makeShake(currentSession),
            switchModel: native.makeSwitchModel(currentSession),
            flush: async () => {
              await currentSession.sessionManager.ensureOnDisk();
              await currentSession.sessionManager.flush();
            },
            contextUsage: () => ({ kind: "unavailable" }),
            appendAssistantMessage: () =>
              Promise.reject(new Error("Publication is not part of ownership tests")),
            unsubscribe: currentSession.subscribe((event) => {
              const normalized = native.normalizeAgentEvent(event);
              if (normalized !== undefined) emit(normalized);
            }),
          };
        }),
    },
    loadTranscript: () =>
      Effect.succeed({
        messages: native.normalizeTranscript(session.messages),
        todo: { kind: "ready", phases: [] },
      }),
  });
});

const assistantTexts = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
  events.flatMap((event) =>
    event.type === "message-settled" && event.message.role === "assistant"
      ? event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );

const seedShake = async (session: AgentSession) => {
  const original = "Tool output retained until shake commits.\n".repeat(100);
  session.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "shake-tool",
    toolName: "bash",
    content: [
      { type: "text", text: original },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
    isError: false,
    useless: true,
    timestamp: 1,
  });
  session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
  await session.sessionManager.ensureOnDisk();
  await session.sessionManager.flush();
  const file = session.sessionManager.getSessionFile();
  if (file === undefined) throw new Error("Expected native shake journal");
  return { original, file };
};

describe("native SessionPool ownership", () => {
  it("retains assistant identity through deltas, interleaved messages and persistence", async () => {
    const options = { streaming: true, timestamp: 1, thinking: "Same reasoning" } as const;
    const turns = [
      providerTurn("Same answer", "aborted", options),
      providerTurn("Same answer", "aborted", options),
      providerTurn("Same answer", "aborted", { ...options, messageId: "existing-assistant" }),
    ];
    await withSession(turns, async (session) => {
      const events: AgentEvent.AgentEvent[] = [];
      let textReceived = Promise.withResolvers<void>();
      const unsubscribe = session.subscribe((event) => {
        const normalized = native.normalizeAgentEvent(event);
        if (normalized === undefined) return;
        events.push(normalized);
        if (normalized.type === "text-delta") textReceived.resolve();
      });
      try {
        for (const [index, turn] of turns.entries()) {
          textReceived = Promise.withResolvers<void>();
          const running = session.prompt(`Turn ${index}`, { expandPromptTemplates: false });
          await textReceived.promise;
          if (index === 0) {
            const aside = { role: "user", content: "Interleaved aside", timestamp: 2 } as const;
            session.agent.emitExternalEvent({ type: "message_start", message: aside });
            session.agent.emitExternalEvent({ type: "message_end", message: aside });
          }
          turn.release.resolve();
          await running;
        }
        await session.settleInFlightMessagePersistence();
        await session.sessionManager.ensureOnDisk();
        await session.sessionManager.flush();
        const file = session.sessionManager.getSessionFile();
        if (file === undefined) throw new Error("Expected identity journal");
        const persisted = native.normalizeTranscript(
          await native.loadSessionMessagesReadOnly(file),
        );
        const assistants = persisted.filter((message) => message.role === "assistant");
        const settled = events.flatMap((event) =>
          event.type === "message-settled" && event.message.role === "assistant"
            ? [event.message]
            : [],
        );
        const textIds = events.flatMap((event) =>
          event.type === "text-delta" ? [event.messageId] : [],
        );
        const thinkingIds = events.flatMap((event) =>
          event.type === "thinking-delta" ? [event.messageId] : [],
        );
        expect(settled).toEqual(assistants);
        expect(textIds).toEqual(assistants.map((message) => message.id));
        expect(thinkingIds).toEqual(textIds);
        expect(assistants).toHaveLength(3);
        expect(new Set(textIds).size).toBe(3);
        expect(textIds[2]).toBe("existing-assistant");
        expect(assistants[0]?.content).toEqual(assistants[1]?.content);
      } finally {
        unsubscribe();
      }
    });
  }, 30_000);

  it("discovers authenticated models and applies project model filters", async () => {
    await withSession([], async (session) => {
      const cwd = AbsolutePath.make(join(root, "model-picker-project"));
      const configDir = join(cwd, ".omp");
      const baseModel = session.model;
      if (baseModel === undefined) throw new Error("Expected a native initial model");
      session.modelRegistry.registerProvider("model-picker-no-auth", {
        apiKey: "revoked-test-key",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        models: [
          {
            id: "unavailable-model",
            name: "Missing credentials",
            reasoning: baseModel.reasoning,
            input: baseModel.input,
            cost: baseModel.cost,
            contextWindow: 128_000,
            maxTokens: 4_096,
          },
        ],
      });
      session.modelRegistry.authStorage.removeConfigApiKey("model-picker-no-auth");
      session.modelRegistry.authStorage.setFallbackResolver(() => undefined);
      const models = await Effect.runPromise(
        native.loadAvailableModels(session.modelRegistry, cwd),
      );
      expect(models.some((model) => model.provider === "openai" && model.id === "gpt-4.1")).toBe(
        true,
      );
      expect(models.some((model) => model.provider === "model-picker-no-auth")).toBe(false);

      await NodeFileSystem.mkdir(configDir, { recursive: true });
      const config = "enabledModels:\n  - openai/gpt-4.1\n  - model-picker-no-auth/*\n";
      await NodeFileSystem.writeFile(join(configDir, "config.yml"), config);
      const filtered = await Effect.runPromise(
        native.loadAvailableModels(session.modelRegistry, cwd),
      );
      expect(filtered.map(({ provider, id }) => `${provider}/${id}`)).toEqual(["openai/gpt-4.1"]);
      expect(await NodeFileSystem.readFile(join(configDir, "config.yml"), "utf8")).toBe(config);
    });
  });

  it("persists a per-session choice before the first prompt without changing model defaults", async () => {
    await withSession([], async (session) => {
      const chosen = session
        .getAvailableModels()
        .find((model) => model.provider === "openai" && model.id === "gpt-4.1-mini");
      if (chosen === undefined) throw new Error("Pinned OMP catalog has no gpt-4.1-mini model");
      const defaults = structuredClone(session.settings.get("modelRoles"));
      const file = session.sessionManager.getSessionFile();
      if (file === undefined) throw new Error("Expected native model selection journal");
      await withSession([], async (other) => {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const pool = yield* makePool(session);
              expect(yield* pool.switchModel(chatId, chosen)).toEqual({
                kind: "persisted",
                model: { provider: chosen.provider, id: chosen.id, name: chosen.name },
              });
              expect(session.model?.id).toBe(chosen.id);
              expect(other.model?.id).toBe("gpt-4.1");
              const persisted = yield* Effect.promise(() => native.loadEntriesFromFile(file));
              const entries = persisted.filter((entry) => entry.type !== "session");
              expect(
                native.getRestorableSessionModels(
                  native.buildSessionContext(entries).models,
                  entries.findLast((entry) => entry.type === "model_change")?.role,
                )[0],
              ).toBe(`${chosen.provider}/${chosen.id}`);
              expect(session.settings.get("modelRoles")).toEqual(defaults);
              yield* pool.close(chatId);
            }).pipe(Effect.provide(platform)),
          ),
        );
      });
    });
  });

  it.each(["Error", "AbortError"])(
    "reports an applied model when flushing its selection fails with %s",
    async (errorName) => {
      const turn = providerTurn("Continue with the selected model");
      await withSession([turn], (session) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const pool = yield* makePool(session);
              const chosen = { provider: "openai", id: "gpt-4.1-mini" };
              const file = session.sessionManager.getSessionFile();
              if (file === undefined) throw new Error("Expected native model selection journal");
              const failure = new Error("private-journal-path");
              failure.name = errorName;
              vi.spyOn(session.sessionManager, "flush").mockRejectedValueOnce(failure);
              const outcome = yield* pool.switchModel(chatId, chosen);
              expect(outcome).toMatchObject({
                kind: "persistence-unconfirmed",
                model: chosen,
              });
              const delivery = yield* pool.send(chatId, prompt("continue after the switch"));
              yield* Effect.promise(() => turn.entered.promise);
              turn.release.resolve();
              if (delivery.kind !== "handled") yield* delivery.completed;
              const reply = session.messages.findLast((message) => message.role === "assistant");
              expect(reply?.role === "assistant" ? reply.model : undefined).toBe(chosen.id);
              expect(yield* pool.switchModel(chatId, chosen)).toEqual({
                kind: "persisted",
                model: outcome.model,
              });
              const entries = yield* Effect.promise(() => native.loadEntriesFromFile(file));
              expect(
                native.buildSessionContext(entries.filter((entry) => entry.type !== "session"))
                  .models.temporary,
              ).toBe(`${chosen.provider}/${chosen.id}`);
            }).pipe(Effect.provide(platform)),
          ),
        ),
      );
    },
  );

  it("rejects busy and stale model choices without changing the running model", async () => {
    const turn = providerTurn("Complete with the original model");
    await withSession([turn], (session) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pool = yield* makePool(session);
            const original = session.model;
            session.settings.override("enabledModels", ["openai/gpt-4.1"]);
            expect(
              yield* pool
                .switchModel(chatId, { provider: "openai", id: "gpt-4.1-mini" })
                .pipe(Effect.flip),
            ).toBeInstanceOf(AgentError);
            expect(session.model).toBe(original);
            session.settings.clearOverride("enabledModels");
            const delivery = yield* pool.send(chatId, prompt("stay on this model"));
            yield* Effect.promise(() => turn.entered.promise);
            expect(
              yield* pool
                .switchModel(chatId, { provider: "openai", id: "gpt-4.1-mini" })
                .pipe(Effect.flip),
            ).toBeInstanceOf(AgentError);
            expect(session.model).toBe(original);
            turn.release.resolve();
            if (delivery.kind !== "handled") yield* delivery.completed;
          }).pipe(Effect.provide(platform)),
        ),
      ),
    );
  });

  it("retains model admission through native completion and flush after interruption", async () => {
    await withSession([], (session) => {
      const nativeEntered = Promise.withResolvers<void>();
      const releaseNative = Promise.withResolvers<void>();
      const flushing = Promise.withResolvers<void>();
      const releaseFlush = Promise.withResolvers<void>();
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const refresh = session.modelRegistry.refreshSelectedModelMetadata.bind(
              session.modelRegistry,
            );
            vi.spyOn(session.modelRegistry, "refreshSelectedModelMetadata").mockImplementation(
              async (model) => {
                nativeEntered.resolve();
                await releaseNative.promise;
                return refresh(model);
              },
            );
            const flush = session.sessionManager.flush.bind(session.sessionManager);
            vi.spyOn(session.sessionManager, "flush").mockImplementation(async () => {
              flushing.resolve();
              await releaseFlush.promise;
              await flush();
            });
            const dispose = vi.spyOn(session, "dispose");
            const pool = yield* makePool(session);
            const switching = yield* pool
              .switchModel(chatId, { provider: "openai", id: "gpt-4.1-mini" })
              .pipe(Effect.forkChild);
            yield* Effect.promise(() => nativeEntered.promise);
            const interrupting = yield* Fiber.interrupt(switching).pipe(Effect.forkChild);
            const closing = yield* pool.close(chatId).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            expect(dispose).not.toHaveBeenCalled();
            releaseNative.resolve();
            yield* Effect.promise(() => flushing.promise);
            expect(dispose).not.toHaveBeenCalled();
            releaseFlush.resolve();
            yield* Fiber.join(interrupting);
            yield* Fiber.join(closing);
            expect(session.model?.id).toBe("gpt-4.1-mini");
            const file = session.sessionManager.getSessionFile();
            if (file === undefined) throw new Error("Expected native model selection journal");
            const entries = yield* Effect.promise(() => native.loadEntriesFromFile(file));
            expect(
              native.buildSessionContext(entries.filter((entry) => entry.type !== "session")).models
                .temporary,
            ).toBe("openai/gpt-4.1-mini");
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                releaseNative.resolve();
                releaseFlush.resolve();
              }),
            ),
            Effect.provide(platform),
          ),
        ),
      );
    });
  });

  it("cancels native shake artifact staging without changing history, then shakes normally", async () => {
    await withSession([], async (session, reopen) => {
      const { original, file } = await seedShake(session);
      const before = await NodeFileSystem.readFile(file, "utf8");
      const entered = Promise.withResolvers<void>();
      const controller = new AbortController();
      const writeFile = NodeFileSystem.writeFile;
      const staging = vi
        .spyOn(NodeFileSystem, "writeFile")
        .mockImplementation(async (path, content, options) => {
          if (typeof path !== "string" || !path.includes(".shake.log.tmp-")) {
            return writeFile(path, content, options);
          }
          const signal =
            typeof options === "object" && options !== null ? options.signal : undefined;
          if (!signal) throw new Error("Shake artifact staging did not receive cancellation");
          await writeFile(path, content, options);
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            entered.resolve();
          });
          throw new Error("Cancelled artifact staging resumed");
        });
      try {
        const pending = session.shake("elide", { signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        await entered.promise;
        controller.abort();
        await rejected;
      } finally {
        staging.mockRestore();
      }
      expect(await NodeFileSystem.readFile(file, "utf8")).toBe(before);
      const directory = session.sessionManager.getArtifactsDir();
      if (directory === null) throw new Error("Expected native shake artifact directory");
      expect(await NodeFileSystem.readdir(directory)).toEqual([]);
      const result = await session.shake("elide");
      expect(result.toolResultsDropped).toBe(1);
      if (result.artifactId === undefined) throw new Error("Shake did not preserve an artifact");
      const artifact = await session.sessionManager.getArtifactPath(result.artifactId);
      if (artifact === null) throw new Error("Shake recovery artifact is missing");
      expect(await NodeFileSystem.readFile(artifact, "utf8")).toContain(original);
      expect(session.messages.find((message) => message.role === "toolResult")?.content).toEqual([
        { type: "text", text: expect.stringContaining(`artifact://${result.artifactId}`) },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ]);
      const expected = structuredClone(session.messages);
      await session.dispose();
      const persisted = await reopen();
      expect(persisted.sessionManager.buildSessionContext().messages).toEqual(expected);
    });
  }, 5_000);

  it("rejects a native pre-aborted shake before dropping images", async () => {
    await withSession([], async (session) => {
      const { file } = await seedShake(session);
      const before = await NodeFileSystem.readFile(file, "utf8");
      const controller = new AbortController();
      controller.abort();
      await expect(session.shake("images", { signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(await NodeFileSystem.readFile(file, "utf8")).toBe(before);
      expect((await session.shake("images")).imagesDropped).toBe(1);
    });
  }, 5_000);

  it("finishes an admitted native rewrite before interrupted shake disposal", async () => {
    await withSession([], async (session) => {
      const { file } = await seedShake(session);
      const rewriting = Promise.withResolvers<void>();
      const cancelled = Promise.withResolvers<void>();
      const order: string[] = [];
      const nativeShake = session.shake.bind(session);
      const nativeRewrite = session.sessionManager.rewriteEntries.bind(session.sessionManager);
      const nativeDispose = session.dispose.bind(session);
      const shake = vi.spyOn(session, "shake").mockImplementation((mode, options) => {
        options?.signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
        return nativeShake(mode, options);
      });
      const rewrite = vi
        .spyOn(session.sessionManager, "rewriteEntries")
        .mockImplementation(async () => {
          rewriting.resolve();
          await cancelled.promise;
          await nativeRewrite();
          order.push("committed");
        });
      const dispose = vi.spyOn(session, "dispose").mockImplementation(async () => {
        order.push("disposed");
        await nativeDispose();
      });
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const pool = yield* makePool(session);
              const pending = yield* pool.shake(chatId, "images").pipe(Effect.forkChild);
              yield* Effect.promise(() => rewriting.promise);
              yield* pool.close(chatId).pipe(Effect.timeout("1 second"));
              const exit = yield* Fiber.await(pending);
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
              expect(order).toEqual(["committed", "disposed"]);
              const persisted = yield* Effect.promise(() => NodeFileSystem.readFile(file, "utf8"));
              expect(persisted).not.toContain('"type":"image"');
              yield* Effect.sleep("1 millis");
              expect(yield* Effect.promise(() => NodeFileSystem.readFile(file, "utf8"))).toBe(
                persisted,
              );
            }).pipe(Effect.provide(platform)),
          ),
        );
      } finally {
        shake.mockRestore();
        rewrite.mockRestore();
        dispose.mockRestore();
      }
    });
  }, 5_000);

  it("propagates native shake artifact failures without rewriting history", async () => {
    await withSession([], async (session) => {
      const { file } = await seedShake(session);
      const before = await NodeFileSystem.readFile(file, "utf8");
      const failure = new Error("Artifact disk is unavailable");
      const writeFile = NodeFileSystem.writeFile;
      const artifact = vi
        .spyOn(NodeFileSystem, "writeFile")
        .mockImplementation((path, content, options) =>
          typeof path === "string" && path.includes(".shake.log.tmp-")
            ? Promise.reject(failure)
            : writeFile(path, content, options),
        );
      try {
        await expect(session.shake("elide")).rejects.toBe(failure);
        expect(await NodeFileSystem.readFile(file, "utf8")).toBe(before);
      } finally {
        artifact.mockRestore();
      }
    });
  }, 5_000);

  it("answers beside a pending main turn without steering, persisting, or emitting the aside", async () => {
    const main = providerTurn("Main answer");
    const side = providerTurn("Independent side answer");
    const steered = providerTurn("Corrected main answer");
    const idleSide = providerTurn("Idle side answer");
    await withSession([main, side, steered, idleSide], (session, reopen) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pool = yield* makePool(session);
            const events: AgentEvent.AgentEvent[] = [];
            const initialMessage = Promise.withResolvers<void>();
            yield* pool.events.pipe(
              Stream.runForEach(({ event }) =>
                Effect.sync(() => {
                  events.push(event);
                  if (event.type === "message-settled" && event.message.role === "user") {
                    initialMessage.resolve();
                  }
                }),
              ),
              Effect.forkChild,
            );
            const first = yield* pool.send(chatId, prompt("Main request"));
            yield* Effect.promise(() => main.entered.promise);
            yield* Effect.promise(() => initialMessage.promise);
            const before = structuredClone(session.messages);
            const eventsBefore = [...events];
            const entriesBefore = session.sessionManager.getEntries();
            const aside = yield* pool
              .askBtw(chatId, "Explain the current request")
              .pipe(Effect.forkChild);
            const sideContext = yield* Effect.promise(() => side.entered.promise);
            expect(JSON.stringify(sideContext.messages)).toContain("Main request");
            const correction = yield* pool.send(chatId, prompt("Correct the main request"));
            if (correction.kind !== "steered")
              throw new Error("Expected immediate steering admission");
            side.release.resolve();
            expect(yield* Fiber.join(aside)).toBe(side.text);
            yield* pool.drain();
            expect(session.messages).toEqual(before);
            expect(session.sessionManager.getEntries()).toEqual(entriesBefore);
            expect(events).toEqual(eventsBefore);
            main.release.resolve();
            yield* Effect.promise(() => steered.entered.promise);
            expect(yield* correction.consumed).toBe("consumed");
            steered.release.resolve();
            if (first.kind !== "handled") yield* first.completed;
            yield* Effect.promise(() => session.waitForIdle());
            yield* pool.drain();
            expect(assistantTexts(events)).toEqual([main.text, steered.text]);
            const transcript = native.normalizeTranscript(session.messages);
            const ordinaryEvents = [...events];
            const idle = yield* pool.askBtw(chatId, "What just finished?").pipe(Effect.forkChild);
            const idleContext = yield* Effect.promise(() => idleSide.entered.promise);
            expect(JSON.stringify(idleContext.messages)).not.toContain(
              "Explain the current request",
            );
            expect(JSON.stringify(idleContext.messages)).not.toContain(side.text);
            yield* pool.abort(chatId);
            idleSide.release.resolve();
            expect(yield* Fiber.join(idle)).toBe(idleSide.text);
            yield* pool.drain();
            expect(native.normalizeTranscript(session.messages)).toEqual(transcript);
            expect(events).toEqual(ordinaryEvents);
            yield* pool.close(chatId);
            const persisted = yield* Effect.promise(reopen);
            expect(
              native.normalizeTranscript(persisted.sessionManager.buildSessionContext().messages),
            ).toEqual(transcript);
          }).pipe(Effect.provide(platform)),
        ),
      ),
    );
  }, 30_000);

  it.each(["interrupt", "close", "shutdown"] as const)(
    "settles native side cancellation before releasing the session on %s",
    async (stop) => {
      const side = providerTurn("Must not be published");
      const releaseAbort = Promise.withResolvers<void>();
      side.finishAbort = releaseAbort.promise;
      await withSession([side], (session) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const poolScope = yield* Scope.make();
              const dispose = vi.spyOn(session, "dispose");
              const pool = yield* makePool(session).pipe(
                Effect.provideService(Scope.Scope, poolScope),
              );
              const aside = yield* pool
                .askBtw(chatId, "Cancelled side question")
                .pipe(Effect.forkChild);
              yield* Effect.promise(() => side.entered.promise);
              let stopped = false;
              const stopping = yield* (
                stop === "interrupt"
                  ? Fiber.interrupt(aside)
                  : stop === "close"
                    ? pool.close(chatId)
                    : Scope.close(poolScope, Exit.void)
              ).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    stopped = true;
                  }),
                ),
                Effect.forkChild,
              );
              yield* Effect.gen(function* () {
                yield* Effect.promise(() => side.aborted.promise);
                expect(stopped).toBe(false);
                expect(dispose).not.toHaveBeenCalled();
                releaseAbort.resolve();
                yield* Fiber.join(stopping);
                yield* Effect.promise(() => side.settled.promise);
                const result = yield* Fiber.await(aside);
                expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
                if (stop === "interrupt") expect(dispose).not.toHaveBeenCalled();
                yield* Scope.close(poolScope, Exit.void);
                expect(dispose).toHaveBeenCalledOnce();
              }).pipe(Effect.ensuring(Effect.sync(() => releaseAbort.resolve())));
            }).pipe(Effect.provide(platform)),
          ),
        ),
      );
    },
    30_000,
  );

  it("preserves a native side provider error received after cancellation", async () => {
    const side = providerTurn("Must not be published", "error");
    await withSession([side], async (session) => {
      const controller = new AbortController();
      const pending = session.runEphemeralTurn({
        promptText: "Cancelled side question",
        signal: controller.signal,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        name: "Error",
        message: "Request was aborted",
      });
      await side.entered.promise;
      controller.abort();
      await rejected;
    });
  }, 5_000);

  it("drains discarded image cleanup before closing and reopening the same journal", async () => {
    const initial = providerTurn("Interrupted ordinary answer");
    const reused = providerTurn("Reopened image answer");
    const removing = Promise.withResolvers<string>();
    const releaseRemove = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    const image = AgentMessage.AgentPrompt.make({
      text: "Keep this image",
      attachments: [
        {
          type: "image",
          name: "pixel.png",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      ],
    });
    await withSession([initial, reused], (session, reopen) =>
      session.runModeExitTeardown(() =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem;
              const pool = yield* makePool(session, {
                reopen,
                fileSystem: {
                  ...fileSystem,
                  remove: (file, options) =>
                    Effect.promise(async () => {
                      removing.resolve(file);
                      await releaseRemove.promise;
                    }).pipe(
                      Effect.andThen(fileSystem.remove(file, options)),
                      Effect.tap(() => Effect.sync(() => removed.resolve())),
                    ),
                },
              });
              yield* Effect.gen(function* () {
                const first = yield* pool.send(chatId, prompt("Ordinary request"));
                expect(first.kind).toBe("started");
                yield* Effect.promise(() => initial.entered.promise);
                const queued = yield* pool.send(chatId, image);
                if (queued.kind !== "steered") throw new Error("Expected queued image admission");
                yield* queued.completed;
                yield* pool.abort(chatId);
                if (first.kind !== "handled") yield* first.completed;
                const closing = yield* pool.close(chatId).pipe(Effect.forkChild);
                const reopening = yield* Fiber.join(closing).pipe(
                  Effect.andThen(pool.send(chatId, image)),
                  Effect.forkChild,
                );
                const original = yield* Effect.promise(() => removing.promise);
                const closedBeforeCleanup = yield* Effect.raceFirst(
                  Fiber.join(closing).pipe(Effect.as(true)),
                  Effect.sleep("100 millis").pipe(Effect.as(false)),
                );
                expect.soft(closedBeforeCleanup).toBe(false);
                if (closedBeforeCleanup) yield* Effect.promise(() => reused.entered.promise);
                releaseRemove.resolve();
                yield* Effect.promise(() => removed.promise);
                const delivery = yield* Fiber.join(reopening);
                expect(delivery.kind).toBe("started");
                const context = yield* Effect.promise(() => reused.entered.promise);
                expect(
                  context.messages.some(
                    (message) =>
                      message.role === "user" &&
                      typeof message.content !== "string" &&
                      message.content.some((part) => part.type === "image"),
                  ),
                ).toBe(true);
                expect(yield* fileSystem.exists(original)).toBe(true);
                expect(yield* queued.consumed).toBe("discarded");
                reused.release.resolve();
                if (delivery.kind !== "handled") yield* delivery.completed;
                yield* pool.close(chatId);
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    releaseRemove.resolve();
                    reused.release.resolve();
                  }),
                ),
              );
            }).pipe(Effect.provide(platform)),
          ),
        ),
      ),
    );
  }, 30_000);

  it("closes a live captured run before its provider finishes", async () => {
    const scheduled = providerTurn("Must be aborted by close");
    await withSession([scheduled], (session) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pool = yield* makePool(session);
            const events: AgentEvent.AgentEvent[] = [];
            yield* Effect.gen(function* () {
              const capture = yield* pool
                .sendCaptured(chatId, runId, prompt("Scheduled request"), (event) =>
                  Effect.sync(() => {
                    events.push(event);
                  }),
                )
                .pipe(Effect.forkChild);
              yield* Effect.promise(() => scheduled.entered.promise);
              const closing = yield* pool.close(chatId).pipe(Effect.forkChild);
              const settled = yield* Effect.raceFirst(
                Effect.all([Fiber.join(closing), Fiber.await(capture)]).pipe(Effect.as(true)),
                Effect.sleep("1 second").pipe(Effect.as(false)),
              );
              expect(settled).toBe(true);
              const interrupted = yield* Fiber.await(capture);
              expect(
                Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause),
              ).toBe(true);
              expect(events).toContainEqual({ type: "run-finished", outcome: "aborted" });
              expect(session.isStreaming).toBe(false);
            }).pipe(
              Effect.ensuring(
                Effect.promise(async () => {
                  scheduled.release.resolve();
                  await session.abort({ reason: "Release close regression after assertion" });
                }),
              ),
            );
          }).pipe(Effect.provide(platform)),
        ),
      ),
    );
  }, 30_000);

  it("closes a capture waiting for admission persistence without starting a provider", async () => {
    const persisting = Promise.withResolvers<void>();
    const releasePersistence = Promise.withResolvers<void>();
    await withSession([], (session) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pool = yield* makePool(session, {
              settlePersistence: async () => {
                persisting.resolve();
                await releasePersistence.promise;
                await session.settleInFlightMessagePersistence();
              },
            });
            yield* Effect.gen(function* () {
              const capture = yield* pool
                .sendCaptured(chatId, runId, prompt("Waiting for persistence"), () => Effect.void)
                .pipe(Effect.forkChild);
              yield* Effect.promise(() => persisting.promise);
              const closing = yield* pool.close(chatId).pipe(Effect.forkChild);
              const settled = yield* Effect.raceFirst(
                Effect.all([Fiber.join(closing), Fiber.await(capture)]).pipe(Effect.as(true)),
                Effect.sleep("1 second").pipe(Effect.as(false)),
              );
              expect(settled).toBe(true);
              const interrupted = yield* Fiber.await(capture);
              expect(
                Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause),
              ).toBe(true);
            }).pipe(Effect.ensuring(Effect.sync(() => releasePersistence.resolve())));
          }).pipe(Effect.provide(platform)),
        ),
      ),
    );
  }, 30_000);

  it("admits a capture after an aborted ordinary run resumes its queued steer", async () => {
    const initial = providerTurn("Interrupted ordinary answer");
    const resumed = providerTurn("Resumed ordinary answer");
    const scheduled = providerTurn("Scheduled answer");
    await withSession([initial, resumed, scheduled], (session) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const pool = yield* makePool(session);
            const ordinary: AgentEvent.AgentEvent[] = [];
            yield* pool.events.pipe(
              Stream.runForEach(({ event }) =>
                Effect.sync(() => {
                  ordinary.push(event);
                }),
              ),
              Effect.forkChild,
            );
            const first = yield* pool.send(chatId, prompt("Ordinary request"));
            expect(first.kind).toBe("started");
            yield* Effect.promise(() => initial.entered.promise);
            const steer = yield* pool.send(chatId, prompt("Survives abort"));
            if (steer.kind !== "steered") throw new Error("Expected native steering admission");
            yield* Effect.promise(() =>
              session.runModeExitTeardown(() => Effect.runPromise(pool.abort(chatId))),
            );
            yield* Effect.promise(() => resumed.entered.promise);
            expect(yield* steer.consumed).toBe("consumed");
            resumed.release.resolve();
            if (first.kind !== "handled") yield* first.completed;
            yield* Effect.promise(() => session.agent.waitForIdle());
            const captured = yield* pool
              .sendCaptured(chatId, runId, prompt("Scheduled request"), () => Effect.void)
              .pipe(Effect.forkChild);
            yield* Effect.promise(() => scheduled.entered.promise);
            scheduled.release.resolve();
            const result = yield* Fiber.join(captured);
            yield* pool.drain();
            expect(result.finalAssistantText).toBe("Scheduled answer");
            expect(assistantTexts(result.events)).toEqual(["Scheduled answer"]);
            expect(assistantTexts(ordinary)).toContain("Resumed ordinary answer");
            expect(assistantTexts(ordinary)).not.toContain("Scheduled answer");
          }).pipe(Effect.provide(platform)),
        ),
      ),
    );
  }, 30_000);

  it("keeps a scheduled waiter when a new prompt overtakes resumed session_stop fanout", async () => {
    const initial = providerTurn("Interrupted ordinary answer");
    const resumed = providerTurn("Resumed ordinary answer");
    const following = providerTurn("Following ordinary answer");
    const scheduled = providerTurn("Scheduled answer");
    const stopHook = Promise.withResolvers<void>();
    const releaseStopHook = Promise.withResolvers<void>();
    await withSession(
      [initial, resumed, following, scheduled],
      (session) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const pool = yield* makePool(session);
              yield* Effect.addFinalizer(() => Effect.sync(() => releaseStopHook.resolve()));
              const ordinary: AgentEvent.AgentEvent[] = [];
              yield* pool.events.pipe(
                Stream.runForEach(({ event }) =>
                  Effect.sync(() => {
                    ordinary.push(event);
                  }),
                ),
                Effect.forkChild,
              );
              const first = yield* pool.send(chatId, prompt("Ordinary request"));
              if (first.kind !== "started") throw new Error("Expected ordinary admission");
              yield* Effect.promise(() => initial.entered.promise);
              const steer = yield* pool.send(chatId, prompt("Survives abort"));
              if (steer.kind !== "steered") throw new Error("Expected native steering admission");
              yield* Effect.promise(() =>
                session.runModeExitTeardown(async () => {
                  await Effect.runPromise(pool.abort(chatId));
                  await Effect.runPromise(first.completed);
                  await Effect.runPromise(pool.drain());
                }),
              );
              yield* Effect.promise(() => resumed.entered.promise);
              expect(yield* steer.consumed).toBe("consumed");
              yield* pool.drain();
              const captured = yield* pool
                .sendCaptured(chatId, runId, prompt("Scheduled request"), () => Effect.void)
                .pipe(Effect.forkChild);
              yield* Effect.yieldNow;
              resumed.release.resolve();
              yield* Effect.promise(() => stopHook.promise);
              yield* Effect.promise(() => session.agent.waitForIdle());
              yield* Effect.yieldNow;
              expect(session.isStreaming).toBe(false);
              const next = yield* pool.send(chatId, prompt("New ordinary request"));
              if (next.kind !== "started")
                throw new Error("Expected new ordinary admission before terminal fanout");
              yield* Effect.promise(() => following.entered.promise);
              releaseStopHook.resolve();
              following.release.resolve();
              yield* next.completed;
              yield* Effect.promise(() => scheduled.entered.promise);
              scheduled.release.resolve();
              const result = yield* Fiber.join(captured);
              yield* pool.drain();
              expect(result.finalAssistantText).toBe("Scheduled answer");
              expect(assistantTexts(result.events)).toEqual(["Scheduled answer"]);
              expect(assistantTexts(ordinary)).toContain("Resumed ordinary answer");
              expect(assistantTexts(ordinary)).toContain("Following ordinary answer");
              expect(assistantTexts(ordinary)).not.toContain("Scheduled answer");
              yield* pool.close(chatId);
            }).pipe(Effect.provide(platform)),
          ),
        ),
      (api) => {
        api.on("session_stop", async (event) => {
          const message = event.last_assistant_message;
          if (
            message?.role !== "assistant" ||
            !message.content.some((block) => block.type === "text" && block.text === resumed.text)
          )
            return;
          stopHook.resolve();
          await releaseStopHook.promise;
        });
      },
    );
  }, 30_000);

  it("waits for auto-resume hidden by agent_start while ordinary steers remain available", async () => {
    const initial = providerTurn("Interrupted ordinary answer");
    const resumed = providerTurn("Resumed ordinary answer");
    const corrected = providerTurn("Corrected ordinary answer");
    const scheduled = providerTurn("Scheduled answer");
    const startHook = Promise.withResolvers<void>();
    const releaseStartHook = Promise.withResolvers<void>();
    let starts = 0;
    await withSession(
      [initial, resumed, corrected, scheduled],
      (session) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const pool = yield* makePool(session);
              yield* Effect.addFinalizer(() => Effect.sync(() => releaseStartHook.resolve()));
              const ordinary: AgentEvent.AgentEvent[] = [];
              yield* pool.events.pipe(
                Stream.runForEach(({ event }) =>
                  Effect.sync(() => {
                    ordinary.push(event);
                  }),
                ),
                Effect.forkChild,
              );
              const first = yield* pool.send(chatId, prompt("Ordinary request"));
              if (first.kind !== "started") throw new Error("Expected ordinary admission");
              yield* Effect.promise(() => initial.entered.promise);
              const queued = yield* pool.send(chatId, prompt("Survives abort"));
              if (queued.kind !== "steered") throw new Error("Expected native steering admission");
              yield* Effect.promise(() =>
                session.runModeExitTeardown(async () => {
                  await Effect.runPromise(pool.abort(chatId));
                  await Effect.runPromise(first.completed);
                  await Effect.runPromise(pool.drain());
                }),
              );
              yield* Effect.promise(() => startHook.promise);
              yield* Effect.promise(() => resumed.entered.promise);
              expect(yield* queued.consumed).toBe("consumed");
              expect(session.isStreaming).toBe(true);
              expect(ordinary.filter((event) => event.type === "run-started")).toHaveLength(1);
              const abort = vi.spyOn(session, "abort");
              const captured = yield* pool
                .sendCaptured(chatId, runId, prompt("Scheduled request"), () => Effect.void)
                .pipe(Effect.forkChild);
              yield* Effect.yieldNow;
              const correction = yield* pool.send(chatId, prompt("Urgent resumed correction"));
              if (correction.kind !== "steered")
                throw new Error("Expected immediate resumed steering admission");
              expect(session.agent.peekSteeringQueue()).toHaveLength(1);
              expect(abort).not.toHaveBeenCalled();
              releaseStartHook.resolve();
              resumed.release.resolve();
              yield* Effect.promise(() => corrected.entered.promise);
              expect(yield* correction.consumed).toBe("consumed");
              corrected.release.resolve();
              yield* Effect.promise(() => scheduled.entered.promise);
              scheduled.release.resolve();
              const result = yield* Fiber.join(captured);
              yield* pool.drain();
              expect(abort).not.toHaveBeenCalled();
              expect(result.finalAssistantText).toBe("Scheduled answer");
              expect(assistantTexts(result.events)).toEqual(["Scheduled answer"]);
              expect(assistantTexts(ordinary)).toContain("Resumed ordinary answer");
              expect(assistantTexts(ordinary)).toContain("Corrected ordinary answer");
              expect(assistantTexts(ordinary)).not.toContain("Scheduled answer");
              yield* pool.close(chatId);
            }).pipe(Effect.provide(platform)),
          ),
        ),
      (api) => {
        api.on("agent_start", async () => {
          if (++starts !== 2) return;
          startHook.resolve();
          await releaseStartHook.promise;
        });
      },
    );
  }, 30_000);

  it("routes an image admitted across captured terminal persistence to ordinary output", async () => {
    const scheduled = providerTurn("Scheduled answer");
    const image = providerTurn("Ordinary image answer");
    const writing = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const persisting = Promise.withResolvers<void>();
    const releasePersistence = Promise.withResolvers<void>();
    await withSession([scheduled, image], (session) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const pool = yield* makePool(session, {
              fileSystem: {
                ...fileSystem,
                writeFile: (path, bytes, options) =>
                  fileSystem.writeFile(path, bytes, options).pipe(
                    Effect.tap(() =>
                      Effect.promise(async () => {
                        writing.resolve();
                        await releaseWrite.promise;
                      }),
                    ),
                  ),
              },
              settlePersistence: async () => {
                if (
                  session.messages.some(
                    (message) =>
                      message.role === "assistant" &&
                      message.content.some(
                        (part) => part.type === "text" && part.text === scheduled.text,
                      ),
                  )
                ) {
                  persisting.resolve();
                  await releasePersistence.promise;
                }
                await session.settleInFlightMessagePersistence();
              },
            });
            const ordinary: AgentEvent.AgentEvent[] = [];
            const capturedEvents: AgentEvent.AgentEvent[] = [];
            yield* pool.events.pipe(
              Stream.runForEach(({ event }) =>
                Effect.sync(() => {
                  ordinary.push(event);
                }),
              ),
              Effect.forkChild,
            );
            const captured = yield* pool
              .sendCaptured(chatId, runId, prompt("Scheduled request"), (event) =>
                Effect.sync(() => {
                  capturedEvents.push(event);
                }),
              )
              .pipe(Effect.forkChild);
            yield* Effect.promise(() => scheduled.entered.promise);
            const sendingImage = yield* pool
              .send(
                chatId,
                AgentMessage.AgentPrompt.make({
                  text: "Inspect this image",
                  attachments: [
                    {
                      type: "image",
                      name: "pixel.png",
                      mimeType: "image/png",
                      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                    },
                  ],
                }),
              )
              .pipe(Effect.forkChild);
            yield* Effect.promise(() => writing.promise);
            scheduled.release.resolve();
            yield* Effect.promise(() => persisting.promise);
            releaseWrite.resolve();
            const delivery = yield* Fiber.join(sendingImage);
            expect(delivery.kind).toBe("started");
            yield* Effect.promise(() => image.entered.promise);
            image.release.resolve();
            if (delivery.kind !== "handled") yield* delivery.completed;
            yield* pool.drain();
            expect(assistantTexts(ordinary)).toEqual(["Ordinary image answer"]);
            expect(assistantTexts(capturedEvents)).toEqual(["Scheduled answer"]);
            expect(capturedEvents.filter((event) => event.type === "run-started")).toHaveLength(1);
            releasePersistence.resolve();
            const result = yield* Fiber.join(captured);
            expect(result.finalAssistantText).toBe("Scheduled answer");
            expect(assistantTexts(result.events)).toEqual(["Scheduled answer"]);
          }).pipe(Effect.provide(platform)),
        ),
      ),
    );
  }, 30_000);

  it("reserves native admission before delayed agent_start fanout without delaying busy steers", async () => {
    const initial = providerTurn("Ordinary answer");
    const steered = providerTurn("Steered answer");
    const scheduled = providerTurn("Scheduled answer");
    const startHook = Promise.withResolvers<void>();
    const releaseStartHook = Promise.withResolvers<void>();
    await withSession(
      [initial, steered, scheduled],
      (session) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const abort = vi.spyOn(session, "abort");
              const pool = yield* makePool(session);
              const ordinary: AgentEvent.AgentEvent[] = [];
              yield* pool.events.pipe(
                Stream.runForEach(({ event }) =>
                  Effect.sync(() => {
                    ordinary.push(event);
                  }),
                ),
                Effect.forkChild,
              );
              const first = yield* pool.send(chatId, prompt("Ordinary request"));
              expect(first.kind).toBe("started");
              yield* Effect.promise(() => startHook.promise);
              yield* Effect.promise(() => initial.entered.promise);
              expect(ordinary.some((event) => event.type === "run-started")).toBe(false);
              const captured = yield* pool
                .sendCaptured(chatId, runId, prompt("Scheduled request"), () => Effect.void)
                .pipe(Effect.forkChild);
              yield* Effect.yieldNow;
              const steer = yield* pool.send(chatId, prompt("Urgent correction"));
              if (steer.kind !== "steered")
                throw new Error("Expected immediate native steering admission");
              expect(abort).not.toHaveBeenCalled();
              expect(session.agent.peekSteeringQueue()).toHaveLength(1);
              releaseStartHook.resolve();
              initial.release.resolve();
              yield* Effect.promise(() => steered.entered.promise);
              expect(yield* steer.consumed).toBe("consumed");
              steered.release.resolve();
              if (first.kind !== "handled") yield* first.completed;
              yield* Effect.promise(() => scheduled.entered.promise);
              scheduled.release.resolve();
              const result = yield* Fiber.join(captured);
              yield* pool.drain();
              expect(abort).not.toHaveBeenCalled();
              expect(result.finalAssistantText).toBe("Scheduled answer");
              expect(assistantTexts(ordinary)).toEqual(["Ordinary answer", "Steered answer"]);
              expect(assistantTexts(result.events)).toEqual(["Scheduled answer"]);
            }).pipe(Effect.provide(platform)),
          ),
        ),
      (api) => {
        api.on("agent_start", async () => {
          startHook.resolve();
          await releaseStartHook.promise;
        });
      },
    );
  }, 30_000);
});
