import {
  BranchNaming,
  type BranchNamingHandler,
  type BranchNamingRequest,
} from "@pico/contract/branch-naming";
import type * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { AgentError, GitError, PersistenceError } from "@pico/contract/errors";
import type { AbsolutePath } from "@pico/contract/path";
import type * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import type { GitWorktree } from "@pico/contract/worktree";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const BranchTopic = Schema.String.check(
  Schema.isMaxLength(48),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+){1,5}$/),
);
const parseBranchTopic = (value: string) => {
  const topic = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return Schema.is(BranchTopic)(topic) ? topic : undefined;
};

interface BranchNamingContext {
  readonly workspaceId: Workspace.WorkspaceId;
  readonly cwd: AbsolutePath;
  readonly branch: string;
  readonly prefix: string;
}

const findBranchNamingContext = Effect.fn("Application.findBranchNamingContext")(function* (
  chats: ChatRepository["Service"],
  workspaces: WorkspaceRepository["Service"],
  chatId: Chat.ChatId,
) {
  const maybeChat = yield* chats.findById(chatId);
  if (Option.isNone(maybeChat) || maybeChat.value.archivedAt !== null) return null;

  const chat = maybeChat.value;
  const maybeWorkspace = yield* workspaces.findById(chat.workspaceId);
  if (Option.isNone(maybeWorkspace) || maybeWorkspace.value.worktree === null) return null;

  return {
    workspaceId: chat.workspaceId,
    cwd: chat.cwd,
    branch: maybeWorkspace.value.worktree.branch,
    prefix: maybeWorkspace.value.worktree.prefix,
  } satisfies BranchNamingContext;
});

const sameBranchNamingContext = (left: BranchNamingContext, right: BranchNamingContext) =>
  left.workspaceId === right.workspaceId &&
  left.cwd === right.cwd &&
  left.branch === right.branch &&
  left.prefix === right.prefix;

const runBranchNaming = Effect.fn("Application.runBranchNaming")(function* (
  gitWorktree: GitWorktree,
  chats: ChatRepository["Service"],
  workspaces: WorkspaceRepository["Service"],
  request: BranchNamingRequest,
) {
  let phase = "eligibility";
  let workspaceId: Workspace.WorkspaceId | undefined;
  yield* Effect.gen(function* () {
    const before = yield* findBranchNamingContext(chats, workspaces, request.chatId);
    if (before === null) return;
    workspaceId = before.workspaceId;

    phase = "generation";
    const generated = yield* Effect.tryPromise({
      try: request.generateTopic,
      catch: (cause) =>
        cause instanceof AgentError
          ? cause
          : new AgentError({ message: "Branch topic generation failed" }),
    });
    if (generated === null) return;
    const topic = parseBranchTopic(generated);
    if (topic === undefined) return;

    phase = "revalidation";
    const after = yield* findBranchNamingContext(chats, workspaces, request.chatId);
    if (after === null || !sameBranchNamingContext(before, after)) return;

    phase = "rename";
    const result = yield* gitWorktree.renameChatBranch({
      chatId: request.chatId,
      cwd: after.cwd,
      prefix: after.prefix,
      topic,
    });
    yield* Effect.logDebug("Branch naming finished").pipe(
      Effect.annotateLogs({
        component: "application",
        operation: "branch-naming",
        chatId: request.chatId,
        workspaceId,
        outcome: result.kind,
        ...(result.kind === "skipped" ? { reason: result.reason } : {}),
      }),
    );
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const safeCause = Cause.fromReasons(
        cause.reasons.map((reason) => {
          if (reason._tag === "Interrupt") return reason;
          const error = reason._tag === "Fail" ? reason.error : reason.defect;
          if (
            error instanceof GitError ||
            error instanceof PersistenceError ||
            error instanceof AgentError
          )
            return reason;
          const safeError = new Error(
            reason._tag === "Fail"
              ? "Branch naming operation failed"
              : "Unexpected branch naming defect",
          );
          return reason._tag === "Fail"
            ? Cause.makeFailReason(safeError)
            : Cause.makeDieReason(safeError);
        }),
      );
      return Effect.logError("Background branch naming failed", safeCause).pipe(
        Effect.annotateLogs({
          component: "application",
          operation: "branch-naming",
          chatId: request.chatId,
          ...(workspaceId === undefined ? {} : { workspaceId }),
          phase,
          reason: Cause.hasDies(cause) ? "defect" : "operation",
        }),
      );
    }),
  );
});

export const make = Effect.fn("BranchNaming.make")(function* (gitWorktree: GitWorktree) {
  const chats = yield* ChatRepository;
  const workspaces = yield* WorkspaceRepository;
  const run = yield* FiberSet.makeRuntime<never, void, never>();

  const handle: BranchNamingHandler = (request) => {
    run(runBranchNaming(gitWorktree, chats, workspaces, request));
  };
  return BranchNaming.of({ handle });
});

export const layer = (gitWorktree: GitWorktree) => Layer.effect(BranchNaming, make(gitWorktree));
