import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AgentSessionStore, type CreateAgentSession } from "@pico/contract/agent-session-store";
import { SessionJournal } from "@pico/contract/bot-session";
import { AgentError } from "@pico/contract/errors";
import type { AbsolutePath } from "@pico/contract/path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { agentError } from "./agent-error.ts";

export const make = Effect.fn("AgentSessionStore.make")(function* (sessionsDir: AbsolutePath) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fileSystem
    .makeDirectory(sessionsDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((error) => agentError("Failed to create OMP sessions directory", error)));

  const removeSessionFiles = (chatId: CreateAgentSession["chatId"]) =>
    Effect.all(
      [
        fileSystem.remove(path.join(sessionsDir, `${chatId}.jsonl`), { force: true }),
        fileSystem.remove(path.join(sessionsDir, chatId), { force: true, recursive: true }),
      ],
      { concurrency: "unbounded", discard: true },
    );

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
          (manager, exit) =>
            Effect.tryPromise({
              try: () => manager.close(),
              catch: (cause) => agentError("Failed to close OMP session", cause),
            }).pipe(
              Effect.catchCause((cause) =>
                Exit.isSuccess(exit)
                  ? Effect.failCause(cause)
                  : Effect.logError("Failed to close OMP journal after persistence failure").pipe(
                      Effect.annotateLogs({
                        component: "omp",
                        operation: "journal-cleanup",
                        chatId: input.chatId,
                        phase: "close",
                        failureKind: Cause.hasDies(cause) ? "defect" : "operation",
                      }),
                    ),
              ),
            ),
        );
      }).pipe(
        Effect.mapError((error) =>
          error instanceof AgentError ? error : agentError("Failed to create OMP session", error),
        ),
        Effect.tapCause(() =>
          reserved
            ? removeSessionFiles(input.chatId).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : Effect.logError("Failed to remove OMP journal after creation failure").pipe(
                        Effect.annotateLogs({
                          component: "omp",
                          operation: "journal-cleanup",
                          chatId: input.chatId,
                          phase: "create-rollback",
                          failureKind: Cause.hasDies(cause) ? "defect" : "operation",
                        }),
                      ),
                ),
              )
            : Effect.void,
        ),
      ),
    );
  });

  const remove = Effect.fn("AgentSessionStore.remove")(function* (
    chatId: CreateAgentSession["chatId"],
  ) {
    yield* removeSessionFiles(chatId).pipe(
      Effect.mapError((error) => agentError("Failed to remove OMP session", error)),
    );
  });

  const removePhysical = Effect.fn("AgentSessionStore.removePhysical")(function* (
    journal: SessionJournal,
  ) {
    yield* Effect.all(
      [
        fileSystem.remove(journal.file, { force: true }),
        fileSystem.remove(
          path.join(path.dirname(journal.file), path.basename(journal.file, ".jsonl")),
          { force: true, recursive: true },
        ),
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.mapError((error) => agentError("Failed to remove physical OMP session", error)));
  });

  const createPhysical = Effect.fn("AgentSessionStore.createPhysical")(function* (
    botRoot: AbsolutePath,
    cwd: AbsolutePath,
  ) {
    const directory = path.join(botRoot, "sessions");
    let journal: SessionJournal | undefined;
    return yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
      return yield* Effect.acquireUseRelease(
        Effect.try({
          try: () => SessionManager.create(cwd, directory),
          catch: (cause) => agentError("Failed to create physical OMP session", cause),
        }),
        (manager) =>
          Effect.tryPromise({
            try: async () => {
              const physical = Schema.decodeUnknownSync(SessionJournal)({
                id: manager.getSessionId(),
                file: manager.getSessionFile(),
              });
              journal = physical;
              await manager.ensureOnDisk();
              return physical;
            },
            catch: (cause) => agentError("Failed to persist physical OMP session", cause),
          }),
        (manager, exit) =>
          Effect.tryPromise({
            try: () => manager.close(),
            catch: (cause) => agentError("Failed to close physical OMP session", cause),
          }).pipe(
            Effect.catchCause((cause) =>
              Exit.isSuccess(exit)
                ? Effect.failCause(cause)
                : Effect.logError(
                    "Failed to close physical OMP journal after creation failure",
                  ).pipe(
                    Effect.annotateLogs({
                      component: "omp",
                      operation: "journal-cleanup",
                      phase: "close",
                      failureKind: Cause.hasDies(cause) ? "defect" : "operation",
                    }),
                  ),
            ),
          ),
      );
    }).pipe(
      Effect.mapError((error) =>
        error instanceof AgentError
          ? error
          : agentError("Failed to create physical OMP session", error),
      ),
      Effect.tapCause(() =>
        journal === undefined
          ? Effect.void
          : removePhysical(journal).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Failed to remove unpublished physical OMP journal").pipe(
                  Effect.annotateLogs({
                    component: "omp",
                    operation: "journal-cleanup",
                    phase: "create-rollback",
                    failureKind: Cause.hasDies(cause) ? "defect" : "operation",
                  }),
                ),
              ),
            ),
      ),
      Effect.uninterruptible,
    );
  });

  return AgentSessionStore.of({ create, remove, createPhysical, removePhysical });
});

export const layer = (sessionsDir: AbsolutePath) =>
  Layer.effect(AgentSessionStore, make(sessionsDir));
