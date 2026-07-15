import type { Database } from "bun:sqlite";
import { withContext } from "@logtape/logtape";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { Result } from "neverthrow";
import { log } from "../util/log";
import { type Message, toMessages, toStreamMessage } from "./message";
import { getConversation, setConversationTitle } from "./registry";

const logger = log(["engine"]);

export interface SessionStateLike {
  messages: AgentMessage[];
  streamMessage: AgentMessage | null;
  isStreaming: boolean;
}

export interface SessionLike {
  readonly state: SessionStateLike;
  prompt(text: string): Promise<boolean>;
  abort(): Promise<unknown>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  readonly sessionName: string | undefined;
  setSessionName(name: string, source?: "auto" | "user"): Promise<boolean>;
}

export interface SessionsPort<S extends SessionLike = SessionLike> {
  get(id: string): S | undefined;
  open(id: string, opts: { cwd: string }): Promise<Result<S, string>>;
}

export type SubscribeMode = "live" | "settled";

export type TurnEvent =
  | { kind: "snapshot"; messages: Message[]; streaming: boolean }
  | { kind: "delta"; message: Message | null; streaming: boolean }
  | { kind: "title"; title: string };

export type EngineDeps<S extends SessionLike = SessionLike> = {
  db: Database;
  sessions: SessionsPort<S>;
  autoTitle: (session: S, text: string) => Promise<string | null>;
};

type Subscriber = {
  mode: SubscribeMode;
  listener: (event: TurnEvent) => void;
};

export class Engine<S extends SessionLike = SessionLike> {
  private readonly deps: EngineDeps<S>;
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly bridged = new Set<string>();

  constructor(deps: EngineDeps<S>) {
    this.deps = deps;
  }

  get(conversationId: string): S | undefined {
    return this.deps.sessions.get(conversationId);
  }

  subscribe(
    conversationId: string,
    cwd: string,
    mode: SubscribeMode,
    listener: (event: TurnEvent) => void,
  ): { unsubscribe: () => void; opened: Promise<string | undefined> } {
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

  snapshot(
    conversationId: string,
  ): { messages: Message[]; streaming: boolean } | undefined {
    const session = this.deps.sessions.get(conversationId);
    if (!session) return undefined;
    const state = session.state;
    const stream = state.streamMessage ? [state.streamMessage] : [];
    return {
      messages: toMessages([...state.messages, ...stream]),
      streaming: state.isStreaming,
    };
  }

  async prompt(
    conversationId: string,
    cwd: string,
    text: string,
  ): Promise<string | undefined> {
    const opened = await this.ensureOpen(conversationId, cwd);
    if (opened) return opened;
    const session = this.deps.sessions.get(conversationId);
    if (!session) {
      logger.warning("session unavailable after open for {conversationId}", {
        conversationId,
      });
      return "conversation session unavailable; retry your message";
    }
    const workspaceId =
      getConversation(this.deps.db, conversationId)?.workspaceId ?? "unknown";
    return withContext({ conversationId, workspaceId }, () => {
      logger.info("turn started ({chars} chars)", { chars: text.length });
      void this.maybeAutoTitle(conversationId, session, text).catch(
        (e: unknown) => {
          logger.error("auto-title failed: {error}", { error: e });
        },
      );
      return session
        .prompt(text)
        .then(() => {
          logger.info("turn completed");
          return undefined;
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          logger.error("turn failed: {error}", { error: e });
          return message;
        });
    });
  }

  abort(conversationId: string): Promise<string | undefined> {
    const session = this.deps.sessions.get(conversationId);
    if (!session) return Promise.resolve(undefined);
    logger.info("turn aborted for {conversationId}", { conversationId });
    return session
      .abort()
      .then(() => undefined)
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  }

  private async ensureOpen(
    conversationId: string,
    cwd: string,
  ): Promise<string | undefined> {
    if (this.deps.sessions.get(conversationId)) return undefined;
    const opened = await this.deps.sessions.open(conversationId, { cwd });
    if (opened.isErr()) return opened.error;
    if (!this.bridged.has(conversationId)) {
      this.bridged.add(conversationId);
      opened.value.subscribe((event) => this.dispatch(conversationId, event));
    }
    return undefined;
  }

  private dispatch(conversationId: string, event: AgentSessionEvent): void {
    const session = this.deps.sessions.get(conversationId);
    if (!session) return;
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

    const stream = state.streamMessage ? [state.streamMessage] : [];
    const evt: TurnEvent = {
      kind: "snapshot",
      messages: toMessages([...state.messages, ...stream]),
      streaming,
    };
    for (const target of targets) {
      if (target.mode === "live" || !streaming) target.listener(evt);
    }
  }

  private async maybeAutoTitle(
    conversationId: string,
    session: S,
    text: string,
  ): Promise<void> {
    if (getConversation(this.deps.db, conversationId)?.title != null) return;
    const title = await this.deps.autoTitle(session, text).catch(() => null);
    if (!title) return;
    if (!setConversationTitle(this.deps.db, conversationId, title)) return;
    if (!session.sessionName) {
      await session.setSessionName(title, "auto").catch((e: unknown) => {
        logger.error("title sync to omp session failed: {error}", { error: e });
      });
    }
    const evt: TurnEvent = { kind: "title", title };
    for (const target of this.subscribers.get(conversationId) ?? [])
      target.listener(evt);
  }
}
