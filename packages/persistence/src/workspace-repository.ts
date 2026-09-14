import { PersistenceError } from "@pico/contract/errors";
import * as Workspace from "@pico/contract/workspace-model";
import { WorkspaceRepository } from "@pico/contract/workspace-repository";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { failure } from "./error.ts";

const worktreeColumns = {
  worktreeBranch: Schema.NullOr(Workspace.WorktreeSettings.fields.branch),
  worktreePrefix: Schema.NullOr(Workspace.WorktreeSettings.fields.prefix),
};
const WorkspaceRow = Workspace.Workspace.mapMembers(([native, foreign]) => [
  native.mapFields((fields) => ({
    ...Struct.omit(fields, ["worktree"]),
    ...worktreeColumns,
  })),
  foreign.mapFields((fields) => ({
    ...Struct.omit(fields, ["worktree"]),
    ...worktreeColumns,
  })),
]);
type WorkspaceRow = typeof WorkspaceRow.Type;

const BoundWorkspace = Workspace.Workspace.members[1];

const ReplaceConfiguration = Schema.Struct({
  id: Workspace.WorkspaceId,
  configuration: Workspace.WorkspaceConfiguration,
});

const decodeWorkspace = Effect.fn("WorkspaceRepository.decodeWorkspace")(function* (
  row: WorkspaceRow,
) {
  const { worktreeBranch, worktreePrefix, ...workspace } = row;
  let worktree: Workspace.WorktreeSettings | null;
  if (worktreeBranch === null && worktreePrefix === null) {
    worktree = null;
  } else if (worktreeBranch !== null && worktreePrefix !== null) {
    worktree = { branch: worktreeBranch, prefix: worktreePrefix };
  } else {
    return yield* Effect.fail(
      new PersistenceError({ message: "invalid stored workspace worktree column pair" }),
    );
  }

  return { ...workspace, worktree };
});

const make = Effect.fn("WorkspaceRepository.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WorkspaceRow,
    execute: () => sql`
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
      ORDER BY created_at DESC, id DESC
    `,
  });

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
        ${workspace.platform},
        ${workspace.externalId},
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

  const insertByBinding = SqlSchema.void({
    Request: BoundWorkspace,
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
        ${workspace.platform},
        ${workspace.externalId},
        ${workspace.defaultCwd},
        ${workspace.worktree?.branch ?? null},
        ${workspace.worktree?.prefix ?? null},
        ${workspace.createdAt}
      )
      ON CONFLICT(platform, external_id) DO NOTHING
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

  const bindingQuery = {
    Request: Workspace.WorkspaceBinding,
    Result: WorkspaceRow,
    execute: ({ platform, externalId }: Workspace.WorkspaceBinding) => sql`
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
      WHERE platform = ${platform} AND external_id = ${externalId}
    `,
  };
  const selectByBinding = SqlSchema.findOneOption(bindingQuery);
  const requireByBinding = SqlSchema.findOne(bindingQuery);

  const replaceStoredConfiguration = SqlSchema.findOne({
    Request: ReplaceConfiguration,
    Result: WorkspaceRow,
    execute: ({ id, configuration }) => sql`
      UPDATE workspaces
      SET
        default_cwd = ${configuration.defaultCwd},
        worktree_branch = ${configuration.worktree?.branch ?? null},
        worktree_prefix = ${configuration.worktree?.prefix ?? null}
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

  const list = Effect.fn("WorkspaceRepository.list")(
    function* () {
      const rows = yield* selectAll(undefined);
      return yield* Effect.forEach(rows, decodeWorkspace);
    },
    Effect.mapError(failure("workspace.list")),
  );

  const create = Effect.fn("WorkspaceRepository.create")(
    function* (workspace: Workspace.Workspace) {
      return yield* decodeWorkspace(yield* insert(workspace));
    },
    Effect.mapError(failure("workspace.create")),
  );

  const getOrCreateByBinding = Effect.fn("WorkspaceRepository.getOrCreateByBinding")(
    function* (workspace: typeof BoundWorkspace.Type) {
      yield* insertByBinding(workspace);
      return yield* decodeWorkspace(yield* requireByBinding(workspace));
    },
    sql.withTransaction,
    Effect.mapError(failure("Failed to get or create workspace")),
  );

  const findById = Effect.fn("WorkspaceRepository.findById")(
    function* (id: Workspace.WorkspaceId) {
      const row = yield* selectById(id);
      if (Option.isNone(row)) {
        return Option.none<Workspace.Workspace>();
      }
      return Option.some(yield* decodeWorkspace(row.value));
    },
    Effect.mapError(failure("workspace.findById")),
  );

  const findByBinding = Effect.fn("WorkspaceRepository.findByBinding")(
    function* (binding: Workspace.WorkspaceBinding) {
      const row = yield* selectByBinding(binding);
      if (Option.isNone(row)) {
        return Option.none<Workspace.Workspace>();
      }
      return Option.some(yield* decodeWorkspace(row.value));
    },
    Effect.mapError(failure("workspace.findByBinding")),
  );

  const replaceConfiguration = Effect.fn("WorkspaceRepository.replaceConfiguration")(
    function* (id: Workspace.WorkspaceId, configuration: Workspace.WorkspaceConfiguration) {
      return yield* decodeWorkspace(yield* replaceStoredConfiguration({ id, configuration }));
    },
    Effect.mapError(failure("workspace.replaceConfiguration")),
  );

  return WorkspaceRepository.of({
    list,
    create,
    getOrCreateByBinding,
    findById,
    findByBinding,
    replaceConfiguration,
  });
});

export const layer = Layer.effect(WorkspaceRepository, make());
