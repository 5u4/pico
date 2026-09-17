import { assert, describe, it } from "@effect/vitest";
import { ChatId } from "@pico/contract/chat-model";
import { AbsolutePath } from "@pico/contract/path";
import type { ScheduleOverviewResponse } from "@pico/contract/rpc";
import * as Schedule from "@pico/contract/schedule";
import { WorkspaceId } from "@pico/contract/workspace-model";
import { presentSchedule } from "./schedule-presentation.ts";

const revision = Schedule.ScheduleRevision.make("01900000-0000-7000-8000-000000000001");
const workspaceId = WorkspaceId.make("01900000-0000-7000-8000-000000000002");
const view: Schedule.ReadyScheduleView = {
  kind: "ready",
  id: Schedule.ScheduleId.make("01900000-0000-7000-8000-000000000003"),
  state: "enabled",
  sourceDirectory: AbsolutePath.make("/fixtures/schedules/report"),
  definition: {
    version: 2,
    revision,
    name: "Daily report",
    ownerWorkspaceId: workspaceId,
    createdByChatId: ChatId.make("01900000-0000-7000-8000-000000000004"),
    createdAt: 1_700_000_000_000,
    target: { kind: "workspace", workspaceId },
    trigger: { kind: "cron", expression: "0 9 * * *", timeZone: "UTC" },
  },
};
const failedRun: Schedule.ScheduleRunSummary = {
  id: Schedule.ScheduleRunId.make(`scheduled-1700000001000-${revision}`),
  definitionRevision: revision,
  scheduledFor: 1_700_000_001_000,
  claimedAt: 1_700_000_001_000,
  state: {
    kind: "finished",
    finishedAt: 1_700_000_002_000,
    outcome: { kind: "failed", stage: "script", message: "Report script: permission denied" },
  },
};
const entry: ScheduleOverviewResponse["entries"][number] = {
  view,
  ownerWorkspaceId: workspaceId,
  owner: { id: workspaceId, name: "Reports", platform: "web" },
  nextTrigger: { kind: "scheduled", at: 1_700_086_401_000 },
  lastRun: failedRun,
};

describe("schedule presentation", () => {
  it("attributes the same recorded run to the current or previous definition revision", () => {
    const current = presentSchedule(entry);
    const previous = presentSchedule({
      ...entry,
      view: {
        ...view,
        definition: {
          ...view.definition,
          revision: Schedule.ScheduleRevision.make("01900000-0000-7000-8000-000000000006"),
        },
      },
    });

    assert.match(current.lastRun.revision ?? "", /current/i);
    assert.match(previous.lastRun.revision ?? "", /previous/i);
  });

  it("keeps the recorded failure visible when the current definition is invalid", () => {
    const row = presentSchedule({
      ...entry,
      view: {
        kind: "invalid",
        id: view.id,
        state: "enabled",
        sourceDirectory: view.sourceDirectory,
        error: "Invalid cron expression in definition",
      },
      nextTrigger: { kind: "none", reason: "invalid" },
    });

    assert.match(row.lastRun.revision ?? "", /unavailable/i);
    assert.match(row.lastRun.label, /failed/i);
    assert.strictEqual(row.lastRun.tone, "danger");
    const details = row.details.map((detail) => detail.value).join("\n");
    assert.include(details, "permission denied");
    assert.include(details, "Invalid cron expression");
  });

  it("shows failure diagnostics and danger only for the failed result, not a successful run", () => {
    const failed = presentSchedule(entry);
    const succeeded = presentSchedule({
      ...entry,
      lastRun: {
        ...failedRun,
        state: {
          kind: "finished",
          finishedAt: 1_700_000_002_000,
          outcome: { kind: "completed" },
        },
      },
    });

    assert.strictEqual(failed.lastRun.tone, "danger");
    assert.include(failed.details.map((detail) => detail.value).join("\n"), "permission denied");
    assert.strictEqual(succeeded.lastRun.tone, "neutral");
    assert.strictEqual(
      succeeded.details.some((detail) => /failure/i.test(detail.label)),
      false,
    );
  });
});
