import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { isValidId } from "../util/id";
import { log } from "../util/log";
import { errMessage } from "../util/result";
import {
  assembleAppendPrompt,
  defaultIdentityPath,
  loadIdentity,
} from "./identity";
import type { OmpRuntime } from "./runtime";

const logger = log(["sessions"]);

export interface OpenOptions {
  cwd: string;
  continueFromFile?: string;
}

export interface SessionsOptions {
  sessionsRoot?: string;
  identityPath?: string;
}

export class Sessions {
  private readonly runtime: OmpRuntime;
  private readonly sessionsRoot: string;
  private readonly identityPath: string;
  private readonly live = new Map<string, AgentSession>();
  private readonly pending = new Map<string, Promise<AgentSession>>();
  private generation = 0;

  constructor(runtime: OmpRuntime, options: SessionsOptions = {}) {
    this.runtime = runtime;
    this.sessionsRoot =
      options.sessionsRoot ?? join(homedir(), ".pico", "sessions");
    this.identityPath = options.identityPath ?? defaultIdentityPath();
  }

  async open(
    conversationId: string,
    options: OpenOptions,
  ): Promise<Result<AgentSession, string>> {
    if (!isValidId(conversationId)) {
      return err(`invalid conversation id: ${conversationId}`);
    }
    const existing = this.live.get(conversationId);
    if (existing) return ok(existing);

    const generation = this.generation;
    const inFlight = this.pending.get(conversationId);
    const build = inFlight ?? this.construct(conversationId, options);
    if (!inFlight) this.pending.set(conversationId, build);

    const built = await ResultAsync.fromPromise(build, errMessage);
    this.pending.delete(conversationId);
    if (built.isErr()) {
      logger.error("session open failed for {conversationId}: {error}", {
        conversationId,
        error: built.error,
      });
      return err(built.error);
    }

    if (this.generation !== generation) {
      await Promise.allSettled([built.value.dispose()]);
      return err("sessions closed during open");
    }
    this.live.set(conversationId, built.value);
    return ok(built.value);
  }

  get(conversationId: string): AgentSession | undefined {
    return this.live.get(conversationId);
  }

  isPending(conversationId: string): boolean {
    return this.pending.has(conversationId);
  }

  async close(conversationId: string): Promise<void> {
    const session = this.live.get(conversationId);
    if (!session) return;
    this.live.delete(conversationId);
    await session.dispose();
    logger.debug("session closed for {conversationId}", { conversationId });
  }

  async closeAll(): Promise<void> {
    this.generation++;
    const building = [...this.pending.values()];
    const live = [...this.live.values()];
    this.live.clear();
    const settled = await Promise.allSettled(building);
    const built = settled.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    await Promise.allSettled(
      [...live, ...built].map((session) => session.dispose()),
    );
  }

  protected async construct(
    conversationId: string,
    options: OpenOptions,
  ): Promise<AgentSession> {
    const sessionDir = join(this.sessionsRoot, conversationId);
    mkdirSync(sessionDir, { recursive: true });

    const resumeFile =
      options.continueFromFile ?? latestSessionFile(sessionDir);
    const sessionManager = resumeFile
      ? await SessionManager.open(resumeFile, sessionDir)
      : SessionManager.create(options.cwd, sessionDir);

    const appendSystemPrompt = assembleAppendPrompt(
      loadIdentity(this.identityPath),
    );
    const { session } = await createAgentSession({
      cwd: options.cwd,
      sessionManager,
      model: this.runtime.defaultModel,
      agentDir: this.runtime.agentDir,
      settings: this.runtime.settings,
      authStorage: this.runtime.authStorage,
      modelRegistry: this.runtime.modelRegistry,
      appendSystemPrompt,
      skipPythonPreflight: true,
      autoApprove: true,
      hasUI: false,
    });
    logger.info("session opened for {conversationId} ({mode})", {
      conversationId,
      mode: resumeFile ? "resumed" : "fresh",
    });
    return session;
  }
}

function latestSessionFile(sessionDir: string): string | undefined {
  const listed = Result.fromThrowable(
    () => readdirSync(sessionDir),
    errMessage,
  )();
  if (listed.isErr()) {
    logger.warning("failed to list session dir {dir}: {error}", {
      dir: sessionDir,
      error: listed.error,
    });
    return undefined;
  }
  const files = listed.value.filter((name) => name.endsWith(".jsonl")).sort();
  const latest = files.at(-1);
  return latest ? join(sessionDir, latest) : undefined;
}
