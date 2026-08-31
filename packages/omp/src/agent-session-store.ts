import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AgentSessionStore, type CreateAgentSession } from "@pico/contract/agent-session-store";
import { AgentError } from "@pico/contract/errors";
import type { AbsolutePath } from "@pico/contract/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const agentError = (message: string, cause: unknown) =>
  new AgentError({
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });

export const make = Effect.fn("AgentSessionStore.make")(function* (sessionsDir: AbsolutePath) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fileSystem
    .makeDirectory(sessionsDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((error) => agentError("Failed to create OMP sessions directory", error)));

  const create = Effect.fn("AgentSessionStore.create")(function* (input: CreateAgentSession) {
    const sessionFile = path.join(sessionsDir, `${input.chatId}.jsonl`);
    let reserved = false;

    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* Effect.scoped(fileSystem.open(sessionFile, { flag: "wx", mode: 0o600 }));
        reserved = true;

        yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () =>
              SessionManager.open(sessionFile, sessionsDir, undefined, {
                initialCwd: input.cwd,
                suppressBreadcrumb: true,
              }),
            catch: (cause) => agentError("Failed to open OMP session", cause),
          }),
          (manager) =>
            Effect.tryPromise({
              try: () => manager.ensureOnDisk(),
              catch: (cause) => agentError("Failed to persist OMP session", cause),
            }),
          (manager) =>
            Effect.tryPromise({
              try: () => manager.close(),
              catch: (cause) => agentError("Failed to close OMP session", cause),
            }),
        );
      }).pipe(
        Effect.mapError((error) =>
          error instanceof AgentError ? error : agentError("Failed to create OMP session", error),
        ),
        Effect.tapError(() =>
          reserved
            ? fileSystem.remove(sessionFile, { force: true }).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    );
  });

  return AgentSessionStore.of({ create });
});

export const layer = (sessionsDir: AbsolutePath) =>
  Layer.effect(AgentSessionStore, make(sessionsDir));
