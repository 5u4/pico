import type { ScheduleOverviewResponse } from "@pico/contract/rpc";
import * as Schedule from "@pico/contract/schedule";
import type { ScheduleRow } from "./chat/chat-model.ts";

const localTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "long",
});

export function formatScheduleTime(at: number): string {
  return Number.isFinite(new Date(at).getTime())
    ? localTime.format(at)
    : "Date outside browser range";
}

const runLabels = {
  claimed: "Claimed",
  "target-resolved": "Target resolved",
  "running-script": "Script phase recorded",
  "running-omp": "Agent phase recorded",
  skipped: "Skipped",
  published: "Published",
  completed: "Completed",
  missed: "Missed",
  failed: "Failed",
  interrupted: "Interrupted",
} as const;

export function presentSchedule(entry: ScheduleOverviewResponse["entries"][number]): ScheduleRow {
  const { view, owner, ownerWorkspaceId, lastRun } = entry;
  const details: Array<{ readonly label: string; readonly value: string }> = [
    { label: "Schedule ID", value: view.id },
    { label: "Owner workspace ID", value: ownerWorkspaceId ?? "Unknown" },
    { label: "Owner platform", value: owner?.platform ?? "Unknown" },
  ];
  if (view.sourceDirectory !== null) {
    details.push({ label: "Source directory", value: view.sourceDirectory });
  }
  if (view.kind === "ready") {
    const { definition } = view;
    details.push(
      { label: "Definition revision", value: definition.revision },
      { label: "Created", value: formatScheduleTime(definition.createdAt) },
      { label: "Created by chat", value: definition.createdByChatId },
      {
        label: definition.target.kind === "chat" ? "Target chat ID" : "Target workspace ID",
        value:
          definition.target.kind === "chat"
            ? definition.target.chatId
            : `${definition.target.workspaceId} · New chat for each run`,
      },
      {
        label: "Script timeout",
        value: `${definition.scriptTimeoutMs ?? Schedule.DEFAULT_SCRIPT_TIMEOUT_MS} ms${definition.scriptTimeoutMs === undefined ? " · Default" : ""}`,
      },
    );
    if (definition.trigger.kind === "once") {
      const date = new Date(definition.trigger.at);
      details.push({
        label: "Scheduled time UTC",
        value: Number.isFinite(date.getTime()) ? date.toISOString() : "Date outside browser range",
      });
    }
  } else {
    details.push(
      { label: "Definition problem", value: view.error },
      { label: "Stored state", value: view.state },
    );
  }
  let recorded: ScheduleRow["lastRun"] = {
    label: "No recorded run",
    timestamp: null,
    revision: null,
    tone: "neutral",
  };
  if (lastRun !== null) {
    const state = lastRun.state;
    const outcome = state.kind === "finished" ? state.outcome : null;
    recorded = {
      label: state.kind === "finished" ? runLabels[state.outcome.kind] : runLabels[state.kind],
      timestamp: formatScheduleTime(
        state.kind === "finished"
          ? state.finishedAt
          : state.kind === "running-script" || state.kind === "running-omp"
            ? state.startedAt
            : lastRun.claimedAt,
      ),
      revision:
        view.kind === "invalid"
          ? "Current revision unavailable"
          : lastRun.definitionRevision === view.definition.revision
            ? "Current definition revision"
            : "Previous definition revision",
      tone:
        outcome?.kind === "failed" || outcome?.kind === "missed" || outcome?.kind === "interrupted"
          ? "danger"
          : "neutral",
    };
    details.push(
      { label: "Last recorded run ID", value: lastRun.id },
      { label: "Run definition revision", value: lastRun.definitionRevision },
      { label: "Run scheduled for", value: formatScheduleTime(lastRun.scheduledFor) },
      { label: "Run claimed", value: formatScheduleTime(lastRun.claimedAt) },
    );
    if (state.kind === "finished") {
      details.push({ label: "Run finished", value: formatScheduleTime(state.finishedAt) });
    } else if (state.kind === "running-script" || state.kind === "running-omp") {
      details.push({ label: "Recorded phase started", value: formatScheduleTime(state.startedAt) });
    }
    if (outcome?.kind === "failed") {
      details.push(
        { label: "Failure stage", value: outcome.stage },
        { label: "Failure", value: outcome.message },
      );
    } else if (outcome?.kind === "interrupted") {
      details.push({ label: "Interrupted phase", value: outcome.phase });
    }
  }
  const trigger = view.kind === "ready" ? view.definition.trigger : null;
  return {
    id: view.id,
    name: view.kind === "ready" ? view.definition.name : view.id,
    owner: owner?.name ?? (ownerWorkspaceId === null ? "Unknown workspace" : "Missing workspace"),
    platform: owner?.platform ?? "Platform unknown",
    definitionState: view.kind === "invalid" ? "invalid" : view.state,
    trigger:
      trigger === null
        ? "Trigger unavailable"
        : trigger.kind === "cron"
          ? trigger.expression
          : `Once · ${formatScheduleTime(trigger.at)}`,
    timeZone:
      trigger?.kind === "cron"
        ? trigger.timeZone
        : trigger?.kind === "once"
          ? "One-time instant · Shown in your timezone"
          : "Timezone unavailable",
    nextTrigger:
      entry.nextTrigger.kind === "scheduled"
        ? formatScheduleTime(entry.nextTrigger.at)
        : entry.nextTrigger.kind === "unavailable"
          ? "Could not calculate"
          : entry.nextTrigger.reason === "past-once"
            ? "No future trigger · Scheduled time has passed"
            : entry.nextTrigger.reason === "disabled"
              ? "None · Disabled"
              : "None · Invalid definition",
    lastRun: recorded,
    details,
  };
}
