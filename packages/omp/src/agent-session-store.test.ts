import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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
  it.effect("carries only the active branch's explicit model choice into a new journal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pico-model-continuity-" });
      const botRoot = AbsolutePath.make(path.join(root, "bot"));
      const cwd = AbsolutePath.make(path.join(botRoot, "work"));
      yield* Effect.gen(function* () {
        const store = yield* AgentSessionStore;
        const source = yield* store.createPhysical(botRoot, cwd);
        const manager = yield* Effect.acquireRelease(
          Effect.promise(() => SessionManager.open(source.file, path.dirname(source.file))),
          (manager) => Effect.promise(() => manager.close()),
        );
        const chosen = manager.appendModelChange("openai/gpt-4.1", "temporary");
        manager.appendModelChange("openai/abandoned", "temporary");
        manager.branch(chosen);
        manager.appendModelChange("openai/fallback", "temporary", true);
        manager.appendModelChange("openai/ephemeral", EPHEMERAL_MODEL_CHANGE_ROLE);
        yield* Effect.promise(() => manager.flush());
        const before = yield* fs.readFile(source.file);

        const next = yield* store.createPhysical(botRoot, cwd, source);
        assert.deepStrictEqual(yield* fs.readFile(source.file), before);
        const restored = yield* Effect.acquireRelease(
          Effect.promise(() => SessionManager.open(next.file, path.dirname(next.file))),
          (manager) => Effect.promise(() => manager.close()),
        );
        assert.strictEqual(
          getRestorableSessionModels(
            restored.buildSessionContext().models,
            restored.getLastModelChangeRole(),
          )[0],
          "openai/gpt-4.1",
        );
        assert.deepStrictEqual(restored.buildSessionContext().messages, []);
      }).pipe(Effect.provide(layer(AbsolutePath.make(path.join(root, "sessions")))));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );

  it.effect("creates, removes, and preserves an OMP journal on collision", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-omp-session-store-",
      });
      const sessionsDir = AbsolutePath.make(path.join(temporaryDirectory, "sessions"));
      const cwd = AbsolutePath.make(path.join(temporaryDirectory, "workspace"));
      const sessionFile = path.join(sessionsDir, `${chatId}.jsonl`);
      const attachmentsDirectory = path.join(sessionsDir, chatId, "attachments");
      const attachmentFile = path.join(attachmentsDirectory, "original.png");

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

        yield* fileSystem.makeDirectory(attachmentsDirectory, { recursive: true, mode: 0o700 });
        yield* fileSystem.writeFile(attachmentFile, Uint8Array.from([1, 2, 3]), { mode: 0o600 });
        const beforeCollision = yield* fileSystem.readFile(sessionFile);
        assert.instanceOf(yield* sessions.create({ chatId, cwd }).pipe(Effect.flip), AgentError);
        assert.deepStrictEqual(yield* fileSystem.readFile(sessionFile), beforeCollision);
        assert.deepStrictEqual(
          yield* fileSystem.readFile(attachmentFile),
          Uint8Array.from([1, 2, 3]),
        );
        yield* sessions.remove(chatId);
        assert.isFalse(yield* fileSystem.exists(sessionFile));
        assert.isFalse(yield* fileSystem.exists(path.join(sessionsDir, chatId)));
        yield* sessions.remove(chatId);
      }).pipe(Effect.provide(layer(sessionsDir)));
    }).pipe(Effect.provide(platformLayer), Effect.scoped),
  );
});
