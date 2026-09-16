import { visitEntriesFromFileStream } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AgentSessionStore, type CreateAgentSession } from "@pico/contract/agent-session-store";
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
              try: async () => {
                if (input.modelOverride !== null) {
                  manager.appendModelChange(
                    `${input.modelOverride.provider}/${input.modelOverride.id}`,
                    "temporary",
                  );
                }
                await manager.ensureOnDisk();
                await manager.flush();
              },
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

  const readTitle = Effect.fn("AgentSessionStore.readTitle")(function* (
    chatId: CreateAgentSession["chatId"],
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        let title: string | null = null;
        await visitEntriesFromFileStream(
          path.join(sessionsDir, `${chatId}.jsonl`),
          (entry: unknown) => {
            if (isTitledSessionHeader(entry)) title = entry.title;
            return false;
          },
          { maxRecords: 1 },
        );
        return title;
      },
      catch: (cause) => agentError("Failed to read OMP session title", cause),
    });
  });

  const remove = Effect.fn("AgentSessionStore.remove")(function* (
    chatId: CreateAgentSession["chatId"],
  ) {
    yield* removeSessionFiles(chatId).pipe(
      Effect.mapError((error) => agentError("Failed to remove OMP session", error)),
    );
  });

  return AgentSessionStore.of({ create, readTitle, remove });
});

export const layer = (sessionsDir: AbsolutePath) =>
  Layer.effect(AgentSessionStore, make(sessionsDir));

const isTitledSessionHeader = Schema.is(
  Schema.Struct({
    type: Schema.Literal("session"),
    id: Schema.String,
    title: Schema.NonEmptyString,
  }),
);
