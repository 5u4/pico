import { assert, describe, it } from "@effect/vitest";
import * as Schedule from "@pico/contract/schedule";
import * as Effect from "effect/Effect";
import { executeScheduleOperation, scheduleToolNames } from "./schedule-extension.ts";

describe("schedule extension", () => {
  it("exposes the complete session-local management set", () => {
    assert.deepStrictEqual(Object.values(scheduleToolNames), [
      "schedule_create",
      "schedule_list",
      "schedule_get",
      "schedule_update",
      "schedule_set_enabled",
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
        ),
      );
      assert.isTrue(result.isError);
      assert.deepStrictEqual(result.details, { message: "Schedule not found" });
    }),
  );

  it.effect("serializes void schedule operations safely", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() => executeScheduleOperation(Effect.void));
      assert.isFalse(result.isError);
      assert.deepStrictEqual(result.content, [{ type: "text", text: "null" }]);
    }),
  );
});
