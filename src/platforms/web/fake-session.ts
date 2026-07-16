import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { ok, type Result } from "neverthrow";
import type {
  SessionLike,
  SessionStateLike,
  SessionsPort,
} from "../../engine/conversations";

export type FakeResponder = (text: string) => AgentMessage[];

export type FakeSessionOptions = { stepMs?: number };

export const echoResponder: FakeResponder = (text) => [
  {
    role: "assistant",
    content: [{ type: "text", text: `echo: ${text}` }],
  } as AgentMessage,
];

function replyText(reply: AgentMessage[]): string {
  let out = "";
  for (const message of reply) {
    if (!("role" in message) || message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") {
      out += content;
      continue;
    }
    for (const part of content) if (part.type === "text") out += part.text;
  }
  return out;
}

export class FakeWebSession implements SessionLike {
  state: SessionStateLike = {
    messages: [],
    streamMessage: null,
    isStreaming: false,
  };
  sessionName: string | undefined;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly respond: FakeResponder;
  private readonly stepMs: number;
  private streamTimer: Timer | undefined;
  private streamDone: (() => void) | null = null;

  constructor(respond: FakeResponder = echoResponder, stepMs = 0) {
    this.respond = respond;
    this.stepMs = stepMs;
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  prompt(text: string): Promise<boolean> {
    this.state.messages.push({ role: "user", content: text } as AgentMessage);
    const reply = this.respond(text);
    if (this.stepMs <= 0) {
      this.state.messages.push(...reply);
      this.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
      return Promise.resolve(true);
    }
    return this.stream(reply);
  }

  private stream(reply: AgentMessage[]): Promise<boolean> {
    const chunks = replyText(reply).match(/\s*\S+/g) ?? [];
    const head = { type: "text" as const, text: "" };
    const partial = { role: "assistant", content: [head] } as AgentMessage;
    this.state.streamMessage = partial;
    this.state.isStreaming = true;
    let index = 0;
    return new Promise<boolean>((resolve) => {
      this.streamDone = () => resolve(true);
      const tick = () => {
        const next = chunks[index];
        if (next === undefined) {
          this.finish(reply);
          return;
        }
        head.text += next;
        index += 1;
        this.emit({ type: "message_update" } as AgentSessionEvent);
        this.streamTimer = setTimeout(tick, this.stepMs);
      };
      this.streamTimer = setTimeout(tick, this.stepMs);
    });
  }

  private finish(reply: AgentMessage[]): void {
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    this.state.streamMessage = null;
    this.state.isStreaming = false;
    this.state.messages.push(...reply);
    this.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
    this.streamDone?.();
    this.streamDone = null;
  }

  abort(): Promise<unknown> {
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    if (this.state.isStreaming) {
      const partial = this.state.streamMessage;
      this.state.streamMessage = null;
      this.state.isStreaming = false;
      if (partial && replyText([partial]).length > 0)
        this.state.messages.push(partial);
      this.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
      this.streamDone?.();
      this.streamDone = null;
    }
    return Promise.resolve(undefined);
  }

  sendCustomMessage(message: {
    customType: string;
    content: string;
    display: boolean;
  }): Promise<boolean> {
    this.state.messages.push({
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display,
      timestamp: Date.now(),
    } as unknown as AgentMessage);
    return Promise.resolve(false);
  }

  readonly sessionManager = {
    ensureOnDisk(): Promise<void> {
      return Promise.resolve();
    },
  };

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSessionName(name: string): Promise<boolean> {
    this.sessionName = name;
    return Promise.resolve(true);
  }

  getContextUsage(): {
    tokens: number;
    contextWindow: number;
    percent: number;
  } {
    return { tokens: 4200, contextWindow: 200000, percent: 2.1 };
  }

  getContextBreakdown(): {
    systemPromptTokens: number;
    systemToolsTokens: number;
    systemContextTokens: number;
    skillsTokens: number;
    messagesTokens: number;
  } {
    return {
      systemPromptTokens: 800,
      systemToolsTokens: 1200,
      systemContextTokens: 400,
      skillsTokens: 600,
      messagesTokens: 1200,
    };
  }

  getSessionStats(): { cost: number } {
    return { cost: 0.012 };
  }
}

export class FakeWebSessions implements SessionsPort<FakeWebSession> {
  private readonly live = new Map<string, FakeWebSession>();
  private readonly respond: FakeResponder;
  private readonly stepMs: number;

  constructor(respond: FakeResponder = echoResponder, stepMs = 0) {
    this.respond = respond;
    this.stepMs = stepMs;
  }

  get(id: string): FakeWebSession | undefined {
    return this.live.get(id);
  }

  open(id: string): Promise<Result<FakeWebSession, string>> {
    let session = this.live.get(id);
    if (!session) {
      session = new FakeWebSession(this.respond, this.stepMs);
      this.live.set(id, session);
    }
    return Promise.resolve(ok(session));
  }
}
