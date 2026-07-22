import { BunRuntime } from "@effect/platform-bun";
import { Core } from "@pico/core";
import { ThreadState } from "@pico/web-protocol";
import { Effect, Schema } from "effect";

const program = Effect.gen(function* () {
  const core = yield* Core;
  const message = yield* core.greet("pico");
  const encoded = yield* Schema.encode(ThreadState)({
    threadId: null,
    messages: [],
  });
  yield* Effect.log(
    `${message} — engine ready, threads=${encoded.messages.length}`,
  );
});

BunRuntime.runMain(program.pipe(Effect.provide(Core.Default)));
