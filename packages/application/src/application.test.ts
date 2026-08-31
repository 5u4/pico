import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Application } from "@pico/contract/application";
import { ApplicationError } from "@pico/contract/errors";
import { AbsolutePath } from "@pico/contract/path";
import * as Workspace from "@pico/contract/workspace-model";
import * as Persistence from "@pico/persistence/layer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as ApplicationLayer from "./layer.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const missingWorkspaceId = Workspace.WorkspaceId.make("018f47a0-0000-7000-8000-000000000099");

const assertApplicationError = (error: ApplicationError, message: string) => {
  assert.instanceOf(error, ApplicationError);
  assert.strictEqual(error.message, message);
};

describe("Application", () => {
  it.effect("creates workspaces and regular chats at the application boundary", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pico-application-",
      });
      const storeFile = AbsolutePath.make(path.join(temporaryDirectory, "store.db"));
      const defaultCwd = AbsolutePath.make(path.join(temporaryDirectory, "workspace"));

      yield* Effect.gen(function* () {
        const application = yield* Application;

        yield* TestClock.setTime(1_000);
        const workspace = yield* application.createWorkspace({
          name: "pico",
          binding: null,
          defaultCwd,
          worktree: null,
        });
        assert.match(workspace.id, uuidV7);
        assert.strictEqual(workspace.createdAt, 1_000);

        yield* TestClock.setTime(2_000);
        const chat = yield* application.createRegularChat({
          workspaceId: workspace.id,
          externalId: null,
        });
        assert.match(chat.id, uuidV7);
        assert.strictEqual(chat.cwd, defaultCwd);
        assert.strictEqual(chat.createdAt, 2_000);
        assert.strictEqual(chat.archivedAt, null);

        yield* TestClock.setTime(3_000);
        const worktreeWorkspace = yield* application.createWorkspace({
          name: "worktree",
          binding: null,
          defaultCwd,
          worktree: { branch: "main", prefix: "chat/" },
        });
        assert.match(worktreeWorkspace.id, uuidV7);
        assert.notStrictEqual(worktreeWorkspace.id, workspace.id);

        assertApplicationError(
          yield* Effect.flip(
            application.createRegularChat({
              workspaceId: worktreeWorkspace.id,
              externalId: null,
            }),
          ),
          "Failed to create regular chat",
        );
        assertApplicationError(
          yield* Effect.flip(
            application.createRegularChat({
              workspaceId: missingWorkspaceId,
              externalId: null,
            }),
          ),
          "Failed to create regular chat",
        );
      }).pipe(
        Effect.provide(ApplicationLayer.layer),
        Effect.provide(Persistence.layer(storeFile)),
        Effect.provide(BunCrypto.layer),
        Effect.scoped,
      );
    }).pipe(Effect.provide(platformLayer)),
  );
});
