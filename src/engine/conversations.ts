import type { Database } from "bun:sqlite";
import { withContext } from "@logtape/logtape";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { errAsync, okAsync, type Result, ResultAsync } from "neverthrow";
import { log } from "../util/log";
import { errMessage } from "../util/result";
import {
  assistantReplyText,
  type Message,
  OLDER_PAGE,
  olderWindow,
  SNAPSHOT_TAIL,
  tailWindow,
  toMessages,
  toStreamMessage,
} from "./message";
import {
  getConversation,
  setConversationTitle,
  setProvisionalTitle,
} from "./registry";
import { provisionalTitle, titleContext } from "./title";

const logger = log(["engine"]);

export interface SessionStateLike {
  messages: AgentMessage[];
  streamMessage: AgentMessage | null;
  isStreaming: boolean;
}

export interface AsyncJobActivity {
  running: { id: string }[];
  delivery: { queued: number };
}

export interface SessionLike {
  readonly state: SessionStateLike;
  prompt(text: string): Promise<boolean>;
  abort(): Promise<unknown>;
  sendCustomMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
    },
    options: { triggerTurn: false },
  ): Promise<boolean>;
  readonly sessionManager: { ensureOnDisk(): Promise<void> };
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  readonly sessionName: string | undefined;
  setSessionName(name: string, source?: "auto" | "user"): Promise<boolean>;
  getContextUsage(): ContextTokens | undefined;
  getContextBreakdown(): ContextCategoryTokens | undefined;
  getSessionStats(): { cost: number };
  getAsyncJobSnapshot(): AsyncJobActivity | null;
}

interface ContextTokens {
  tokens: number;
  contextWindow: number;
  percent: number;
}

interface ContextCategoryTokens {
  systemPromptTokens: number;
  systemToolsTokens: number;
  systemContextTokens: number;
  skillsTokens: number;
  messagesTokens: number;
}

export interface ContextUsageBreakdown {
  systemPrompt: number;
  systemTools: number;
  systemContext: number;
  skills: number;
  messages: number;
}

export interface ContextUsageInfo {
  tokens: number;
  contextWindow: number;
  percent: number;
  cost: number;
  breakdown: ContextUsageBreakdown | null;
}

export function computeContextUsage(
  session: SessionLike,
): ContextUsageInfo | undefined {
  const usage = session.getContextUsage();
  if (!usage) return undefined;
  const breakdown = session.getContextBreakdown();
  const stats = session.getSessionStats();
  return {
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    percent: usage.percent,
    cost: stats.cost,
    breakdown: breakdown
      ? {
          systemPrompt: breakdown.systemPromptTokens,
          systemTools: breakdown.systemToolsTokens,
          systemContext: breakdown.systemContextTokens,
          skills: breakdown.skillsTokens,
          messages: breakdown.messagesTokens,
        }
      : null,
  };
}

export interface SessionsPort<S extends SessionLike = SessionLike> {
  get(id: string): S | undefined;
  open(id: string, opts: { cwd: string }): Promise<Result<S, string>>;
  close(id: string): Promise<void>;
  isPending(id: string): boolean;
}

export type SubscribeMode = "live" | "settled";

export type TurnEvent =
  | {
      kind: "snapshot";
      messages: Message[];
      streaming: boolean;
      usage: ContextUsageInfo | null;
      hasMore: boolean;
    }
  | { kind: "delta"; message: Message | null; streaming: boolean }
  | { kind: "title"; title: string };

export type EngineDeps<S extends SessionLike = SessionLike> = {
  db: Database;
  sessions: SessionsPort<S>;
  autoTitle: (session: S, text: string) => Promise<string | null>;
  onTitleSettled?: (conversationId: string, title: string) => Promise<void>;
};

type Subscriber = {
  mode: SubscribeMode;
  listener: (event: TurnEvent) => void;
};

const IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

export class Engine<S extends SessionLike = SessionLike> {
  private readonly deps: EngineDeps<S>;
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly bridged = new Set<string>();
  private readonly settleListeners = new Set<
    (conversationId: string) => void
  >();
  private readonly bridgeUnsub = new Map<string, () => void>();
  private readonly activeTurns = new Set<string>();
  private readonly lastActivity = new Map<string, number>();
  private sweepTimer: Timer | undefined;

  constructor(deps: EngineDeps<S>) {
    this.deps = deps;
  }

  get(conversationId: string): S | undefined {
    return this.deps.sessions.get(conversationId);
  }

  onSettled(listener: (conversationId: string) => void): () => void {
    this.settleListeners.add(listener);
    return () => this.settleListeners.delete(listener);
  }

  subscribe(
    conversationId: string,
    cwd: string,
    mode: SubscribeMode,
    listener: (event: TurnEvent) => void,
  ): { unsubscribe: () => void; opened: ResultAsync<void, string> } {
    const subscriber: Subscriber = { mode, listener };
    let set = this.subscribers.get(conversationId);
    if (!set) {
      set = new Set();
      this.subscribers.set(conversationId, set);
    }
    set.add(subscriber);
    const opened = this.ensureOpen(conversationId, cwd);
    return {
      unsubscribe: () => {
        const current = this.subscribers.get(conversationId);
        if (!current) return;
        current.delete(subscriber);
        if (current.size === 0) this.subscribers.delete(conversationId);
      },
      opened,
    };
  }

  snapshot(conversationId: string):
    | {
        messages: Message[];
        streaming: boolean;
        usage: ContextUsageInfo | null;
        hasMore: boolean;
      }
    | undefined {
    const session = this.deps.sessions.get(conversationId);
    if (!session) return undefined;
    const evt = this.buildSnapshot(session, session.state.isStreaming);
    return {
      messages: evt.messages,
      streaming: evt.streaming,
      usage: evt.usage,
      hasMore: evt.hasMore,
    };
  }

  loadOlder(
    conversationId: string,
    beforeId: string,
  ): { messages: Message[]; hasMore: boolean } | undefined {
    const session = this.deps.sessions.get(conversationId);
    if (!session) return undefined;
    const all = toMessages(session.state.messages);
    return olderWindow(all, beforeId, OLDER_PAGE);
  }

  private buildSnapshot(
    session: S,
    streaming: boolean,
  ): Extract<TurnEvent, { kind: "snapshot" }> {
    const state = session.state;
    const stream = state.streamMessage ? [state.streamMessage] : [];
    const { window, hasMore } = tailWindow(
      toMessages([...state.messages, ...stream]),
      SNAPSHOT_TAIL,
    );
    return {
      kind: "snapshot",
      messages: window,
      streaming,
      usage: computeContextUsage(session) ?? null,
      hasMore,
    };
  }

  prompt(
    conversationId: string,
    cwd: string,
    text: string,
  ): ResultAsync<void, string> {
    return this.ensureOpen(conversationId, cwd).andThen(() => {
      const session = this.deps.sessions.get(conversationId);
      if (!session) {
        logger.warning("session unavailable after open for {conversationId}", {
          conversationId,
        });
        return errAsync<void, string>(
          "conversation session unavailable; retry your message",
        );
      }
      const workspaceId =
        getConversation(this.deps.db, conversationId)?.workspaceId ?? "unknown";
      return withContext({ conversationId, workspaceId }, () => {
        logger.info("turn started ({chars} chars)", { chars: text.length });
        const firstTurn = this.seedProvisionalTitle(conversationId, text);
        this.activeTurns.add(conversationId);
        this.touch(conversationId);
        return ResultAsync.fromPromise(
          session
            .prompt(text)
            .then(() => {
              logger.info("turn completed");
              this.emitSettled(conversationId);
              if (firstTurn)
                void this.autoTitleFromReply(
                  conversationId,
                  session,
                  text,
                ).catch((e: unknown) => {
                  logger.error("auto-title failed: {error}", { error: e });
                });
            })
            .finally(() => {
              this.activeTurns.delete(conversationId);
              this.touch(conversationId);
            }),
          (e) => {
            logger.error("turn failed: {error}", { error: e });
            return errMessage(e);
          },
        );
      });
    });
  }

  abort(conversationId: string): ResultAsync<void, string> {
    const session = this.deps.sessions.get(conversationId);
    if (!session) return okAsync<void, string>(undefined);
    logger.info("turn aborted for {conversationId}", { conversationId });
    return ResultAsync.fromPromise(
      session.abort().then(() => undefined),
      errMessage,
    );
  }

  record(
    conversationId: string,
    cwd: string,
    customType: string,
    text: string,
  ): ResultAsync<void, string> {
    return this.ensureOpen(conversationId, cwd).andThen(() => {
      const session = this.deps.sessions.get(conversationId);
      if (!session) {
        return errAsync<void, string>(
          "conversation session unavailable; retry",
        );
      }
      return ResultAsync.fromPromise(
        session
          .sendCustomMessage(
            { customType, content: text, display: true },
            { triggerTurn: false },
          )
          .then(() => session.sessionManager.ensureOnDisk())
          .then(() => {
            this.broadcastSnapshot(conversationId, session);
          }),
        (e) => {
          logger.error("record failed: {error}", { error: e });
          return errMessage(e);
        },
      );
    });
  }

  private broadcastSnapshot(conversationId: string, session: S): void {
    const evt = this.buildSnapshot(session, session.state.isStreaming);
    for (const target of this.subscribers.get(conversationId) ?? [])
      target.listener(evt);
  }

  private emitSettled(conversationId: string): void {
    for (const listener of this.settleListeners) {
      try {
        listener(conversationId);
      } catch (e) {
        logger.error("settle listener failed: {error}", { error: e });
      }
    }
  }

  private ensureOpen(
    conversationId: string,
    cwd: string,
  ): ResultAsync<void, string> {
    if (this.deps.sessions.get(conversationId)) {
      this.touch(conversationId);
      return okAsync<void, string>(undefined);
    }
    return new ResultAsync(
      this.deps.sessions.open(conversationId, { cwd }),
    ).andThen((session) => {
      if (!this.bridged.has(conversationId)) {
        this.bridged.add(conversationId);
        const unsubscribe = session.subscribe((event) =>
          this.dispatch(conversationId, event),
        );
        this.bridgeUnsub.set(conversationId, unsubscribe);
      }
      this.touch(conversationId);
      return okAsync<void, string>(undefined);
    });
  }

  private dispatch(conversationId: string, event: AgentSessionEvent): void {
    const session = this.deps.sessions.get(conversationId);
    if (!session) return;
    this.touch(conversationId);
    const state = session.state;
    const streaming = state.isStreaming;
    const targets = this.subscribers.get(conversationId);
    if (!targets || targets.size === 0) return;

    if (event.type === "message_update") {
      const tail = state.streamMessage;
      const message = tail ? toStreamMessage(state.messages, tail) : null;
      const evt: TurnEvent = { kind: "delta", message, streaming };
      for (const target of targets)
        if (target.mode === "live") target.listener(evt);
      return;
    }

    const evt = this.buildSnapshot(session, streaming);
    for (const target of targets) {
      if (target.mode === "live" || !streaming) target.listener(evt);
    }
  }

  private broadcastTitle(conversationId: string, title: string): void {
    const evt: TurnEvent = { kind: "title", title };
    for (const target of this.subscribers.get(conversationId) ?? [])
      target.listener(evt);
  }

  private seedProvisionalTitle(conversationId: string, text: string): boolean {
    if (getConversation(this.deps.db, conversationId)?.title != null)
      return false;
    const provisional = provisionalTitle(text);
    if (
      provisional &&
      setProvisionalTitle(this.deps.db, conversationId, provisional)
    ) {
      this.broadcastTitle(conversationId, provisional);
    }
    return true;
  }

  private async autoTitleFromReply(
    conversationId: string,
    session: S,
    prompt: string,
  ): Promise<void> {
    const reply = assistantReplyText(session.state.messages);
    const context = titleContext(prompt, reply);
    const title = await this.deps.autoTitle(session, context).catch(() => null);
    if (!title) return;
    if (!setConversationTitle(this.deps.db, conversationId, title)) return;
    await session.setSessionName(title, "auto").catch((e: unknown) => {
      logger.error("title sync to omp session failed: {error}", { error: e });
    });
    if (this.deps.onTitleSettled) {
      await this.deps
        .onTitleSettled(conversationId, title)
        .catch((e: unknown) => {
          logger.error("title-settled hook failed: {error}", { error: e });
        });
    }
    this.broadcastTitle(conversationId, title);
  }

  start(intervalMs: number = SWEEP_MS): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  sweep(now: number = Date.now()): void {
    for (const conversationId of [...this.bridged]) {
      if (this.reapable(conversationId, now)) void this.release(conversationId);
    }
  }

  async release(conversationId: string): Promise<void> {
    const unsubscribe = this.bridgeUnsub.get(conversationId);
    try {
      unsubscribe?.();
    } catch (e) {
      logger.error("bridge unsubscribe failed for {conversationId}: {error}", {
        conversationId,
        error: e,
      });
    }
    try {
      await this.deps.sessions.close(conversationId);
    } catch (e) {
      logger.error("session release failed for {conversationId}: {error}", {
        conversationId,
        error: e,
      });
      return;
    }
    this.bridged.delete(conversationId);
    this.bridgeUnsub.delete(conversationId);
    this.lastActivity.delete(conversationId);
    logger.info("session released for {conversationId}", { conversationId });
  }

  async releaseIfIdle(conversationId: string): Promise<void> {
    if (this.hasViewers(conversationId)) return;
    if (this.busy(conversationId)) return;
    await this.release(conversationId);
  }

  private reapable(conversationId: string, now: number): boolean {
    if (this.hasViewers(conversationId)) return false;
    if (this.busy(conversationId)) return false;
    const last = this.lastActivity.get(conversationId) ?? 0;
    return now - last > IDLE_MS;
  }

  private hasViewers(conversationId: string): boolean {
    return (this.subscribers.get(conversationId)?.size ?? 0) > 0;
  }

  private busy(conversationId: string): boolean {
    if (this.activeTurns.has(conversationId)) return true;
    if (this.deps.sessions.isPending(conversationId)) return true;
    const session = this.deps.sessions.get(conversationId);
    if (!session) return false;
    return session.state.isStreaming || this.hasAsyncWake(session);
  }

  private hasAsyncWake(session: S): boolean {
    const snap = session.getAsyncJobSnapshot();
    if (!snap) return false;
    return snap.running.length > 0 || snap.delivery.queued > 0;
  }

  private touch(conversationId: string): void {
    this.lastActivity.set(conversationId, Date.now());
  }
}
