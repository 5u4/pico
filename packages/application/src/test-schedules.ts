import { Schedules } from "@pico/contract/schedule";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const unused = () => Effect.die("Unexpected schedule operation");

export const unusedSchedulesLayer = Layer.succeed(
  Schedules,
  Schedules.of({
    create: unused,
    list: unused,
    overview: unused,
    get: unused,
    update: unused,
    remove: unused,
    withCurrentTargets: unused,
    start: unused,
  }),
);
