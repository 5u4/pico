import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { AgentEvent } from "./agent-event.ts";
import type { AgentPrompt } from "./agent-message.ts";
import type { CapturedAgentRun } from "./agent-runtime.ts";
import { ChatId } from "./chat-model.ts";
import { AbsolutePath } from "./path.ts";
import { ReplyTarget } from "./reply-target.ts";
import { WorkspaceId } from "./workspace-model.ts";

export const ScheduleId = Schema.String.check(Schema.isUUID(7)).pipe(
  Schema.brand("@pico/contract/ScheduleId"),
);
export type ScheduleId = typeof ScheduleId.Type;

export const ScheduleRevision = Schema.String.check(Schema.isUUID(7)).pipe(
  Schema.brand("@pico/contract/ScheduleRevision"),
);
export type ScheduleRevision = typeof ScheduleRevision.Type;

export const ScheduleRunId = Schema.String.check(
  Schema.isPattern(
    /^scheduled-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  ),
).pipe(Schema.brand("@pico/contract/ScheduleRunId"));
export type ScheduleRunId = typeof ScheduleRunId.Type;

export const ScheduleEnabledState = Schema.Literals(["enabled", "disabled"]);
export type ScheduleEnabledState = typeof ScheduleEnabledState.Type;

export const ScheduleTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("chat"), chatId: ChatId }),
  Schema.Struct({ kind: Schema.Literal("workspace"), workspaceId: WorkspaceId }),
]);
export type ScheduleTarget = typeof ScheduleTarget.Type;

export const ScheduleTargetInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("current-chat") }),
  Schema.Struct({ kind: Schema.Literal("current-workspace") }),
  ScheduleTarget,
]);
export type ScheduleTargetInput = typeof ScheduleTargetInput.Type;
export const CronExpression = Schema.String.check(Schema.isPattern(/^\S+(?:\s+\S+){4}$/u));
export type CronExpression = typeof CronExpression.Type;

export const IanaTimeZone = Schema.String.check(
  Schema.isPattern(/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)+)$/u),
);
export type IanaTimeZone = typeof IanaTimeZone.Type;

export const ScheduleTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("once"), at: Schema.Natural }),
  Schema.Struct({
    kind: Schema.Literal("cron"),
    expression: CronExpression,
    timeZone: IanaTimeZone,
  }),
]);
export type ScheduleTrigger = typeof ScheduleTrigger.Type;

export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;
export const MAX_SCRIPT_TIMEOUT_MS = 86_400_000;
const ScriptTimeoutMs = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_SCRIPT_TIMEOUT_MS }),
);

export const ScriptDecision = Schema.Struct({
  agent: Schema.Boolean,
  content: Schema.optional(Schema.NonEmptyString),
});
export type ScriptDecision = typeof ScriptDecision.Type;

export const ScheduleDefinition = Schema.Struct({
  version: Schema.Literal(1),
  revision: ScheduleRevision,
  name: Schema.NonEmptyString,
  ownerWorkspaceId: WorkspaceId,
  createdByChatId: ChatId,
  createdAt: Schema.Natural,
  target: ScheduleTarget,
  trigger: ScheduleTrigger,
  scriptTimeoutMs: Schema.optional(ScriptTimeoutMs),
  replyTarget: Schema.optional(ReplyTarget),
});
export type ScheduleDefinition = typeof ScheduleDefinition.Type;

export const ReadyScheduleView = Schema.Struct({
  kind: Schema.Literal("ready"),
  id: ScheduleId,
  state: ScheduleEnabledState,
  definition: ScheduleDefinition,
  sourceDirectory: AbsolutePath,
});
export type ReadyScheduleView = typeof ReadyScheduleView.Type;

export const InvalidScheduleView = Schema.Struct({
  kind: Schema.Literal("invalid"),
  id: ScheduleId,
  state: Schema.Literals(["enabled", "disabled", "conflicted"]),
  error: Schema.String,
  sourceDirectory: Schema.NullOr(AbsolutePath),
});
export type InvalidScheduleView = typeof InvalidScheduleView.Type;

export const ScheduleView = Schema.Union([ReadyScheduleView, InvalidScheduleView]);
export type ScheduleView = typeof ScheduleView.Type;

export const ScheduleRunSource = Schema.Struct({
  kind: Schema.Literal("scheduled"),
  scheduledFor: Schema.Natural,
});
export type ScheduleRunSource = typeof ScheduleRunSource.Type;

export const PlannedScheduleRunTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("existing-chat"),
    ownerWorkspaceId: WorkspaceId,
    chatId: ChatId,
  }),
  Schema.Struct({
    kind: Schema.Literal("workspace-chat"),
    ownerWorkspaceId: WorkspaceId,
    chatId: ChatId,
  }),
]);
export type PlannedScheduleRunTarget = typeof PlannedScheduleRunTarget.Type;

export type ScheduleRunDestination =
  | Extract<ScheduleTarget, { readonly kind: "chat" }>
  | (Extract<ScheduleTarget, { readonly kind: "workspace" }> & {
      readonly newChatId: typeof ChatId.Type;
    });

export const ResolvedScheduleRunTarget = Schema.Struct({
  chatId: ChatId,
  workspaceId: WorkspaceId,
  cwd: AbsolutePath,
});
export type ResolvedScheduleRunTarget = typeof ResolvedScheduleRunTarget.Type;

export const TerminalOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("skipped") }),
  Schema.Struct({ kind: Schema.Literal("published"), content: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("completed"), finalAssistantText: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("missed"),
    scheduledFor: Schema.Natural,
    observedAt: Schema.Natural,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    stage: Schema.Literals(["target", "script", "protocol", "omp", "publish"]),
    message: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("interrupted"), phase: Schema.String }),
]);
export type TerminalOutcome = typeof TerminalOutcome.Type;

const ScheduleRunBase = {
  version: Schema.Literal(1),
  id: ScheduleRunId,
  scheduleId: ScheduleId,
  definitionRevision: ScheduleRevision,
  source: ScheduleRunSource,
  plannedTarget: PlannedScheduleRunTarget,
  claimedAt: Schema.Natural,
};

export const ScheduleRunLifecycle = Schema.Union([
  Schema.Struct({ ...ScheduleRunBase, state: Schema.Struct({ kind: Schema.Literal("claimed") }) }),
  Schema.Struct({
    ...ScheduleRunBase,
    state: Schema.Struct({
      kind: Schema.Literal("target-resolved"),
      target: ResolvedScheduleRunTarget,
    }),
  }),
  Schema.Struct({
    ...ScheduleRunBase,
    state: Schema.Struct({
      kind: Schema.Literals(["running-script", "running-omp"]),
      target: ResolvedScheduleRunTarget,
      startedAt: Schema.Natural,
    }),
  }),
  Schema.Struct({
    ...ScheduleRunBase,
    state: Schema.Struct({
      kind: Schema.Literal("finished"),
      finishedAt: Schema.Natural,
      outcome: TerminalOutcome,
    }),
  }),
]);
export type ScheduleRunLifecycle = typeof ScheduleRunLifecycle.Type;

export const CreateSchedule = Schema.Struct({
  name: Schema.NonEmptyString,
  enabled: Schema.Boolean,
  target: ScheduleTargetInput,
  trigger: ScheduleTrigger,
  sourceDirectory: AbsolutePath,
  scriptTimeoutMs: Schema.optional(ScriptTimeoutMs),
});
export type CreateSchedule = typeof CreateSchedule.Type;

export const UpdateSchedule = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  enabled: Schema.optional(Schema.Boolean),
  target: Schema.optional(ScheduleTargetInput),
  trigger: Schema.optional(ScheduleTrigger),
  scriptTimeoutMs: Schema.optional(Schema.NullOr(ScriptTimeoutMs)),
});
export type UpdateSchedule = typeof UpdateSchedule.Type;

export interface ScheduleCaller {
  readonly chatId: typeof ChatId.Type;
  readonly workspaceId: typeof WorkspaceId.Type;
  readonly replyTarget?: ReplyTarget;
}

export class ScheduleError extends Schema.TaggedError<ScheduleError>()("ScheduleError", {
  kind: Schema.Literals(["invalid", "not-found", "busy", "conflict", "corrupt", "io"]),
  message: Schema.String,
}) {}

export class ScheduleHostError extends Schema.TaggedError<ScheduleHostError>()(
  "ScheduleHostError",
  {
    message: Schema.String,
  },
) {}

export interface ScheduleRunHost {
  readonly prepare: (
    destination: ScheduleRunDestination,
  ) => Effect.Effect<ResolvedScheduleRunTarget, ScheduleHostError>;
  readonly deliver: (
    chatId: typeof ChatId.Type,
    content: string,
    replyTarget?: ReplyTarget,
  ) => Effect.Effect<void, ScheduleHostError>;
  readonly publish: (
    chatId: typeof ChatId.Type,
    content: string,
    replyTarget?: ReplyTarget,
  ) => Effect.Effect<void, ScheduleHostError>;
  readonly runPrompt: (
    chatId: typeof ChatId.Type,
    runId: ScheduleRunId,
    prompt: AgentPrompt,
    onEvent: (event: AgentEvent) => Effect.Effect<void, ScheduleHostError>,
    replyTarget?: ReplyTarget,
  ) => Effect.Effect<CapturedAgentRun, ScheduleHostError>;
}
export class ScheduleRunHostService extends Context.Service<
  ScheduleRunHostService,
  ScheduleRunHost
>()("@pico/contract/schedule/ScheduleRunHost") {}

export class Schedules extends Context.Service<
  Schedules,
  {
    /** OMP calls this after preparing and checking a source directory. */
    readonly create: (
      caller: ScheduleCaller,
      input: CreateSchedule,
    ) => Effect.Effect<ScheduleView, ScheduleError>;
    readonly list: (
      caller: ScheduleCaller,
    ) => Effect.Effect<ReadonlyArray<ScheduleView>, ScheduleError>;
    /** OMP calls this before reading or editing the current managed directory. */
    readonly get: (
      caller: ScheduleCaller,
      id: ScheduleId,
    ) => Effect.Effect<ScheduleView, ScheduleError>;
    /** OMP calls this when changing schedule metadata or enabled state. */
    readonly update: (
      caller: ScheduleCaller,
      id: ScheduleId,
      input: UpdateSchedule,
    ) => Effect.Effect<ScheduleView, ScheduleError>;
    readonly remove: (caller: ScheduleCaller, id: ScheduleId) => Effect.Effect<void, ScheduleError>;
    readonly start: (host: ScheduleRunHost) => Effect.Effect<void, ScheduleError, Scope.Scope>;
  }
>()("@pico/contract/schedule/Schedules") {}
