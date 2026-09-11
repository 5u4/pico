import * as OmpModelRegistry from "@oh-my-pi/pi-coding-agent/config/model-registry";
import * as OmpSettings from "@oh-my-pi/pi-coding-agent/config/settings";
import * as OmpAgentRegistry from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as OmpSdk from "@oh-my-pi/pi-coding-agent/sdk";
import type * as OmpAgentSession from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as OmpSessionManager from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type * as OmpShake from "@oh-my-pi/pi-coding-agent/session/shake-types";
import { AgentRuntime, type ContextUsage, type ShakeResult } from "@pico/contract/agent-runtime";
import type * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AgentError } from "@pico/contract/errors";
import type { AbsolutePath } from "@pico/contract/path";
import type * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { normalizeAgentEvent, normalizeTranscript } from "./agent-event.ts";
import { makeExchangeTitleFlow } from "./exchange-title.ts";
import { makeOmpPromptSender } from "./omp-prompt-sender.ts";
import { make as makeScheduleExtension } from "./schedule-extension.ts";
import { makeSessionPool, type OpenedSession, type SessionFactory } from "./session-pool.ts";

export const make = Effect.fn("AgentRuntime.make")(function* (
  sessionsDir: AbsolutePath,
  schedules: Schedule.Schedules["Service"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const chats = yield* ChatRepository;

  yield* fileSystem
    .makeDirectory(sessionsDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((error) => agentError("Failed to create OMP sessions directory", error)));

  const authStorage = yield* Effect.acquireRelease(
    promiseBoundary("Failed to initialize OMP authentication", OmpSdk.discoverAuthStorage),
    (storage) =>
      ignoreCleanupFailure(
        "Failed to close OMP authentication",
        Effect.sync(() => storage.close()),
      ),
  );
  const modelRegistry = yield* syncBoundary(
    "Failed to initialize OMP model registry",
    () => new OmpModelRegistry.ModelRegistry(authStorage),
  );
  yield* promiseBoundary("Failed to load OMP model registry", () => modelRegistry.refresh());

  const loadTranscript = Effect.fn("OmpSession.loadTranscript")(function* (chatId: Chat.ChatId) {
    const sessionFile = path.join(sessionsDir, `${chatId}.jsonl`);
    const messages = yield* promiseBoundary("Failed to read OMP transcript", () =>
      OmpSessionLoader.loadSessionMessagesReadOnly(sessionFile),
    );
    return yield* syncBoundary("Failed to normalize OMP transcript", () =>
      normalizeTranscript(messages),
    );
  });

  const pool = yield* makeSessionPool({
    factory: makeFactory(sessionsDir, path, chats, authStorage, modelRegistry, schedules),
    loadTranscript,
  });

  return AgentRuntime.of({
    events: pool.events,
    drain: pool.drain,
    transcript: pool.transcript,
    send: pool.send,
    sendCaptured: pool.sendCaptured,
    deliver: pool.deliver,
    publish: pool.publish,
    close: pool.close,
    abort: pool.abort,
    contextUsage: pool.contextUsage,
    shake: pool.shake,
  });
});

export const layer = (sessionsDir: AbsolutePath, schedules: Schedule.Schedules["Service"]) =>
  Layer.effect(AgentRuntime, make(sessionsDir, schedules));

const agentError = (message: string, cause: unknown) =>
  new AgentError({
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });

const promiseBoundary = <A>(message: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => agentError(message, cause),
  });

const syncBoundary = <A>(message: string, evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) => agentError(message, cause),
  });

const ignoreCleanupFailure = <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logError(message, Cause.pretty(cause))),
  );

const closeManagerAfterFailure = (manager: OmpSessionManager.SessionManager, error: AgentError) =>
  ignoreCleanupFailure(
    "Failed to close OMP session manager after startup failure",
    promiseBoundary("Failed to close OMP session manager", () => manager.close()),
  ).pipe(Effect.andThen(Effect.fail(error)));

const disposeSessionAfterFailure = (session: OmpAgentSession.AgentSession, error: AgentError) =>
  ignoreCleanupFailure(
    "Failed to dispose OMP session after subscription failure",
    promiseBoundary("Failed to dispose OMP session", () => session.dispose()),
  ).pipe(Effect.andThen(Effect.fail(error)));

const normalizeShakeResult = (result: OmpShake.ShakeResult): ShakeResult => {
  switch (result.mode) {
    case "elide":
      return {
        mode: result.mode,
        toolResultsDropped: result.toolResultsDropped,
        blocksDropped: result.blocksDropped,
        tokensFreed: result.tokensFreed,
      };
    case "images":
      return {
        mode: result.mode,
        imagesDropped: result.imagesDropped ?? 0,
        tokensFreed: result.tokensFreed,
      };
    case "thinking":
      return {
        mode: result.mode,
        thinkingBlocksDropped: result.thinkingBlocksDropped ?? 0,
        tokensFreed: result.tokensFreed,
      };
    default: {
      const exhaustive: never = result.mode;
      return exhaustive;
    }
  }
};

const normalizeContextUsage = (
  result: ReturnType<OmpAgentSession.AgentSession["getContextBreakdown"]>,
): ContextUsage => {
  if (result === undefined || !Number.isFinite(result.contextWindow) || result.contextWindow <= 0) {
    return { kind: "unavailable" };
  }
  return {
    kind: "available",
    contextWindow: result.contextWindow,
    usedTokens: result.usedTokens,
    systemPromptTokens: result.systemPromptTokens,
    systemToolsTokens: result.systemToolsTokens,
    systemContextTokens: result.systemContextTokens,
    skillsTokens: result.skillsTokens,
    messagesTokens: result.messagesTokens,
  };
};

const makeFactory = (
  sessionsDir: AbsolutePath,
  path: Path.Path,
  chats: ChatRepository["Service"],
  authStorage: Awaited<ReturnType<typeof OmpSdk.discoverAuthStorage>>,
  modelRegistry: OmpModelRegistry.ModelRegistry,
  schedules: Schedule.Schedules["Service"],
): SessionFactory => ({
  open: Effect.fn("OmpSession.open")(function* (chatId, emit) {
    const maybeChat = yield* chats
      .findById(chatId)
      .pipe(Effect.mapError((error) => agentError("Failed to resolve chat", error)));
    if (Option.isNone(maybeChat)) {
      return yield* new AgentError({ message: "Chat not found" });
    }

    const chat = maybeChat.value;
    const sessionFile = path.join(sessionsDir, `${chatId}.jsonl`);
    const settings = yield* promiseBoundary("Failed to load OMP settings", () =>
      OmpSettings.Settings.loadIsolated({ cwd: chat.cwd }),
    );
    yield* syncBoundary("Failed to isolate OMP session settings", () => {
      settings.override("async.enabled", false);
      settings.override("title.refreshOnReplan", false);
    });

    const manager = yield* promiseBoundary("Failed to open OMP session journal", () =>
      OmpSessionManager.SessionManager.open(sessionFile, sessionsDir, undefined, {
        initialCwd: chat.cwd,
        suppressBreadcrumb: true,
      }),
    );
    const created = yield* promiseBoundary("Failed to create OMP session", () =>
      OmpSdk.createAgentSession({
        cwd: chat.cwd,
        sessionManager: manager,
        settings,
        authStorage,
        modelRegistry,
        agentRegistry: new OmpAgentRegistry.AgentRegistry(),
        hasUI: false,
        extensions: [
          makeScheduleExtension({
            caller: { chatId: chat.id, workspaceId: chat.workspaceId },
            schedules,
          }),
        ],
      }),
    ).pipe(Effect.catch((error) => closeManagerAfterFailure(manager, error)));

    const titleFlow = makeExchangeTitleFlow({
      history: created.session.messages,
      sendPrompt: makeOmpPromptSender(created.session),
      generateTitle: (exchange, systemPrompt) =>
        created.session.generateTitle(exchange, systemPrompt),
      getTitleSource: () => created.session.sessionManager.titleSource,
      setSessionName: (title, source) => created.session.setSessionName(title, source),
      getSessionName: () => created.session.sessionName,
      emitTitleChanged: (title) => emit({ type: "title-changed", title }),
    });

    const unsubscribe = yield* syncBoundary("Failed to subscribe to OMP session events", () =>
      created.session.subscribe((event) => {
        const normalized = normalizeAgentEvent(event);
        if (normalized === undefined) return;
        emit(normalized);
        titleFlow.observe(normalized);
      }),
    ).pipe(Effect.catch((error) => disposeSessionAfterFailure(created.session, error)));

    const opened: OpenedSession = {
      session: created.session,
      sendPrompt: titleFlow.sendPrompt,
      shake: (mode) => created.session.shake(mode).then(normalizeShakeResult),
      contextUsage: () => normalizeContextUsage(created.session.getContextBreakdown()),
      appendAssistantMessage: async (message) => {
        created.session.sessionManager.appendMessage(message);
        created.session.agent.appendMessage(message);
        await created.session.sessionManager.flush();
      },
      unsubscribe,
    };
    return opened;
  }),
});
