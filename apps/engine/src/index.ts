import { BunRuntime } from "@effect/platform-bun";
import { Chats } from "@pico/core";
import { Console, Effect, Stream } from "effect";
import { ulid } from "ulid";

const program = Effect.gen(function* () {
  const chats = yield* Chats;
  const prompt = process.argv[2] ?? "Say hello in one short sentence.";

  const chat = yield* chats.getOrCreate(ulid(), { cwd: process.cwd() });

  const printer = yield* Effect.fork(
    chat.events.pipe(
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

  yield* chat.prompt(prompt);
  yield* printer.await;
});

BunRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.tapErrorCause(Console.error),
    Effect.provide(Chats.Default),
  ),
);
