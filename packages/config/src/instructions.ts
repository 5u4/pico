import type { PicoRoot } from "@pico/contract/config";
import { ConfigError } from "@pico/contract/errors";
import type { InstructionsReader, InstructionsScope } from "@pico/contract/instructions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const DiscordId = Schema.String.check(Schema.isPattern(/^[0-9]+$/), Schema.isTrimmed());
const decodeDiscordId = Schema.decodeUnknownEffect(DiscordId);

// Daemon captures the instructions reader before composing session context.
export const make = Effect.fn("Instructions.make")(function* (root: PicoRoot) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const agentsDir = path.join(root, "agents");

  const read: InstructionsReader = Effect.fn("Instructions.read")(function* (
    scope: InstructionsScope,
  ) {
    const sources = [
      { path: path.join(agentsDir, "instructions.md"), heading: "Global instructions" },
    ];
    if (scope.kind === "discord") {
      const channelId = yield* decodeDiscordId(scope.channelId).pipe(
        Effect.mapError(
          () =>
            new ConfigError({
              message: "Invalid Discord channel ID for instructions",
            }),
        ),
      );
      if (scope.botId !== null) {
        const botId = yield* decodeDiscordId(scope.botId).pipe(
          Effect.mapError(
            () =>
              new ConfigError({
                message: "Invalid Discord bot ID for instructions",
              }),
          ),
        );
        sources.push({
          path: path.join(agentsDir, "discord", "bots", botId, "instructions.md"),
          heading: "Discord bot instructions",
        });
      }
      sources.push({
        path: path.join(agentsDir, "discord", "channels", channelId, "instructions.md"),
        heading: "Discord channel instructions",
      });
    }

    const sections = yield* Effect.forEach(sources, ({ path: sourcePath, heading }) =>
      fileSystem.readFileString(sourcePath).pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed("")
            : Effect.fail(
                new ConfigError({
                  message: `Failed to read ${heading.toLowerCase()} (${cause.reason._tag})`,
                }),
              ),
        ),
        Effect.map((source) => (source.trim().length === 0 ? "" : `## ${heading}\n\n${source}`)),
      ),
    );
    return sections.filter((section) => section.length > 0).join("\n\n");
  });

  return read;
});
