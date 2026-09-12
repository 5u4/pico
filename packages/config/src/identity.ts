import type { PicoRoot } from "@pico/contract/config";
import { ConfigError } from "@pico/contract/errors";
import type { IdentityReader, IdentityScope } from "@pico/contract/identity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const DiscordId = Schema.String.check(Schema.isPattern(/^[0-9]+$/), Schema.isTrimmed());
const decodeDiscordId = Schema.decodeUnknownEffect(DiscordId);

// Daemon captures the identity reader before composing session context.
export const make = Effect.fn("Identity.make")(function* (root: PicoRoot) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const agentsDir = path.join(root, "agents");

  const read: IdentityReader = Effect.fn("Identity.read")(function* (scope: IdentityScope) {
    const sources = [{ path: path.join(agentsDir, "identity.md"), heading: "Global identity" }];
    if (scope.kind === "discord") {
      const channelId = yield* decodeDiscordId(scope.channelId).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              message: `Invalid Discord channel ID for identity ${JSON.stringify(scope.channelId)}: ${cause.message}`,
            }),
        ),
      );
      if (scope.botId !== null) {
        const botId = yield* decodeDiscordId(scope.botId).pipe(
          Effect.mapError(
            (cause) =>
              new ConfigError({
                message: `Invalid Discord bot ID for identity ${JSON.stringify(scope.botId)}: ${cause.message}`,
              }),
          ),
        );
        sources.push({
          path: path.join(agentsDir, "discord", "bots", botId, "identity.md"),
          heading: "Discord bot identity",
        });
      }
      sources.push({
        path: path.join(agentsDir, "discord", "channels", channelId, "identity.md"),
        heading: "Discord channel identity",
      });
    }

    const sections = yield* Effect.forEach(sources, ({ path: sourcePath, heading }) =>
      fileSystem.readFileString(sourcePath).pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed("")
            : Effect.fail(
                new ConfigError({
                  message: `Failed to read identity file ${sourcePath}: ${cause.message}`,
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
