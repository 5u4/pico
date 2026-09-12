import { assert, describe, it } from "@effect/vitest";
import * as Chat from "@pico/contract/chat-model";
import * as Schedule from "@pico/contract/schedule";
import * as Workspace from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { executeScheduleOperation, scheduleToolNames } from "./schedule-extension.ts";

const context = {
  operation: "get",
  caller: {
    chatId: Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001"),
    workspaceId: Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000002"),
  },
  runEffect: Effect.runPromise,
} satisfies Parameters<typeof executeScheduleOperation>[1];

describe("schedule extension", () => {
  it("exposes the complete session-local management set", () => {
    assert.deepStrictEqual(Object.values(scheduleToolNames), [
      "schedule_create",
      "schedule_list",
      "schedule_get",
      "schedule_update",
      "schedule_delete",
    ]);
  });

  it.effect("marks rejected schedule operations as tool errors", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        executeScheduleOperation(
          Effect.fail(
            new Schedule.ScheduleError({ kind: "not-found", message: "Schedule not found" }),
          ),
          context,
        ),
      );
      assert.isTrue(result.isError);
      assert.deepStrictEqual(result.details, { message: "Schedule not found" });
    }),
  );

  it.effect("serializes void schedule operations safely", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() => executeScheduleOperation(Effect.void, context));
      assert.isFalse(result.isError);
      assert.deepStrictEqual(result.content, [{ type: "text", text: "null" }]);
    }),
  );
  it.effect("reports operational tool failures without logging rejected domain inputs", () => {
    const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
    return Effect.gen(function* () {
      const runEffect = Effect.runPromiseWith(yield* Effect.context<never>());
      const scheduleId = Schedule.ScheduleId.make("018f47a0-0000-7000-8000-000000000003");
      const operationContext = { ...context, runEffect, scheduleId };
      const expectedKinds: ReadonlyArray<Schedule.ScheduleError["kind"]> = [
        "invalid",
        "not-found",
        "busy",
        "conflict",
      ];
      for (const kind of expectedKinds) {
        const returned = yield* Effect.promise(() =>
          executeScheduleOperation(
            Effect.fail(new Schedule.ScheduleError({ kind, message: "private input" })),
            operationContext,
          ),
        );
        assert.isTrue(returned.isError);
      }
      assert.deepStrictEqual(records, []);
      for (const kind of ["io", "corrupt"] as const) {
        yield* Effect.promise(() =>
          executeScheduleOperation(
            Effect.fail(new Schedule.ScheduleError({ kind, message: "private document" })),
            operationContext,
          ),
        );
      }
      const defect = yield* Effect.promise(() =>
        executeScheduleOperation(Effect.die(new Error("private defect payload")), operationContext),
      );
      assert.isTrue(defect.isError);
      assert.strictEqual(records.length, 3);
      assert.deepStrictEqual(
        records.map((record) => record.annotations.failureKind),
        ["io", "corrupt", "defect"],
      );
      assert.isTrue(
        records.every(
          (record) =>
            record.level === "ERROR" &&
            record.annotations.scheduleId === scheduleId &&
            record.annotations.chatId === context.caller.chatId,
        ),
      );
      assert.notInclude(JSON.stringify(records), "private");
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => records.push(Logger.formatStructured.log(options))),
        ]),
      ),
    );
  });
});
