import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Chat from "./chat-model.ts";
import { AbsolutePath } from "./path.ts";
import * as Schedule from "./schedule.ts";
import * as Workspace from "./workspace-model.ts";

const scheduleId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000001");
const revision = Schedule.ScheduleRevision.make("018f47a0-0000-7000-8000-000000000003");
const runId = Schedule.ScheduleRunId.make(`scheduled-1735689600000-${revision}`);
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000002");
const workspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000003");
const sourceDirectory = AbsolutePath.make("/tmp/pico-schedule-source");
const definition = {
  version: 2,
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
const decodeUpdate = Schema.decodeUnknownSync(Schedule.UpdateSchedule, {
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
  it("requires a source directory for creation", () => {
    const common = {
      name: "nightly review",
      enabled: true,
      target: { kind: "workspace", workspaceId },
      trigger: { kind: "cron", expression: "0 9 * * 1", timeZone: "America/Los_Angeles" },
    } satisfies Pick<Schedule.CreateSchedule, "name" | "enabled" | "target" | "trigger">;
    const input = {
      ...common,
      sourceDirectory,
      scriptTimeoutMs: 30_000,
    } satisfies Schedule.CreateSchedule;
    assert.deepStrictEqual(decodeCreate(input), input);
    assert.throws(() => decodeCreate(common));
    assert.throws(() => decodeCreate({ ...common, sourceDirectory: null }));
    for (const source of [
      { script: "console.log('{}')" },
      { prompt: "Review." },
      { source: { script: null, prompt: "Review." } },
    ]) {
      assert.throws(() => decodeCreate({ ...input, ...source }));
      assert.throws(() => decodeUpdate(source));
    }
    assert.throws(() => decodeUpdate({ sourceDirectory }));
  });

  it("accepts partial metadata updates without source fields", () => {
    const updates = [
      {},
      { enabled: false },
      {
        name: "weekly review",
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1_735_689_600_000 },
      },
      { scriptTimeoutMs: Schedule.MAX_SCRIPT_TIMEOUT_MS },
    ] satisfies Array<Schedule.UpdateSchedule>;
    for (const update of updates) {
      assert.deepStrictEqual(decodeUpdate(update), update);
    }
    assert.throws(() => decodeUpdate({ name: "" }));
    assert.throws(() => decodeUpdate({ enabled: null }));
  });

  it("validates all explicit destination selectors for creation and retargeting", () => {
    for (const target of [
      { kind: "chat", chatId },
      { kind: "workspace", workspaceId },
      { kind: "external-chat", platform: "discord", externalId: "123456789012345678" },
      { kind: "external-workspace", platform: "discord", externalId: "234567890123456789" },
    ] satisfies ReadonlyArray<Schedule.ScheduleTargetInput>) {
      assert.deepStrictEqual(decodeUpdate({ target }).target, target);
      assert.deepStrictEqual(
        decodeCreate({
          name: "explicit target",
          enabled: false,
          sourceDirectory,
          trigger: { kind: "once", at: 1_000 },
          target,
        }).target,
        target,
      );
    }
    for (const target of [
      { kind: "chat", chatId: "123456789012345678" },
      { kind: "workspace", workspaceId: "018f47a0-0000-4000-8000-000000000003" },
      { kind: "chat", workspaceId },
      { kind: "workspace", chatId },
      { kind: "current-chat", chatId },
      { kind: "current-chat" },
      { kind: "current-workspace" },
      { kind: "external-chat", platform: "slack", externalId: "123" },
      { kind: "external-workspace", platform: "discord", externalId: "" },
      { kind: "external-chat", platform: "discord", externalId: "123", chatId },
      { kind: "chat", chatId, workspaceId },
    ]) {
      assert.throws(() => decodeUpdate({ target }));
      assert.throws(() =>
        decodeCreate({
          name: "invalid target",
          enabled: false,
          sourceDirectory,
          trigger: { kind: "once", at: 1_000 },
          target,
        }),
      );
    }
  });

  it("clears timeout overrides only through updates", () => {
    assert.deepStrictEqual(decodeUpdate({ scriptTimeoutMs: null }), { scriptTimeoutMs: null });
    assert.throws(() => decodeDefinition({ ...definition, scriptTimeoutMs: null }));
    assert.throws(() =>
      decodeCreate({
        name: "default timeout",
        enabled: false,
        target: { kind: "chat", chatId },
        trigger: { kind: "once", at: 1 },
        sourceDirectory,
        scriptTimeoutMs: null,
      }),
    );
  });

  it("returns the managed source directory instead of source text", () => {
    const decodeView = Schema.decodeUnknownSync(Schedule.ReadyScheduleView, {
      onExcessProperty: "error",
    });
    const view = {
      kind: "ready",
      id: scheduleId,
      state: "enabled",
      definition,
      sourceDirectory,
    } satisfies Schedule.ReadyScheduleView;
    assert.deepStrictEqual(decodeView(view), view);
    assert.throws(() => decodeView({ ...view, source: { script: null, prompt: "Review." } }));
  });

  it("exposes invalid schedule repair paths without inventing a path for conflicts", () => {
    const decodeView = Schema.decodeUnknownSync(Schedule.ScheduleView, {
      onExcessProperty: "error",
    });
    const invalid = {
      kind: "invalid",
      id: scheduleId,
      state: "disabled",
      error: "Missing entrypoint",
      sourceDirectory,
    } satisfies Schedule.InvalidScheduleView;
    assert.deepStrictEqual(decodeView(invalid), invalid);
    const conflicted = {
      ...invalid,
      state: "conflicted",
      sourceDirectory: null,
    } satisfies Schedule.InvalidScheduleView;
    assert.deepStrictEqual(decodeView(conflicted), conflicted);
  });

  it("rejects excess trigger fields and unsafe timestamps", () => {
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
      assert.throws(() => decodeUpdate({ scriptTimeoutMs }));
      assert.throws(() =>
        decodeCreate({
          name: "invalid timeout",
          enabled: true,
          target: { kind: "chat", chatId },
          trigger: { kind: "once", at: 1 },
          sourceDirectory,
          scriptTimeoutMs,
        }),
      );
    }
  });

  it("requires canonical scheduled and manual run IDs", () => {
    const decodeRunId = Schema.decodeUnknownSync(Schedule.ScheduleRunId);
    assert.strictEqual(decodeRunId(`scheduled-1735689600000-${revision}`), runId);
    const manual = `manual-018f47a0-0000-7000-8000-000000000099`;
    assert.strictEqual(decodeRunId(manual), manual);
    assert.throws(() => decodeRunId("scheduled-1735689600000"));
    assert.throws(() => decodeRunId("manual-018f47a0-0000-6000-8000-000000000099"));
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
