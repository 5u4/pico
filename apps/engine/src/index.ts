import { BunRuntime } from "@effect/platform-bun";
import { Chats, makeSurface, PicoConfig, Store } from "@pico/core";
import { Console, Effect, Layer, Stream } from "effect";

const program = Effect.gen(function* () {
  const surface = yield* makeSurface("web");
  const prompt = process.argv[2] ?? "Say hello in one short sentence.";

  const space = yield* surface.createSpace({
    name: "local",
    cwd: process.cwd(),
  });
  const { session } = yield* surface.createChat(space.id, prompt.slice(0, 60));

  const printer = yield* Effect.fork(
    session.events.pipe(
      Stream.takeUntil((event) => event._tag === "agent_end"),
      Stream.runForEach((event) => {
        switch (event._tag) {
          case "text_delta":
            return Effect.sync(() => process.stdout.write(event.delta));
          case "thinking_delta":
            return Effect.sync(() =>
              process.stdout.write(`\x1b[2m${event.delta}\x1b[0m`),
            );
          case "tool_execution_start":
            return Console.log(`\n[tool ${event.toolName}]`);
          case "tool_execution_end":
            return Console.log(`[tool ${event.toolName} done]`);
          case "agent_end":
            return Console.log("\n[agent end]");
          case "error":
            return Console.error(`\n[error ${event.reason}] ${event.message}`);
          default:
            return Effect.void;
        }
      }),
    ),
  );

  yield* session.prompt(prompt);
  yield* printer.await;
});

BunRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.tapErrorCause(Console.error),
    Effect.provide(
      Layer.mergeAll(Chats.Default, Store.Default, PicoConfig.Default),
    ),
  ),
);
