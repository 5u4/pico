import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import * as Schedule from "@pico/contract/schedule";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

interface Options {
  readonly caller: () => Schedule.ScheduleCaller;
  readonly schedules: Schedule.Schedules["Service"];
  readonly runEffect: typeof Effect.runPromise;
}
export const scheduleToolNames = {
  create: "schedule_create",
  list: "schedule_list",
  get: "schedule_get",
  update: "schedule_update",
  remove: "schedule_delete",
} as const;
interface OperationContext {
  readonly operation: keyof typeof scheduleToolNames;
  readonly caller: Schedule.ScheduleCaller;
  readonly scheduleId?: Schedule.ScheduleId;
  readonly runEffect: typeof Effect.runPromise;
}

const decodeCreate = Schema.decodeUnknownSync(Schedule.CreateSchedule, {
  onExcessProperty: "error",
});
const decodeUpdate = Schema.decodeUnknownSync(Schedule.UpdateSchedule, {
  onExcessProperty: "error",
});

const textContent = (text: string): { readonly type: "text"; readonly text: string } => ({
  type: "text",
  text,
});

const result = (value: unknown) => ({
  content: [textContent(JSON.stringify(value, null, 2) ?? "null")],
  details: value,
  isError: false,
});

const failure = (message: string) => {
  return {
    content: [textContent(`Schedule operation failed: ${message}`)],
    details: { message },
    isError: true,
  };
};

export const executeScheduleOperation = <A>(
  effect: Effect.Effect<A, Schedule.ScheduleError>,
  { operation, caller, scheduleId, runEffect }: OperationContext,
) =>
  runEffect(
    effect.pipe(
      Effect.map(result),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const error = cause.reasons.find(Cause.isFailReason)?.error;
        const defect = Cause.hasDies(cause);
        const toolResult = failure(
          defect ? "Schedule operation failed" : (error?.message ?? "Schedule operation failed"),
        );
        if (!defect && error?.kind !== "io" && error?.kind !== "corrupt") {
          return Effect.succeed(toolResult);
        }
        return Effect.logError("Schedule tool operation failed").pipe(
          Effect.annotateLogs({
            component: "omp",
            operation: `schedule-${operation}`,
            chatId: caller.chatId,
            workspaceId: caller.workspaceId,
            scheduleId,
            failureKind: defect ? "defect" : error?.kind,
          }),
          Effect.as(toolResult),
        );
      }),
    ),
  );

export const make =
  ({ caller, schedules, runEffect }: Options): ExtensionFactory =>
  (api) => {
    const Type = api.typebox.Type;
    const execute = <A>(
      operation: OperationContext["operation"],
      action: (caller: Schedule.ScheduleCaller) => Effect.Effect<A, Schedule.ScheduleError>,
      id?: string,
    ) => {
      const operationCaller = caller();
      return executeScheduleOperation(action(operationCaller), {
        caller: operationCaller,
        operation,
        runEffect,
        ...(id === undefined ? {} : { scheduleId: Schedule.ScheduleId.make(id) }),
      });
    };
    const uuidV7 = Type.String({
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
    });
    const target = Type.Union([
      Type.Object(
        {
          kind: Type.Literal("external-chat"),
          platform: Type.Literal("discord"),
          externalId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("external-workspace"),
          platform: Type.Literal("discord"),
          externalId: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      Type.Object({ kind: Type.Literal("chat"), chatId: uuidV7 }, { additionalProperties: false }),
      Type.Object(
        { kind: Type.Literal("workspace"), workspaceId: uuidV7 },
        { additionalProperties: false },
      ),
    ]);
    const trigger = Type.Union([
      Type.Object(
        {
          kind: Type.Literal("once"),
          at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("cron"),
          expression: Type.String({ pattern: "^\\S+(?:\\s+\\S+){4}$" }),
          timeZone: Type.String({ pattern: "^(?:UTC|[A-Za-z_+-]+(?:/[A-Za-z0-9_+.-]+)+)$" }),
        },
        { additionalProperties: false },
      ),
    ]);
    const scriptTimeoutMs = Type.Integer({ minimum: 1, maximum: Schedule.MAX_SCRIPT_TIMEOUT_MS });
    api.registerTool({
      name: scheduleToolNames.create,
      label: "Create schedule",
      description:
        "Create a schedule by copying sourceDirectory into Pico-owned storage. The absolute source directory needs script.js and/or prompt.md and may include helper files and subdirectories. Returns the editable sourceDirectory. Scripts return strict JSON {agent:boolean,content?:non-empty string} and log to stderr.",
      approval: "write",
      parameters: Type.Object(
        {
          name: Type.String({ minLength: 1 }),
          enabled: Type.Boolean(),
          target,
          trigger,
          sourceDirectory: Type.String({
            minLength: 1,
            description: "Absolute path to the prepared source directory to copy.",
          }),
          scriptTimeoutMs: Type.Optional(scriptTimeoutMs),
        },
        { additionalProperties: false },
      ),
      execute: (_toolCallId, params) =>
        execute("create", (caller) => schedules.create(caller, decodeCreate(params))),
    });

    api.registerTool({
      name: scheduleToolNames.list,
      label: "List schedules",
      description:
        "List schedules owned by the current workspace, including invalid external edits.",
      approval: "read",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: () => execute("list", (caller) => schedules.list(caller)),
    });

    api.registerTool({
      name: scheduleToolNames.get,
      label: "Get schedule",
      description:
        "Get schedule metadata and the current editable sourceDirectory. Read and edit source files with filesystem tools.",
      approval: "read",
      parameters: Type.Object({ scheduleId: uuidV7 }, { additionalProperties: false }),
      execute: (_toolCallId, params) =>
        execute(
          "get",
          (caller) => schedules.get(caller, Schedule.ScheduleId.make(params.scheduleId)),
          params.scheduleId,
        ),
    });

    api.registerTool({
      name: scheduleToolNames.update,
      label: "Update schedule",
      description:
        "Update only supplied metadata fields, including enabled to pause or resume. Source files and omitted fields stay unchanged. Set scriptTimeoutMs to null to restore the default timeout. Enable/disable moves sourceDirectory; use the returned current path for subsequent file edits.",
      approval: "write",
      parameters: Type.Object(
        {
          scheduleId: uuidV7,
          name: Type.Optional(Type.String({ minLength: 1 })),
          enabled: Type.Optional(Type.Boolean()),
          target: Type.Optional(target),
          trigger: Type.Optional(trigger),
          scriptTimeoutMs: Type.Optional(Type.Union([scriptTimeoutMs, Type.Null()])),
        },
        { additionalProperties: false },
      ),
      execute: (_toolCallId, params) => {
        const { scheduleId: id, ...input } = params;
        return execute(
          "update",
          (caller) => schedules.update(caller, Schedule.ScheduleId.make(id), decodeUpdate(input)),
          id,
        );
      },
    });

    api.registerTool({
      name: scheduleToolNames.remove,
      label: "Delete schedule",
      description:
        "Delete an enabled or disabled schedule definition while retaining its immutable run history.",
      approval: "write",
      parameters: Type.Object({ scheduleId: uuidV7 }, { additionalProperties: false }),
      execute: (_toolCallId, params) => {
        const id = Schedule.ScheduleId.make(params.scheduleId);
        return execute(
          "remove",
          (caller) =>
            schedules.remove(caller, id).pipe(Effect.as({ scheduleId: id, deleted: true })),
          id,
        );
      },
    });
  };
