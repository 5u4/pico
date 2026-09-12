import { mkdtemp, rm } from "node:fs/promises";
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
import * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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
    makeSessionHandle: adapter.makeSessionHandle,
  };
};

let native: Awaited<ReturnType<typeof importNative>>;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pico-native-pool-"));
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
  if (root) await rm(root, { recursive: true, force: true });
});

const platform = Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer);
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001");
const runId = Schedule.ScheduleRunId.make("scheduled-1000-018f47a0-0000-7000-8000-000000000003");
const prompt = (text: string) => AgentMessage.AgentPrompt.make({ text, attachments: [] });
const providerTurn = (text: string) => ({
  text,
  entered: Promise.withResolvers<Context>(),
  release: Promise.withResolvers<void>(),
});

const withSession = async (
  turns: ReturnType<typeof providerTurn>[],
  run: (session: AgentSession, reopen: () => Promise<AgentSession>) => Promise<void>,
  extensionFactory?: ExtensionFactory,
) => {
  const directory = await mkdtemp(join(root, "session-"));
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
      timestamp: Date.now(),
    };
    const abort = () => turn.release.resolve();
    options?.signal?.addEventListener("abort", abort, { once: true });
    turn.entered.resolve(context);
    if (options?.signal?.aborted) abort();
    void turn.release.promise.then(() => {
      options?.signal?.removeEventListener("abort", abort);
      if (options?.signal?.aborted) {
        response.stopReason = "aborted";
        response.errorMessage = "Request was aborted";
        stream.push({ type: "error", reason: "aborted", error: response });
      } else {
        stream.push({ type: "done", reason: "stop", message: response });
      }
      stream.end();
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
            shake: () => Promise.reject(new Error("Shake is not part of ownership tests")),
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
    loadTranscript: () => Effect.succeed(native.normalizeTranscript(session.messages)),
  });
});

const assistantTexts = (events: ReadonlyArray<AgentEvent.AgentEvent>) =>
  events.flatMap((event) =>
    event.type === "message-settled" && event.message.role === "assistant"
      ? event.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );

describe("native SessionPool ownership", () => {
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
