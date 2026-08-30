import { AbsolutePath } from "@pico/contract/config/path";
import { PersistenceError } from "@pico/contract/persistence/error";
import * as Workspace from "@pico/contract/workspace";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const WorkspaceRow = Schema.Struct({
  id: Workspace.WorkspaceId,
  name: Schema.NonEmptyString,
  platform: Schema.NullOr(Workspace.WorkspacePlatform),
  externalId: Schema.NullOr(Schema.NonEmptyString),
  defaultCwd: AbsolutePath,
  worktreeBranch: Schema.NullOr(Schema.NonEmptyString),
  worktreePrefix: Schema.NullOr(Schema.NonEmptyString),
  createdAt: Schema.Natural,
});
type WorkspaceRow = typeof WorkspaceRow.Type;

const ChangeDefaultCwd = Schema.Struct({
  id: Workspace.WorkspaceId,
  cwd: AbsolutePath,
});

const failure = (message: string) => () => new PersistenceError({ message });

const decodeWorkspace = Effect.fn("WorkspaceRepository.decodeWorkspace")(function* (
  row: WorkspaceRow,
) {
  let binding: Workspace.WorkspaceBinding | null;
  if (row.platform === null && row.externalId === null) {
    binding = null;
  } else if (row.platform !== null && row.externalId !== null) {
    binding = { platform: row.platform, externalId: row.externalId };
  } else {
    return yield* Effect.fail(new PersistenceError({ message: "Stored workspace is invalid" }));
  }

  let worktree: Workspace.WorktreeSettings | null;
  if (row.worktreeBranch === null && row.worktreePrefix === null) {
    worktree = null;
  } else if (row.worktreeBranch !== null && row.worktreePrefix !== null) {
    worktree = { branch: row.worktreeBranch, prefix: row.worktreePrefix };
  } else {
    return yield* Effect.fail(new PersistenceError({ message: "Stored workspace is invalid" }));
  }

  return {
    id: row.id,
    name: row.name,
    binding,
    defaultCwd: row.defaultCwd,
    worktree,
    createdAt: row.createdAt,
  };
});

const make = Effect.fn("WorkspaceRepository.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insert = SqlSchema.findOne({
    Request: Workspace.Workspace,
    Result: WorkspaceRow,
    execute: (workspace) => sql`
      INSERT INTO workspaces (
        id,
        name,
        platform,
        external_id,
        default_cwd,
        worktree_branch,
        worktree_prefix,
        created_at
      ) VALUES (
        ${workspace.id},
        ${workspace.name},
        ${workspace.binding?.platform ?? null},
        ${workspace.binding?.externalId ?? null},
        ${workspace.defaultCwd},
        ${workspace.worktree?.branch ?? null},
        ${workspace.worktree?.prefix ?? null},
        ${workspace.createdAt}
      )
      RETURNING
        id,
        name,
        platform,
        external_id AS "externalId",
        default_cwd AS "defaultCwd",
        worktree_branch AS "worktreeBranch",
        worktree_prefix AS "worktreePrefix",
        created_at AS "createdAt"
    `,
  });

  const selectById = SqlSchema.findOneOption({
    Request: Workspace.WorkspaceId,
    Result: WorkspaceRow,
    execute: (id) => sql`
      SELECT
        id,
        name,
        platform,
        external_id AS "externalId",
        default_cwd AS "defaultCwd",
        worktree_branch AS "worktreeBranch",
        worktree_prefix AS "worktreePrefix",
        created_at AS "createdAt"
      FROM workspaces
      WHERE id = ${id}
    `,
  });

  const updateDefaultCwd = SqlSchema.findOne({
    Request: ChangeDefaultCwd,
    Result: WorkspaceRow,
    execute: ({ id, cwd }) => sql`
      UPDATE workspaces
      SET default_cwd = ${cwd}
      WHERE id = ${id}
      RETURNING
        id,
        name,
        platform,
        external_id AS "externalId",
        default_cwd AS "defaultCwd",
        worktree_branch AS "worktreeBranch",
        worktree_prefix AS "worktreePrefix",
        created_at AS "createdAt"
    `,
  });

  const create = Effect.fn("WorkspaceRepository.create")(
    function* (workspace: Workspace.Workspace) {
      return yield* decodeWorkspace(yield* insert(workspace));
    },
    Effect.mapError(failure("Failed to create workspace")),
  );

  const findById = Effect.fn("WorkspaceRepository.findById")(
    function* (id: Workspace.WorkspaceId) {
      const row = yield* selectById(id);
      if (Option.isNone(row)) {
        return Option.none<Workspace.Workspace>();
      }
      return Option.some(yield* decodeWorkspace(row.value));
    },
    Effect.mapError(failure("Failed to find workspace")),
  );

  const changeDefaultCwd = Effect.fn("WorkspaceRepository.changeDefaultCwd")(
    function* (id: Workspace.WorkspaceId, cwd: typeof AbsolutePath.Type) {
      return yield* decodeWorkspace(yield* updateDefaultCwd({ id, cwd }));
    },
    Effect.mapError(failure("Failed to change workspace cwd")),
  );

  return Workspace.WorkspaceRepository.of({ create, findById, changeDefaultCwd });
});

export const layer = Layer.effect(Workspace.WorkspaceRepository, make());
