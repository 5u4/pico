import * as Schedule from "@pico/contract/schedule";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ScheduleDraft, ScheduleRow } from "./chat/chat-model.ts";

const decodeUpdate = Schema.decodeUnknownOption(Schedule.UpdateSchedule);
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const localTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "long",
  timeZone: localZone,
});

export function scheduleDraft(schedule: Schedule.ReadyScheduleView): ScheduleDraft {
  const { definition } = schedule;
  const date = definition.trigger.kind === "once" ? new Date(definition.trigger.at) : null;
  return {
    name: definition.name,
    trigger:
      definition.trigger.kind === "cron"
        ? { ...definition.trigger }
        : {
            kind: "once",
            utc: date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, -1) : "",
          },
    destination: { kind: "keep" },
    timeout:
      definition.scriptTimeoutMs === undefined
        ? { kind: "default" }
        : { kind: "custom", milliseconds: String(definition.scriptTimeoutMs) },
  };
}

const sameTrigger = (left: ScheduleDraft["trigger"], right: ScheduleDraft["trigger"]) =>
  left.kind === "once" && right.kind === "once"
    ? left.utc === right.utc
    : left.kind === "cron" &&
      right.kind === "cron" &&
      left.expression === right.expression &&
      left.timeZone === right.timeZone;
const sameTimeout = (left: ScheduleDraft["timeout"], right: ScheduleDraft["timeout"]) =>
  left.kind === "default"
    ? right.kind === "default"
    : right.kind === "custom" && left.milliseconds === right.milliseconds;

export function sameScheduleDraft(left: ScheduleDraft, right: ScheduleDraft): boolean {
  return (
    left.name === right.name &&
    sameTrigger(left.trigger, right.trigger) &&
    (left.destination.kind === "keep"
      ? right.destination.kind === "keep"
      : right.destination.kind !== "keep" &&
        left.destination.kind === right.destination.kind &&
        left.destination.id === right.destination.id) &&
    sameTimeout(left.timeout, right.timeout)
  );
}

export function scheduleUpdate(
  original: Schedule.ReadyScheduleView,
  draft: ScheduleDraft,
):
  | { readonly kind: "ready"; readonly input: Schedule.UpdateSchedule }
  | { readonly kind: "error"; readonly message: string } {
  const baseline = scheduleDraft(original);
  const trigger =
    draft.trigger.kind === "once"
      ? { kind: "once", at: draft.trigger.utc ? Date.parse(`${draft.trigger.utc}Z`) : Number.NaN }
      : {
          kind: "cron",
          expression: draft.trigger.expression.trim().replace(/\s+/gu, " "),
          timeZone: draft.trigger.timeZone.trim(),
        };
  const target =
    draft.destination.kind === "keep"
      ? undefined
      : draft.destination.kind === "workspace"
        ? { kind: "workspace", workspaceId: draft.destination.id }
        : { kind: "chat", chatId: draft.destination.id };
  const input = decodeUpdate({
    ...(draft.name === baseline.name ? {} : { name: draft.name.trim() }),
    ...(sameTrigger(draft.trigger, baseline.trigger) ? {} : { trigger }),
    ...(target === undefined ? {} : { target }),
    ...(sameTimeout(draft.timeout, baseline.timeout)
      ? {}
      : {
          scriptTimeoutMs:
            draft.timeout.kind === "default" ? null : Number(draft.timeout.milliseconds),
        }),
  });
  return Option.isSome(input)
    ? { kind: "ready", input: input.value }
    : {
        kind: "error",
        message:
          "Enter a name, a valid UTC date or five-field cron with an IANA timezone, and a script timeout from 1 to 86400000 milliseconds.",
      };
}

export function scheduleLocalPreview(draft: ScheduleDraft): string {
  if (draft.trigger.kind !== "once") return "";
  const at = draft.trigger.utc ? Date.parse(`${draft.trigger.utc}Z`) : Number.NaN;
  return Number.isFinite(at)
    ? `${localTime.format(at)} · ${localZone}`
    : `Enter a UTC date to preview it in ${localZone}.`;
}

export function presentSchedule(
  schedule: Schedule.ScheduleView,
  workspaceNames: ReadonlyMap<string, string>,
  chatNames: ReadonlyMap<string, string>,
): ScheduleRow {
  if (schedule.kind === "invalid") return { ...schedule };
  const { trigger, target } = schedule.definition;
  const date = trigger.kind === "once" ? new Date(trigger.at) : null;
  return {
    kind: "ready",
    id: schedule.id,
    name: schedule.definition.name,
    state: schedule.state,
    triggerLabel: trigger.kind === "once" ? "Once" : "Repeating",
    timing:
      trigger.kind === "cron"
        ? trigger.expression
        : date && Number.isFinite(date.getTime())
          ? date
              .toISOString()
              .replace("T", " ")
              .replace(/\.000Z$/u, "")
          : "Date outside browser range",
    timeZone: trigger.kind === "cron" ? trigger.timeZone : "UTC",
    destination:
      target.kind === "workspace"
        ? `${workspaceNames.get(target.workspaceId) ?? `Workspace ${target.workspaceId}`} · New chat for each run`
        : (chatNames.get(target.chatId) ?? `Chat ${target.chatId}`),
    sourceDirectory: schedule.sourceDirectory,
  };
}
