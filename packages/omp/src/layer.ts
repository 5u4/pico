import * as OmpModelRegistry from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getSkillSlashCommandName } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import * as OmpRuntimeInit from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import * as OmpAgentRegistry from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as OmpSdk from "@oh-my-pi/pi-coding-agent/sdk";
import type * as OmpAgentSession from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import * as OmpSessionContext from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import * as OmpSessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as OmpSessionManager from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type * as OmpShake from "@oh-my-pi/pi-coding-agent/session/shake-types";
import {
  sameMessageContent,
  sessionMessagePersistenceKey,
} from "@oh-my-pi/pi-coding-agent/session/turn-persistence";
import * as History from "@pico/contract/agent-history";
import { AgentPrompt } from "@pico/contract/agent-message";
import { AgentRuntime, type ContextUsage, type ShakeResult } from "@pico/contract/agent-runtime";
import { BranchNaming, type BranchNamingHandler } from "@pico/contract/branch-naming";
import type * as Chat from "@pico/contract/chat-model";
import { ChatSessionContext } from "@pico/contract/chat-session-context";
import type { BrowserConfig, PicoPaths } from "@pico/contract/config";
import { AgentError } from "@pico/contract/errors";
import type { AbsolutePath } from "@pico/contract/path";
import type * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeAgentBrowserExtension } from "./agent-browser/extension.ts";
import { type AgentBrowserManager, makeAgentBrowserManager } from "./agent-browser/manager.ts";
import { agentError } from "./agent-error.ts";
import {
  normalizeAgentEvent,
  normalizeHistoryPreview,
  normalizeMessage,
  normalizeTodo,
  normalizeTranscript,
} from "./agent-event.ts";
import { makeExchangeTitleFlow } from "./exchange-title.ts";
import { makeOmpPromptSender } from "./omp-prompt-sender.ts";
import { make as makeScheduleExtension } from "./schedule-extension.ts";
import {
  makeSessionPool,
  type OpenedSession,
  type SessionFactory,
  type SessionHandle,
} from "./session-pool.ts";
import {
  findRestorableModelChange,
  loadAvailableModels,
  loadCurrentModel,
  prepareSessionSettings,
} from "./session-settings.ts";

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
    const snapshot = yield* promiseBoundary("Failed to read OMP transcript", () =>
      OmpSessionLoader.loadSessionSnapshotReadOnly(sessionFile),
    );
    return yield* syncBoundary("Failed to normalize OMP transcript", () => ({
      messages: normalizeTranscript(snapshot.messages),
      todo: normalizeTodo(snapshot.todoPhases),
      historyRevision: History.HistoryRevision.make(snapshot.historyRevision),
    }));
  });

  const availableModels = (cwd: AbsolutePath) => loadAvailableModels(modelRegistry, cwd);
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
    loadHistory: Effect.fn("OmpSession.loadHistory")(function* (chatId, query) {
      const journal = yield* promiseBoundary("Failed to read OMP history", () =>
        OmpSessionLoader.loadSessionHistoryReadOnly(path.join(sessionsDir, `${chatId}.jsonl`)),
      );
      return yield* syncBoundary("Failed to normalize OMP history", () => ({
        ...normalizeHistory(journal.entries, query),
        activeLeafId:
          journal.activeLeafId === null ? null : History.HistoryEntryId.make(journal.activeLeafId),
        revision: History.HistoryRevision.make(journal.revision),
        version: History.HistoryVersion.make(journal.version),
      }));
    }),
    loadHistoryPreview: Effect.fn("OmpSession.loadHistoryPreview")(function* (input) {
      const journal = yield* promiseBoundary("Failed to read OMP history preview", () =>
        OmpSessionLoader.loadSessionHistoryReadOnly(
          path.join(sessionsDir, `${input.chatId}.jsonl`),
        ),
      );
      return yield* syncBoundary("Failed to project OMP history preview", () =>
        projectHistoryPreview(journal, input.targetId),
      );
    }),
    loadCurrentModel: Effect.fn("OmpSession.readCurrentModel")(function* (chatId) {
      const { chat } = yield* chatSessionContext.resolve(chatId);
      return yield* loadCurrentModel(
        modelRegistry,
        chat.cwd,
        path.join(sessionsDir, `${chatId}.jsonl`),
      );
    }),
  });

  return AgentRuntime.of({
    events: pool.events,
    drain: pool.drain,
    transcript: pool.transcript,
    history: pool.history,
    previewHistory: pool.previewHistory,
    navigateHistory: pool.navigateHistory,
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
    availableModels,
    availableSkills: pool.availableSkills,
    switchModel: pool.switchModel,
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

export const makeShake =
  (session: Pick<OmpAgentSession.AgentSession, "shake">): OpenedSession["shake"] =>
  (mode, signal) =>
    session.shake(mode, { signal }).then(normalizeShakeResult);

export const makeSwitchModel =
  (
    session: Pick<OmpAgentSession.AgentSession, "getAvailableModels" | "setModelTemporary">,
  ): OpenedSession["switchModel"] =>
  async (ref) => {
    const model = session
      .getAvailableModels()
      .find((candidate) => candidate.provider === ref.provider && candidate.id === ref.id);
    if (model === undefined) throw new Error("The selected model is no longer available");
    await session.setModelTemporary(model);
    return { provider: model.provider, id: model.id, name: model.name };
  };

// History requests project the selected journal branch without opening a session.
export const projectHistoryPreview = (
  journal: Awaited<ReturnType<typeof OmpSessionLoader.loadSessionHistoryReadOnly>>,
  targetId: History.HistoryEntryId,
): History.HistoryPreview => {
  const entry = journal.entries.find((candidate) => candidate.id === targetId);
  if (entry === undefined) throw new Error("History target no longer exists");
  const destination = OmpSessionContext.resolveTreeNavigationTarget(entry, journal.activeLeafId);
  const context = OmpSessionContext.buildSessionContext(journal.entries, targetId, undefined, {
    transcript: true,
    collapseCompactedHistory: true,
    keepDanglingToolCalls: true,
  });
  return {
    targetId,
    version: History.HistoryVersion.make(journal.version),
    destinationLeafId:
      destination.leafId === null ? null : History.HistoryEntryId.make(destination.leafId),
    blocks: normalizeHistoryPreview(context.messages),
  };
};

const decodeRecoveredPrompt = Schema.decodeUnknownSync(AgentPrompt);

export const makeNavigateHistory =
  (
    session: Pick<OmpAgentSession.AgentSession, "navigateTree" | "sessionManager">,
  ): OpenedSession["navigateHistory"] =>
  async (targetId, onReplaced) => {
    const entry = session.sessionManager.getEntry(targetId);
    const recovered =
      entry === undefined
        ? null
        : OmpSessionContext.resolveTreeNavigationTarget(entry, session.sessionManager.getLeafId())
            .draft;
    let draft: AgentPrompt | null = null;
    if (recovered !== null && (recovered.text.trim().length > 0 || recovered.images.length > 0)) {
      try {
        draft = decodeRecoveredPrompt({
          text: recovered.text,
          attachments: recovered.images.map(({ data, mimeType }, index) => ({
            type: "image",
            name: `restored-image-${index + 1}`,
            data,
            mimeType,
          })),
        });
      } catch {
        throw new AgentError({
          message:
            "Cannot restore this prompt because its images are unsupported, malformed, or exceed attachment limits. Choose another history point and attach supported images in a new prompt.",
        });
      }
    }
    const result = await session.navigateTree(targetId, {
      summarize: false,
      allowAskReopen: false,
      requireIdle: true,
      onHistoryReplaced: onReplaced,
    });
    if (result.busy) return { kind: "busy" };
    if (result.cancelled) return { kind: "cancelled" };
    return {
      kind: "applied",
      draft: result.editorText === undefined && result.editorImages === undefined ? null : draft,
    };
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

export const makeSessionObservation = (
  session: Pick<
    OmpAgentSession.AgentSession,
    "sessionManager" | "settleInFlightMessagePersistence" | "subscribe"
  >,
  emit: Parameters<SessionFactory["open"]>[1],
  onError: (cause: unknown, event: AgentSessionEvent) => void,
): Pick<OpenedSession, "historyBoundary" | "settleHistory" | "unsubscribe"> => {
  const manager = session.sessionManager;
  const pendingPersistence = new Set<OmpAgentSession.AgentSession["messages"][number]>();
  let observationFailure: unknown;
  const previousAppendObserver = manager.onEntryAppended;
  const observeAppend: NonNullable<OmpSessionManager.SessionManager["onEntryAppended"]> = (
    entry,
  ) => {
    if (entry.type === "message") {
      const key = sessionMessagePersistenceKey(entry.message);
      for (const message of pendingPersistence) {
        if (
          key !== undefined &&
          key === sessionMessagePersistenceKey(message) &&
          ((message.role === "assistant" &&
            "messageId" in message &&
            typeof message.messageId === "string" &&
            message.messageId.length > 0) ||
            sameMessageContent(entry.message, message))
        ) {
          pendingPersistence.delete(message);
        }
      }
    }
    previousAppendObserver?.(entry);
  };
  manager.onEntryAppended = observeAppend;
  const settleHistory = async () => {
    if (observationFailure !== undefined) throw observationFailure;
    const pending = Array.from(pendingPersistence);
    await session.settleInFlightMessagePersistence();
    await manager.ensureOnDisk();
    await manager.flush();
    if (pending.length === 0 || pendingPersistence.size === 0) return;
    const entries = manager.getEntries();
    for (const message of pending) {
      if (!pendingPersistence.has(message)) continue;
      const key = sessionMessagePersistenceKey(message);
      if (
        key === undefined ||
        !entries.some(
          (entry) =>
            entry.type === "message" &&
            sessionMessagePersistenceKey(entry.message) === key &&
            ((message.role === "assistant" &&
              "messageId" in message &&
              typeof message.messageId === "string" &&
              message.messageId.length > 0) ||
              sameMessageContent(entry.message, message)),
        )
      ) {
        throw new Error("Published OMP message persistence is not confirmed");
      }
      pendingPersistence.delete(message);
    }
  };
  const unsubscribe = session.subscribe((event) => {
    try {
      const normalized = normalizeAgentEvent(event);
      if (normalized === undefined) return;
      if (event.type === "message_end" && observationFailure === undefined)
        pendingPersistence.add(event.message);
      emit(normalized);
      if (normalized.type === "run-finished")
        void settleHistory().catch((cause) => {
          observationFailure = cause;
          pendingPersistence.clear();
        });
    } catch (cause) {
      observationFailure = cause;
      onError(cause, event);
    }
  });
  return {
    historyBoundary: () => {
      if (observationFailure !== undefined) throw observationFailure;
      return manager.getHistoryVersion();
    },
    settleHistory,
    unsubscribe: () => {
      try {
        unsubscribe();
      } finally {
        pendingPersistence.clear();
        if (manager.onEntryAppended === observeAppend) {
          if (previousAppendObserver === undefined) delete manager.onEntryAppended;
          else manager.onEntryAppended = previousAppendObserver;
        }
      }
    },
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
    yield* promiseBoundary("Failed to restore OMP model selection", async () => {
      const branch = manager.getBranch();
      const latest = branch.findLast((entry) => entry.type === "model_change");
      const selected = findRestorableModelChange(branch);
      if (
        latest?.type === "model_change" &&
        latest.role === "temporary" &&
        latest.resolvedModelIsFallback &&
        selected
      ) {
        manager.appendModelChange(selected.model, selected.role);
        await manager.ensureOnDisk();
        await manager.flush();
      }
    }).pipe(Effect.catch((error) => closeManagerAfterFailure(manager, error)));
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
            caller: () => ({ chatId: chat.id, workspaceId: chat.workspaceId }),
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

    const observation = yield* syncBoundary("Failed to subscribe to OMP session events", () =>
      makeSessionObservation(
        created.session,
        (event) => {
          emit(event);
          titleFlow.observe(event);
        },
        (cause, event) => {
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
        },
      ),
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
          syncBoundary("Failed to unsubscribe from OMP session events", observation.unsubscribe),
        ).pipe(Effect.andThen(disposeSessionAfterFailure(created.session, error))),
      ),
    );

    const opened: OpenedSession = {
      session: makeSessionHandle(created.session, sendPrompt.settle),
      sendPrompt: titleFlow.sendPrompt,
      askBtw: makeBtw(created.session),
      shake: makeShake(created.session),
      switchModel: makeSwitchModel(created.session),
      navigateHistory: makeNavigateHistory(created.session),
      currentModel: () => {
        const model = created.session.model;
        return model ? { provider: model.provider, id: model.id, name: model.name } : null;
      },
      flush: async () => {
        await manager.ensureOnDisk();
        await manager.flush();
      },
      contextUsage: () => normalizeContextUsage(created.session.getContextBreakdown()),
      availableSkills: () => {
        if (!created.session.skillsSettings?.enableSkillCommands) return [];
        return created.session.skills.map((skill) => ({
          name: getSkillSlashCommandName(skill).slice("skill:".length),
          description: skill.description || `Run ${skill.name} skill`,
        }));
      },
      ...observation,
      appendAssistantMessage: async (message) => {
        created.session.sessionManager.appendMessage(message);
        created.session.agent.appendMessage(message);
        await created.session.sessionManager.flush();
      },
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

const historyText = (text: string): string =>
  text
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const normalizeHistory = (
  entries: ReadonlyArray<SessionEntry>,
  search: string,
): Pick<History.HistorySnapshot, "nodes" | "matches"> => {
  const query = search.trim().toLocaleLowerCase();
  const matches: History.HistoryEntryId[] = [];
  const labels = new Map<string, string>();
  const children = new Map<string, SessionEntry[]>();
  for (const entry of entries) {
    if (entry.parentId !== null) {
      const siblings = children.get(entry.parentId);
      if (siblings === undefined) children.set(entry.parentId, [entry]);
      else siblings.push(entry);
    }
    if (entry.type !== "label") continue;
    if (entry.label) labels.set(entry.targetId, historyText(entry.label));
    else labels.delete(entry.targetId);
  }
  const nodes = entries.map((entry) => {
    let kind: History.HistoryNode["kind"] = "metadata";
    let excerpt = entry.type.replaceAll("_", " ");
    if (OmpSessionContext.isTranscriptEntry(entry)) {
      const message = OmpSessionContext.transcriptEntryMessage(entry);
      const normalized = message === undefined ? undefined : normalizeMessage(message);
      if (normalized !== undefined) {
        kind = normalized.role === "tool-result" ? "tool" : normalized.role;
        excerpt = normalized.content
          .map((block) => {
            switch (block.type) {
              case "text":
              case "thinking":
                return block.text;
              case "image":
                return "[Image]";
              case "tool-call":
                return block.name;
              default: {
                const exhaustive: never = block;
                return exhaustive;
              }
            }
          })
          .join(" ");
        if (normalized.role === "tool-result") excerpt = `${normalized.toolName}: ${excerpt}`;
      }
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      kind = "summary";
      excerpt = entry.summary;
    }
    excerpt = historyText(excerpt);
    const entryId = History.HistoryEntryId.make(entry.id);
    const label = labels.get(entry.id);
    if (query.length > 0 && `${label ?? ""} ${excerpt}`.toLocaleLowerCase().includes(query)) {
      matches.push(entryId);
    }
    let target = entry;
    if (kind === "assistant") {
      while (true) {
        const next = children.get(target.id);
        if (next?.length !== 1) break;
        const child = next[0];
        if (child?.type !== "message" || child.message.role !== "toolResult") break;
        target = child;
      }
    }
    return {
      entryId,
      parentId: entry.parentId === null ? null : History.HistoryEntryId.make(entry.parentId),
      defaultTargetId: History.HistoryEntryId.make(target.id),
      kind,
      timestamp: entry.timestamp,
      label: label?.slice(0, 240) ?? null,
      excerpt: excerpt.slice(0, 240),
      visibleByDefault: kind === "user" || kind === "assistant" || kind === "summary",
    };
  });
  return { nodes, matches };
};
