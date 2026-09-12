import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { PicoRoot } from "@pico/contract/config";
import { ConfigError } from "@pico/contract/errors";
import type { InstructionsScope } from "@pico/contract/instructions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { make } from "./instructions.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const discord: InstructionsScope = { kind: "discord", botId: "123", channelId: "456" };

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = PicoRoot.make(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "pico-instructions-" }),
  );
  const read = yield* make(root);
  const put = Effect.fn("InstructionsTest.put")(function* (relativePath: string, source: string) {
    const target = path.join(root, "agents", relativePath);
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    yield* fileSystem.writeFileString(target, source);
    return target;
  });
  return { fileSystem, path, root, read, put };
});

describe("Instructions reader", () => {
  it.effect("ignores missing and blank files without altering meaningful Markdown", () =>
    Effect.gen(function* () {
      const { read, put } = yield* fixture;
      assert.strictEqual(yield* read(discord), "");
      yield* put("instructions.md", " \n\t\n");
      yield* put("discord/channels/456/instructions.md", "\n  \n");
      assert.strictEqual(yield* read(discord), "");

      const markdown = "\n    keep this code indented\n\nTrailing spaces matter.  \n";
      yield* put("discord/bots/123/instructions.md", markdown);
      const loaded = yield* read(discord);
      assert.include(loaded, markdown);
      assert.notInclude(loaded, "Global instructions");
      assert.notInclude(loaded, "Discord channel instructions");
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("loads global, bot, and channel in order and rereads edits and removals", () =>
    Effect.gen(function* () {
      const { fileSystem, read, put } = yield* fixture;
      yield* put("instructions.md", "global convention");
      const botFile = yield* put("discord/bots/123/instructions.md", "bot convention");
      yield* put("discord/channels/456/instructions.md", "channel convention");
      const loaded = yield* read(discord);
      assert.isBelow(loaded.indexOf("global convention"), loaded.indexOf("bot convention"));
      assert.isBelow(loaded.indexOf("bot convention"), loaded.indexOf("channel convention"));
      assert.include(loaded, "global convention");
      assert.include(loaded, "bot convention");
      assert.include(loaded, "channel convention");

      yield* put("discord/channels/456/instructions.md", "updated channel convention");
      yield* fileSystem.remove(botFile);
      const updated = yield* read(discord);
      assert.include(updated, "updated channel convention");
      assert.notInclude(updated, "bot convention");
      assert.notInclude(yield* read({ kind: "global" }), "channel convention");
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("reports non-missing read failures with their path and filesystem cause", () =>
    Effect.gen(function* () {
      const { fileSystem, path, root, read } = yield* fixture;
      const target = path.join(root, "agents", "instructions.md");
      yield* fileSystem.makeDirectory(target, { recursive: true });
      const cause = yield* fileSystem.readFileString(target).pipe(Effect.flip);
      const error = yield* read({ kind: "global" }).pipe(Effect.flip);
      assert.instanceOf(error, ConfigError);
      assert.include(error.message, target);
      assert.include(error.message, cause.message);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("rejects unsafe Discord IDs before reading instructions", () =>
    Effect.gen(function* () {
      const { read, put } = yield* fixture;
      yield* put("instructions.md", "global instructions must not hide invalid scope");
      const scopes: Array<InstructionsScope> = [
        { kind: "discord", botId: "../456", channelId: "456" },
        { kind: "discord", botId: null, channelId: "../../instructions.md" },
        { kind: "discord", botId: "", channelId: "456" },
        { kind: "discord", botId: null, channelId: "456\n" },
      ];
      for (const scope of scopes) {
        const error = yield* read(scope).pipe(Effect.flip);
        assert.instanceOf(error, ConfigError);
        assert.include(error.message, "Invalid Discord");
      }
    }).pipe(Effect.provide(platformLayer)),
  );
});
