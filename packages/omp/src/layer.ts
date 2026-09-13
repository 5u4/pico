import * as OmpModelRegistry from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import * as OmpRuntimeInit from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import * as OmpAgentRegistry from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as OmpSdk from "@oh-my-pi/pi-coding-agent/sdk";
import type * as OmpAgentSession from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as OmpSessionManager from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type * as OmpShake from "@oh-my-pi/pi-coding-agent/session/shake-types";
import { AgentRuntime, type ContextUsage, type ShakeResult } from "@pico/contract/agent-runtime";
import { BranchNaming, type BranchNamingHandler } from "@pico/contract/branch-naming";
import type * as Chat from "@pico/contract/chat-model";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import type { BrowserConfig, PicoPaths } from "@pico/contract/config";
import type { AgentError } from "@pico/contract/errors";
import type { AbsolutePath } from "@pico/contract/path";
import type * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { makeAgentBrowserExtension } from "./agent-browser/extension.ts";
import { type AgentBrowserManager, makeAgentBrowserManager } from "./agent-browser/manager.ts";
import { agentError } from "./agent-error.ts";
import { normalizeAgentEvent, normalizeTranscript } from "./agent-event.ts";
import { makeExchangeTitleFlow } from "./exchange-title.ts";
import { makeOmpPromptSender } from "./omp-prompt-sender.ts";
import { make as makeScheduleExtension } from "./schedule-extension.ts";
import {
  makeSessionPool,
  type OpenedSession,
  type SessionFactory,
  type SessionHandle,
} from "./session-pool.ts";
import { prepareSessionSettings } from "./session-settings.ts";

interface RuntimeOptions {
  readonly paths: Pick<PicoPaths, "root" | "sessionsDir">;
  readonly schedules: Schedule.Schedules["Service"];
  readonly browser: BrowserConfig;
}

export const make = Effect.fn("AgentRuntime.make")(function* ({
  paths,
  schedules,
  browser,
}: RuntimeOptions) {
  const { sessionsDir } = paths;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const chatSessionContext = yield* ChatSessionContext;
  const branchNaming = yield* BranchNaming;

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
  let browsers: AgentBrowserManager | undefined;
  switch (browser.externalBrowser) {
    case "off":
      break;
    case "agent-browser":
      browsers = yield* Effect.acquireRelease(
        promiseBoundary("Failed to initialize Pico browsers", () =>
          makeAgentBrowserManager({ root: paths.root, idleTimeoutMs: browser.idleTimeoutMs }),
        ),
        (manager) =>
          ignoreCleanupFailure(
            "Failed to close Pico browsers",
            promiseBoundary("Failed to close Pico browsers", () => manager.dispose()),
          ),
      );
      break;
    default: {
      const exhaustive: never = browser.externalBrowser;
      return exhaustive;
    }
  }

  const pool = yield* makeSessionPool({
    factory: makeFactory(
      sessionsDir,
      path,
      fileSystem,
      crypto,
      chatSessionContext,
      authStorage,
      modelRegistry,
      schedules,
      branchNaming.handle,
      browsers,
    ),
    loadTranscript,
  });

  return AgentRuntime.of({
    events: pool.events,
    drain: pool.drain,
    transcript: pool.transcript,
    send: pool.send,
    askBtw: pool.askBtw,
    sendCaptured: pool.sendCaptured,
    deliver: pool.deliver,
    publish: pool.publish,
    close: Effect.fn("AgentRuntime.close")(function* (chatId: Chat.ChatId) {
      if (browsers === undefined) return yield* pool.close(chatId);
      const closing = browsers.closeChat(chatId).then(
        () => Exit.void,
        (cause) => Exit.fail(agentError("Failed to close chat browsers", cause)),
      );
      const closed = yield* pool.close(chatId).pipe(Effect.exit);
      const browserClosed = yield* Effect.promise(() => closing);
      return yield* Exit.asVoidAll([closed, browserClosed]);
    }, Effect.uninterruptible),
    abort: pool.abort,
    contextUsage: pool.contextUsage,
    shake: pool.shake,
  });
});

export const layer = (options: RuntimeOptions) => Layer.effect(AgentRuntime, make(options));

export const makeSessionHandle = (
  session: SessionHandle,
  settleSender: () => Promise<void>,
): SessionHandle => ({
  get isStreaming() {
    return session.isStreaming;
  },
  waitForIdle: () => session.waitForIdle(),
  settleInFlightMessagePersistence: () => session.settleInFlightMessagePersistence(),
  abort: (options) => session.abort(options),
  beginDispose: () => session.beginDispose(),
  dispose: async () => {
    try {
      session.beginDispose();
      await settleSender();
    } finally {
      await session.dispose();
    }
  },
});

export const makeBtw =
  (session: Pick<OmpAgentSession.AgentSession, "runEphemeralTurn">) =>
  async (question: string, signal: AbortSignal): Promise<string> => {
    const result = await session.runEphemeralTurn({
      promptText: `<btw>
Ephemeral side question for the current session.
Answer briefly and directly using the conversation context already provided.
Never use tools or ask follow-up questions.
Question:
${question}
</btw>`,
      signal,
    });
    return result.replyText;
  };

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
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logError(message).pipe(
            Effect.annotateLogs({
              component: "omp",
              operation: "cleanup",
              failureKind: Cause.hasDies(cause) ? "defect" : "operation",
            }),
          ),
    ),
  );

const closeManagerAfterFailure = (manager: OmpSessionManager.SessionManager, error: AgentError) =>
  ignoreCleanupFailure(
    "Failed to close OMP session manager after startup failure",
    promiseBoundary("Failed to close OMP session manager", () => manager.close()),
  ).pipe(Effect.andThen(Effect.fail(error)));

const disposeSessionAfterFailure = (session: OmpAgentSession.AgentSession, error: AgentError) =>
  ignoreCleanupFailure(
    "Failed to dispose OMP session after startup failure",
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
  fileSystem: FileSystem.FileSystem,
  crypto: Crypto.Crypto,
  chatSessionContext: ChatSessionContext["Service"],
  authStorage: Awaited<ReturnType<typeof OmpSdk.discoverAuthStorage>>,
  modelRegistry: OmpModelRegistry.ModelRegistry,
  schedules: Schedule.Schedules["Service"],
  handleBranchNaming: BranchNamingHandler,
  browsers: AgentBrowserManager | undefined,
): SessionFactory => ({
  open: Effect.fn("OmpSession.open")(function* (chatId, emit) {
    const runEffect = Effect.runPromiseWith(yield* Effect.context<never>());
    const { chat, platform, appendSystemPrompt } = yield* chatSessionContext.resolve(chatId);
    const sessionFile = path.join(sessionsDir, `${chat.id}.jsonl`);
    const settings = yield* prepareSessionSettings(
      chat.cwd,
      platform,
      browsers === undefined ? "off" : "agent-browser",
    );

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
        appendSystemPrompt,
        authStorage,
        modelRegistry,
        agentRegistry: new OmpAgentRegistry.AgentRegistry(),
        hasUI: false,
        ...(browsers === undefined
          ? {}
          : {
              mcpConfigLoader: (cwd, options) =>
                loadAllMCPConfigs(cwd, { ...options, filterBrowser: true }),
            }),
        extensions: [
          ...(browsers === undefined
            ? []
            : [
                makeAgentBrowserExtension({
                  manager: browsers,
                  chatId: chat.id,
                  rootSessionId: manager.getSessionId(),
                }),
              ]),
          makeScheduleExtension({
            caller: { chatId: chat.id, workspaceId: chat.workspaceId },
            runEffect,
            schedules,
          }),
        ],
      }),
    ).pipe(
      Effect.catch((error) => closeManagerAfterFailure(manager, error)),
      Effect.annotateLogs({
        chatId: chat.id,
        workspaceId: chat.workspaceId,
        phase: "session-create-rollback",
      }),
    );

    const sendPrompt = makeOmpPromptSender(created.session, fileSystem, path, crypto, {
      chatId: chat.id,
      runEffect,
    });
    const titleFlow = makeExchangeTitleFlow({
      chatId: chat.id,
      runEffect,
      handleBranchNaming,
      history: created.session.messages,
      sendPrompt,
      generateTitle: (exchange, systemPrompt) =>
        created.session.generateTitle(exchange, systemPrompt),
      getTitleSource: () => created.session.sessionManager.titleSource,
      setSessionName: (title, source) => created.session.setSessionName(title, source),
      getSessionName: () => created.session.sessionName,
      emitTitleChanged: (title) => emit({ type: "title-changed", title }),
    });

    const unsubscribe = yield* syncBoundary("Failed to subscribe to OMP session events", () =>
      created.session.subscribe((event) => {
        try {
          const normalized = normalizeAgentEvent(event);
          if (normalized === undefined) return;
          emit(normalized);
          titleFlow.observe(normalized);
        } catch (cause) {
          void runEffect(
            Effect.logWarning(
              "OMP event callback failed",
              Cause.fail(agentError("Failed to process OMP session event", cause)),
            ).pipe(
              Effect.annotateLogs({
                component: "omp",
                operation: "sdk-callback",
                chatId: chat.id,
                workspaceId: chat.workspaceId,
                eventType: event.type,
              }),
            ),
          );
        }
      }),
    ).pipe(
      Effect.catch((error) => disposeSessionAfterFailure(created.session, error)),
      Effect.annotateLogs({
        chatId: chat.id,
        workspaceId: chat.workspaceId,
        phase: "subscription-rollback",
      }),
    );

    const runLog = Effect.runSyncWith(yield* Effect.context());
    yield* promiseBoundary("Failed to initialize OMP extensions", () =>
      OmpRuntimeInit.initializeExtensions(created.session, {
        mode: "print",
        reportSendError: (action, error) => {
          runLog(
            Effect.logError("OMP extension send failed").pipe(
              Effect.annotateLogs({
                component: "omp",
                operation: "extension-send",
                chatId: chat.id,
                workspaceId: chat.workspaceId,
                action,
                error: error.message,
                stack: error.stack,
              }),
            ),
          );
        },
        reportRuntimeError: (error) => {
          runLog(
            Effect.logError("OMP extension runtime failed").pipe(
              Effect.annotateLogs({
                component: "omp",
                operation: "extension-runtime",
                chatId: chat.id,
                workspaceId: chat.workspaceId,
                ...error,
              }),
            ),
          );
        },
      }),
    ).pipe(
      Effect.catch((error) =>
        ignoreCleanupFailure(
          "Failed to unsubscribe after OMP startup failure",
          syncBoundary("Failed to unsubscribe from OMP session events", unsubscribe),
        ).pipe(Effect.andThen(disposeSessionAfterFailure(created.session, error))),
      ),
    );

    const opened: OpenedSession = {
      session: makeSessionHandle(created.session, sendPrompt.settle),
      sendPrompt: titleFlow.sendPrompt,
      askBtw: makeBtw(created.session),
      shake: (mode) => created.session.shake(mode).then(normalizeShakeResult),
      contextUsage: () => normalizeContextUsage(created.session.getContextBreakdown()),
      appendAssistantMessage: async (message) => {
        created.session.sessionManager.appendMessage(message);
        created.session.agent.appendMessage(message);
        await created.session.sessionManager.flush();
      },
      unsubscribe,
    };
    yield* Effect.logDebug("OMP session ready").pipe(
      Effect.annotateLogs({
        component: "omp",
        operation: "session-open",
        chatId: chat.id,
        workspaceId: chat.workspaceId,
        platform,
      }),
    );
    return opened;
  }),
});
