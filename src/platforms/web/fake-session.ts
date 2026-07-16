import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { ok, type Result } from "neverthrow";
import type {
  SessionLike,
  SessionStateLike,
  SessionsPort,
} from "../../engine/conversations";

export type FakeResponder = (text: string) => AgentMessage[];

export const echoResponder: FakeResponder = (text) => [
  {
    role: "assistant",
    content: [{ type: "text", text: `echo: ${text}` }],
  } as AgentMessage,
];

export class FakeWebSession implements SessionLike {
  state: SessionStateLike = {
    messages: [],
    streamMessage: null,
    isStreaming: false,
  };
  sessionName: string | undefined;
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly respond: FakeResponder;

  constructor(respond: FakeResponder = echoResponder) {
    this.respond = respond;
  }

  prompt(text: string): Promise<boolean> {
    this.state.messages.push({ role: "user", content: text } as AgentMessage);
    this.state.messages.push(...this.respond(text));
    for (const listener of this.listeners)
      listener({ type: "agent_end", messages: [] } as AgentSessionEvent);
    return Promise.resolve(true);
  }

  abort(): Promise<unknown> {
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

  constructor(respond: FakeResponder = echoResponder) {
    this.respond = respond;
  }

  get(id: string): FakeWebSession | undefined {
    return this.live.get(id);
  }

  open(id: string): Promise<Result<FakeWebSession, string>> {
    let session = this.live.get(id);
    if (!session) {
      session = new FakeWebSession(this.respond);
      this.live.set(id, session);
    }
    return Promise.resolve(ok(session));
  }
}
