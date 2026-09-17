import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { AgentEvent } from "./agent-event.ts";
import type { AgentAssistantMessage, AgentPrompt } from "./agent-message.ts";
import type { CapturedAgentRun } from "./agent-runtime.ts";
import { ChatId } from "./chat-model.ts";
import { AbsolutePath } from "./path.ts";
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
  Schema.Struct({
    kind: Schema.Literal("external-chat"),
    platform: Schema.Literal("discord"),
    externalId: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("external-workspace"),
    platform: Schema.Literal("discord"),
    externalId: Schema.NonEmptyString,
  }),
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
  version: Schema.Literal(2),
  revision: ScheduleRevision,
  name: Schema.NonEmptyString,
  ownerWorkspaceId: WorkspaceId,
  createdByChatId: ChatId,
  createdAt: Schema.Natural,
  target: ScheduleTarget,
  trigger: ScheduleTrigger,
  scriptTimeoutMs: Schema.optional(ScriptTimeoutMs),
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

const FailedScheduleOutcome = Schema.Struct({
  kind: Schema.Literal("failed"),
  stage: Schema.Literals(["target", "script", "protocol", "omp", "publish"]),
  message: Schema.String,
});
const InterruptedScheduleOutcome = Schema.Struct({
  kind: Schema.Literal("interrupted"),
  phase: Schema.String,
});

export const TerminalOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("skipped") }),
  Schema.Struct({ kind: Schema.Literal("published"), content: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("completed"), finalAssistantText: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("missed"),
    scheduledFor: Schema.Natural,
    observedAt: Schema.Natural,
  }),
  FailedScheduleOutcome,
  InterruptedScheduleOutcome,
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

export const ScheduleRunSummary = Schema.Struct({
  id: ScheduleRunId,
  definitionRevision: ScheduleRevision,
  scheduledFor: Schema.Natural,
  claimedAt: Schema.Natural,
  state: Schema.Union([
    Schema.Struct({ kind: Schema.Literals(["claimed", "target-resolved"]) }),
    Schema.Struct({
      kind: Schema.Literals(["running-script", "running-omp"]),
      startedAt: Schema.Natural,
    }),
    Schema.Struct({
      kind: Schema.Literal("finished"),
      finishedAt: Schema.Natural,
      outcome: Schema.Union([
        Schema.Struct({ kind: Schema.Literals(["skipped", "published", "completed", "missed"]) }),
        FailedScheduleOutcome,
        InterruptedScheduleOutcome,
      ]),
    }),
  ]),
});
export type ScheduleRunSummary = typeof ScheduleRunSummary.Type;

export const ScheduleNextTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("scheduled"), at: Schema.Natural }),
  Schema.Struct({
    kind: Schema.Literal("none"),
    reason: Schema.Literals(["disabled", "invalid", "past-once"]),
  }),
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
]);
export type ScheduleNextTrigger = typeof ScheduleNextTrigger.Type;

export const ScheduleOverviewEntry = Schema.Struct({
  view: ScheduleView,
  ownerWorkspaceId: Schema.NullOr(WorkspaceId),
  nextTrigger: ScheduleNextTrigger,
  lastRun: Schema.NullOr(ScheduleRunSummary),
});
export type ScheduleOverviewEntry = typeof ScheduleOverviewEntry.Type;

export const ScheduleOverview = Schema.Struct({
  observedAt: Schema.Natural,
  entries: Schema.Array(ScheduleOverviewEntry),
});
export type ScheduleOverview = typeof ScheduleOverview.Type;

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

export interface SchedulePlatform {
  readonly platform: "discord";
  readonly resolveTarget: (
    input: Extract<ScheduleTargetInput, { readonly platform: "discord" }>,
  ) => Effect.Effect<ScheduleTarget, ScheduleHostError>;
  readonly validateTarget: (
    input:
      | { readonly kind: "workspace"; readonly workspaceExternalId: string }
      | {
          readonly kind: "chat";
          readonly workspaceExternalId: string;
          readonly chatExternalId: string;
        },
  ) => Effect.Effect<void, ScheduleHostError>;
  readonly createThread: (input: {
    readonly workspaceExternalId: string;
    readonly title: string;
  }) => Effect.Effect<string, ScheduleHostError>;
  readonly deleteThread: (externalId: string) => Effect.Effect<void, ScheduleHostError>;
  readonly send: (input: {
    readonly chatId: typeof ChatId.Type;
    readonly externalId: string;
    readonly content: string;
  }) => Effect.Effect<void, ScheduleHostError>;
}

export class SchedulePlatformService extends Context.Service<
  SchedulePlatformService,
  SchedulePlatform
>()("@pico/contract/schedule/SchedulePlatform") {}

export interface ScheduleRunHost {
  /** The scheduler uses this while a script runs against a prepared chat. */
  readonly withScriptActivity: <A, E, R>(
    chatId: typeof ChatId.Type,
    script: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ScheduleHostError, R>;
  readonly resolveTarget: (
    input: ScheduleTargetInput,
  ) => Effect.Effect<ScheduleTarget, ScheduleHostError>;
  readonly prepare: (
    destination: ScheduleRunDestination,
  ) => Effect.Effect<ResolvedScheduleRunTarget, ScheduleHostError>;
  readonly materialize: (input: {
    readonly destination: ScheduleRunDestination;
    readonly target: ResolvedScheduleRunTarget;
    readonly title: string;
  }) => Effect.Effect<void, ScheduleHostError>;
  readonly deliver: (
    chatId: typeof ChatId.Type,
    message: AgentAssistantMessage,
  ) => Effect.Effect<void, ScheduleHostError>;
  readonly publish: (
    chatId: typeof ChatId.Type,
    content: string,
  ) => Effect.Effect<void, ScheduleHostError>;
  readonly runPrompt: (
    chatId: typeof ChatId.Type,
    runId: ScheduleRunId,
    prompt: AgentPrompt,
    onEvent: (event: AgentEvent) => Effect.Effect<void, ScheduleHostError>,
  ) => Effect.Effect<CapturedAgentRun, ScheduleHostError>;
}
export class ScheduleRunHostFactory extends Context.Service<
  ScheduleRunHostFactory,
  (platform: SchedulePlatform | null) => ScheduleRunHost
>()("@pico/contract/schedule/ScheduleRunHostFactory") {}

export class Schedules extends Context.Service<
  Schedules,
  {
    /** OMP calls this after preparing and checking a source directory. */
    readonly create: (
      caller: ScheduleCaller,
      input: CreateSchedule,
    ) => Effect.Effect<ScheduleView, ScheduleError>;
    /** OMP lists schedules owned by the calling chat's workspace. */
    readonly list: (
      caller: ScheduleCaller,
    ) => Effect.Effect<ReadonlyArray<ScheduleView>, ScheduleError>;
    /** The root-local web overview reads all current definitions and recorded status. */
    readonly overview: () => Effect.Effect<ScheduleOverview, ScheduleError>;
    /** OMP calls this before reading or editing the current managed directory. */
    readonly get: (
      caller: ScheduleCaller,
      id: ScheduleId,
    ) => Effect.Effect<ScheduleView, ScheduleError>;
    /** OMP calls this when changing metadata or enabled state. */
    readonly update: (
      caller: ScheduleCaller,
      id: ScheduleId,
      input: UpdateSchedule,
    ) => Effect.Effect<ScheduleView, ScheduleError>;
    /** OMP removes the live definition, retaining run history. */
    readonly remove: (caller: ScheduleCaller, id: ScheduleId) => Effect.Effect<void, ScheduleError>;
    /** Application holds this scope while checking references and deleting a workspace. */
    readonly withCurrentTargets: <A, E, R>(
      use: (targets: readonly ScheduleTarget[]) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ScheduleError, R>;
    readonly start: (host: ScheduleRunHost) => Effect.Effect<void, ScheduleError, Scope.Scope>;
  }
>()("@pico/contract/schedule/Schedules") {}
