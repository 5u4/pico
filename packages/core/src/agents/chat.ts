import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import {
  type AgentSession,
  createAgentSession,
  type ModelRegistry,
  SessionManager,
  type Settings,
} from "@oh-my-pi/pi-coding-agent";
import { Effect, PubSub, Runtime, type Scope, Stream } from "effect";
import { ChatBusy, SessionInitFailed } from "./errors.ts";
import { toChatEvent, toChatMessage } from "./mapping.ts";
import {
  type ChatEvent,
  type ChatMessage,
  type PromptOutcome,
  started,
} from "./schema.ts";

export interface MakeChatOptions {
  readonly chatId: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly model: Model;
  readonly agentDir: string;
  readonly settings: Settings;
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
}

export interface Chat {
  readonly chatId: string;
  readonly events: Stream.Stream<ChatEvent>;
  readonly history: Effect.Effect<ReadonlyArray<ChatMessage>>;
  readonly prompt: (text: string) => Effect.Effect<PromptOutcome, ChatBusy>;
}

function latestSessionFile(sessionDir: string): string | undefined {
  if (!existsSync(sessionDir)) return undefined;
  const files = readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  const last = files.at(-1);
  return last ? join(sessionDir, last) : undefined;
}

function buildSessionManager(
  cwd: string,
  sessionDir: string,
): Promise<SessionManager> {
  const existing = latestSessionFile(sessionDir);
  return existing
    ? SessionManager.open(existing, sessionDir)
    : Promise.resolve(SessionManager.create(cwd, sessionDir));
}

export function makeChat(
  options: MakeChatOptions,
): Effect.Effect<Chat, SessionInitFailed, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* Effect.runtime();
    const chatScope = yield* Effect.scope;
    const hub = yield* PubSub.unbounded<ChatEvent>();

    const session = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const sessionManager = await buildSessionManager(
            options.cwd,
            options.sessionDir,
          );
          const { session: created } = await createAgentSession({
            cwd: options.cwd,
            sessionManager,
            model: options.model,
            agentDir: options.agentDir,
            settings: options.settings,
            authStorage: options.authStorage,
            modelRegistry: options.modelRegistry,
            skipPythonPreflight: true,
          });
          return created;
        },
        catch: (cause) =>
          new SessionInitFailed({ chatId: options.chatId, cause }),
      }),
      (handle: AgentSession) => Effect.promise(() => handle.dispose()),
    );

    const unsubscribe = session.subscribe((event) => {
      const mapped = toChatEvent(event);
      if (mapped) Runtime.runFork(runtime)(PubSub.publish(hub, mapped));
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    const prompt = (text: string): Effect.Effect<PromptOutcome, ChatBusy> =>
      Effect.gen(function* () {
        if (session.isStreaming) {
          return yield* new ChatBusy({ chatId: options.chatId });
        }
        yield* Effect.forkIn(
          Effect.tryPromise(() => session.prompt(text)).pipe(
            Effect.catchAll((cause) =>
              Effect.zipRight(
                PubSub.publish(hub, {
                  _tag: "error",
                  reason: "error",
                  message:
                    cause instanceof Error ? cause.message : String(cause),
                }),
                PubSub.publish(hub, { _tag: "agent_end" }),
              ),
            ),
          ),
          chatScope,
        );
        return started;
      });

    return {
      chatId: options.chatId,
      events: Stream.fromPubSub(hub),
      history: Effect.sync(() =>
        session.state.messages
          .map(toChatMessage)
          .filter((message): message is ChatMessage => message !== null),
      ),
      prompt,
    };
  });
}
