import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Chat from "./chat-model.ts";
import * as Schedule from "./schedule.ts";
import * as Workspace from "./workspace-model.ts";

const scheduleId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000001");
const revision = Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000003");
const runId = Schedule.ScheduleRunId.make(`scheduled-1735689600000-${revision}`);
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000003");
const definition = {
  version: 1,
  revision,
  name: "nightly review",
  ownerWorkspaceId: workspaceId,
  createdByChatId: chatId,
  createdAt: 1_735_689_600_000,
  target: { kind: "workspace", workspaceId },
  trigger: { kind: "cron", expression: "0 9 * * 1", timeZone: "America/Los_Angeles" },
} satisfies Schedule.ScheduleDefinition;
const decodeCreate = Schema.decodeUnknownSync(Schedule.CreateSchedule, {
  onExcessProperty: "error",
});
const decodeDefinition = Schema.decodeUnknownSync(Schedule.ScheduleDefinition, {
  onExcessProperty: "error",
});
const decodeTrigger = Schema.decodeUnknownSync(Schedule.ScheduleTrigger, {
  onExcessProperty: "error",
});
const decodeDecision = Schema.decodeUnknownSync(Schedule.ScriptDecision, {
  onExcessProperty: "error",
});
const decodeRun = Schema.decodeUnknownSync(Schedule.ScheduleRunLifecycle, {
  onExcessProperty: "error",
});

describe("schedule contract", () => {
  it("requires at least one source without an execution discriminator", () => {
    const common = {
      name: "nightly review",
      enabled: true,
      target: { kind: "current-workspace" },
      trigger: { kind: "cron", expression: "0 9 * * 1", timeZone: "America/Los_Angeles" },
    } satisfies Pick<Schedule.CreateSchedule, "name" | "enabled" | "target" | "trigger">;
    assert.deepStrictEqual(
      decodeCreate({
        ...common,
        script: "process.stdout.write('{}')",
        prompt: "Review.",
        scriptTimeoutMs: 30_000,
      }),
      {
        ...common,
        script: "process.stdout.write('{}')",
        prompt: "Review.",
        scriptTimeoutMs: 30_000,
      },
    );
    assert.deepStrictEqual(decodeCreate({ ...common, prompt: "Review." }), {
      ...common,
      prompt: "Review.",
    });
    assert.throws(() => decodeCreate(common));
    assert.throws(() => decodeTrigger({ kind: "once", at: 1, expression: "* * * * *" }));
    assert.deepStrictEqual(decodeTrigger({ kind: "once", at: Number.MAX_SAFE_INTEGER }), {
      kind: "once",
      at: Number.MAX_SAFE_INTEGER,
    });
    assert.throws(() => decodeTrigger({ kind: "once", at: Number.MAX_SAFE_INTEGER + 1 }));
  });

  it("strictly decodes two-field script decisions", () => {
    for (const decision of [
      { agent: false },
      { agent: false, content: "publish" },
      { agent: true },
      { agent: true, content: "agent input" },
    ]) {
      assert.deepStrictEqual(decodeDecision(decision), decision);
    }
    for (const invalid of [
      { agent: false, content: "" },
      { agent: true, content: "", extra: true },
      { agent: false, extra: "unknown" },
    ]) {
      assert.throws(() => decodeDecision(invalid));
    }
  });

  it("keeps script timeout optional and bounded in metadata and inputs", () => {
    assert.deepStrictEqual(decodeDefinition(definition), definition);
    assert.deepStrictEqual(
      decodeDefinition({ ...definition, scriptTimeoutMs: Schedule.MAX_SCRIPT_TIMEOUT_MS }),
      { ...definition, scriptTimeoutMs: Schedule.MAX_SCRIPT_TIMEOUT_MS },
    );
    for (const scriptTimeoutMs of [0, 1.5, Schedule.MAX_SCRIPT_TIMEOUT_MS + 1]) {
      assert.throws(() => decodeDefinition({ ...definition, scriptTimeoutMs }));
      assert.throws(() =>
        decodeCreate({
          name: "invalid timeout",
          enabled: true,
          target: { kind: "current-chat" },
          trigger: { kind: "once", at: 1 },
          prompt: "Review.",
          scriptTimeoutMs,
        }),
      );
    }
  });

  it("requires the schedule revision in run IDs", () => {
    const decodeRunId = Schema.decodeUnknownSync(Schedule.ScheduleRunId);
    assert.strictEqual(decodeRunId(`scheduled-1735689600000-${revision}`), runId);
    assert.throws(() => decodeRunId("scheduled-1735689600000"));
    const decodeScheduleId = Schema.decodeUnknownSync(Schedule.ScheduleId);
    const uppercase = "018F47A0-0000-7000-8ABC-ABCDEFABCDEF";
    assert.strictEqual(decodeScheduleId(uppercase), uppercase);
  });

  it("round-trips one authoritative schedule run lifecycle", () => {
    const claimed = decodeRun({
      version: 1,
      id: runId,
      scheduleId,
      definitionRevision: revision,
      source: { kind: "scheduled", scheduledFor: 1_735_689_600_000 },
      plannedTarget: {
        kind: "existing-chat",
        ownerWorkspaceId: "018f47a0-0000-7000-8000-000000000003",
        chatId: "018f47a0-0000-7000-8000-000000000002",
      },
      claimedAt: 1_735_689_600_010,
      state: { kind: "claimed" },
    });
    assert.strictEqual(claimed.state.kind, "claimed");

    const finished = decodeRun({
      ...claimed,
      state: {
        kind: "finished",
        finishedAt: 1_735_689_600_020,
        outcome: {
          kind: "missed",
          scheduledFor: 1_735_689_600_000,
          observedAt: 1_735_689_600_020,
        },
      },
    });
    assert.strictEqual(finished.state.kind, "finished");
  });
});
