import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { AgentSessionStore } from "@pico/contract/agent-session-store";
import * as Chat from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { layer } from "./agent-session-store.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const chatId = Chat.ChatId.make("018f47a0-0000-7000-8000-000000000001");

describe("AgentSessionStore", () => {
  it.effect("creates a valid OMP journal and preserves it on collision", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-omp-session-store-",
      });
      const sessionsDir = AbsolutePath.make(path.join(temporaryDirectory, "sessions"));
      const cwd = AbsolutePath.make(path.join(temporaryDirectory, "workspace"));
      const sessionFile = path.join(sessionsDir, `${chatId}.jsonl`);

      yield* Effect.gen(function* () {
        const sessions = yield* AgentSessionStore;
        yield* sessions.create({ chatId, cwd });

        const content = yield* fileSystem.readFileString(sessionFile);
        for (const line of content.trimEnd().split("\n")) {
          assert.doesNotThrow(() => JSON.parse(line));
        }
        const loaded = parseSessionContent(content);
        assert.isFalse(loaded.invalidHeader);
        const header = loaded.entries[0];
        if (header?.type !== "session") return yield* Effect.die("missing OMP session header");
        assert.strictEqual(header.cwd, cwd);

        const beforeCollision = yield* fileSystem.readFile(sessionFile);
        assert.instanceOf(yield* sessions.create({ chatId, cwd }).pipe(Effect.flip), AgentError);
        assert.deepStrictEqual(yield* fileSystem.readFile(sessionFile), beforeCollision);
      }).pipe(Effect.provide(layer(sessionsDir)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
