import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import * as Schedule from "@pico/contract/schedule";
import * as Effect from "effect/Effect";

interface Options {
  readonly caller: Schedule.ScheduleCaller;
  readonly schedules: Schedule.Schedules["Service"];
}
export const scheduleToolNames = {
  create: "schedule_create",
  list: "schedule_list",
  get: "schedule_get",
  update: "schedule_update",
  setEnabled: "schedule_set_enabled",
  remove: "schedule_delete",
} as const;

const textContent = (text: string): { readonly type: "text"; readonly text: string } => ({
  type: "text",
  text,
});

const result = (value: unknown) => ({
  content: [textContent(JSON.stringify(value, null, 2) ?? "null")],
  details: value,
  isError: false,
});

const failure = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : "Schedule operation failed";
  return {
    content: [textContent(`Schedule operation failed: ${message}`)],
    details: { message },
    isError: true,
  };
};

export const executeScheduleOperation = async <A>(
  effect: Effect.Effect<A, Schedule.ScheduleError>,
) => {
  try {
    return result(await Effect.runPromise(effect));
  } catch (cause) {
    return failure(cause);
  }
};

export const make =
  ({ caller, schedules }: Options): ExtensionFactory =>
  (api) => {
    const Type = api.typebox.Type;
    const scheduleId = Type.String({
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
    });
    const target = Type.Union([
      Type.Object({ kind: Type.Literal("current-chat") }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("current-workspace") }, { additionalProperties: false }),
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
    const scriptTimeoutMs = Type.Optional(
      Type.Integer({ minimum: 1, maximum: Schedule.MAX_SCRIPT_TIMEOUT_MS }),
    );
    const script = Type.String({ minLength: 1 });
    const prompt = Type.String({ minLength: 1 });
    const scriptSource = {
      script,
      prompt: Type.Optional(prompt),
      scriptTimeoutMs,
    };
    const promptSource = {
      script: Type.Optional(script),
      prompt,
      scriptTimeoutMs,
    };
    const createFields = {
      name: Type.String({ minLength: 1 }),
      enabled: Type.Boolean(),
      target,
      trigger,
    };
    const updateFields = {
      scheduleId,
      name: Type.String({ minLength: 1 }),
      target,
      trigger,
    };

    api.registerTool({
      name: scheduleToolNames.create,
      label: "Create schedule",
      description:
        "Create a filesystem-backed schedule. script.js and prompt.md presence drives execution. Scripts return strict JSON {agent:boolean,content?:non-empty string} to skip, publish, or invoke OMP. Scripts write logs to stderr.",
      approval: "write",
      parameters: Type.Union([
        Type.Object({ ...createFields, ...scriptSource }, { additionalProperties: false }),
        Type.Object({ ...createFields, ...promptSource }, { additionalProperties: false }),
      ]),
      execute: (_toolCallId, params) =>
        schedules.create(caller, params).pipe(executeScheduleOperation),
    });

    api.registerTool({
      name: scheduleToolNames.list,
      label: "List schedules",
      description:
        "List schedules owned by the current workspace, including invalid external edits.",
      approval: "read",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: () => schedules.list(caller).pipe(executeScheduleOperation),
    });

    api.registerTool({
      name: scheduleToolNames.get,
      label: "Get schedule",
      description: "Get one schedule and its complete prompt and script source.",
      approval: "read",
      parameters: Type.Object({ scheduleId }, { additionalProperties: false }),
      execute: (_toolCallId, params) =>
        schedules
          .get(caller, Schedule.ScheduleId.make(params.scheduleId))
          .pipe(executeScheduleOperation),
    });

    api.registerTool({
      name: scheduleToolNames.update,
      label: "Update schedule",
      description:
        "Replace one schedule definition and all source files. script.js runs first when present. Its strict JSON {agent:boolean,content?:non-empty string} chooses whether OMP runs. Scripts write logs to stderr.",
      approval: "write",
      parameters: Type.Union([
        Type.Object({ ...updateFields, ...scriptSource }, { additionalProperties: false }),
        Type.Object({ ...updateFields, ...promptSource }, { additionalProperties: false }),
      ]),
      execute: (_toolCallId, params) => {
        const { scheduleId: id, ...input } = params;
        return schedules
          .replace(caller, Schedule.ScheduleId.make(id), input)
          .pipe(executeScheduleOperation);
      },
    });

    api.registerTool({
      name: scheduleToolNames.setEnabled,
      label: "Set schedule enabled state",
      description:
        "Enable or disable one schedule without changing its definition. Use this to disable a schedule while retaining the definition and run history.",
      approval: "write",
      parameters: Type.Object(
        { scheduleId, enabled: Type.Boolean() },
        { additionalProperties: false },
      ),
      execute: (_toolCallId, params) =>
        schedules
          .setEnabled(caller, Schedule.ScheduleId.make(params.scheduleId), params.enabled)
          .pipe(executeScheduleOperation),
    });

    api.registerTool({
      name: scheduleToolNames.remove,
      label: "Delete schedule",
      description:
        "Delete an enabled or disabled schedule definition while retaining its immutable run history.",
      approval: "write",
      parameters: Type.Object({ scheduleId }, { additionalProperties: false }),
      execute: (_toolCallId, params) => {
        const id = Schedule.ScheduleId.make(params.scheduleId);
        return schedules
          .remove(caller, id)
          .pipe(Effect.as({ scheduleId: id, deleted: true }), executeScheduleOperation);
      },
    });
  };
