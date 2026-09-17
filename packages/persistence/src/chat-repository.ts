import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import * as Workspace from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { failure } from "./error.ts";

const ExternalChat = Schema.Struct({
  workspaceId: Workspace.WorkspaceId,
  externalId: Schema.NonEmptyString,
});

const ArchiveChat = Schema.Struct({
  id: Chat.ChatId,
  archivedAt: Schema.Natural,
});

const BindExternalId = Schema.Struct({
  chatId: Chat.ChatId,
  workspaceId: Workspace.WorkspaceId,
  externalId: Schema.NonEmptyString,
});

const make = Effect.fn("ChatRepository.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectOpenByWorkspace = SqlSchema.findAll({
    Request: Workspace.WorkspaceId,
    Result: Chat.Chat,
    execute: (workspaceId) => sql`
      SELECT
        id,
        workspace_id AS "workspaceId",
        cwd,
        external_id AS "externalId",
        created_at AS "createdAt",
        archived_at AS "archivedAt"
      FROM chats
      WHERE workspace_id = ${workspaceId} AND archived_at IS NULL
      ORDER BY created_at DESC, id DESC
    `,
  });

  const insert = SqlSchema.findOne({
    Request: Chat.NewChat,
    Result: Chat.Chat,
    execute: (chat) => sql`
      INSERT INTO chats (id, workspace_id, cwd, external_id, created_at)
      SELECT
        ${chat.id},
        ${chat.workspaceId},
        ${chat.cwd},
        ${chat.externalId},
        ${chat.createdAt}
      FROM workspaces WHERE id = ${chat.workspaceId} AND deleted_at IS NULL
      RETURNING
        id,
        workspace_id AS "workspaceId",
        cwd,
        external_id AS "externalId",
        created_at AS "createdAt",
        archived_at AS "archivedAt"
    `,
  });

  const updateArchive = SqlSchema.findOneOption({
    Request: ArchiveChat,
    Result: Chat.Chat,
    execute: ({ id, archivedAt }) => sql`
      UPDATE chats
      SET archived_at = COALESCE(archived_at, ${archivedAt})
      WHERE id = ${id}
      RETURNING
        id,
        workspace_id AS "workspaceId",
        cwd,
        external_id AS "externalId",
        created_at AS "createdAt",
        archived_at AS "archivedAt"
    `,
  });

  const updateExternalId = SqlSchema.findOneOption({
    Request: BindExternalId,
    Result: Chat.Chat,
    execute: ({ chatId, workspaceId, externalId }) => sql`
      UPDATE chats
      SET external_id = ${externalId}
      WHERE id = ${chatId}
        AND workspace_id = ${workspaceId}
        AND archived_at IS NULL
        AND external_id IS NULL
      RETURNING
        id,
        workspace_id AS "workspaceId",
        cwd,
        external_id AS "externalId",
        created_at AS "createdAt",
        archived_at AS "archivedAt"
    `,
  });

  const selectById = SqlSchema.findOneOption({
    Request: Chat.ChatId,
    Result: Chat.Chat,
    execute: (id) => sql`
      SELECT
        id,
        workspace_id AS "workspaceId",
        cwd,
        external_id AS "externalId",
        created_at AS "createdAt",
        archived_at AS "archivedAt"
      FROM chats
      WHERE id = ${id}
    `,
  });

  const selectByExternalId = SqlSchema.findOneOption({
    Request: ExternalChat,
    Result: Chat.Chat,
    execute: ({ workspaceId, externalId }) => sql`
      SELECT
        id,
        workspace_id AS "workspaceId",
        cwd,
        external_id AS "externalId",
        created_at AS "createdAt",
        archived_at AS "archivedAt"
      FROM chats
      WHERE workspace_id = ${workspaceId} AND external_id = ${externalId}
    `,
  });

  const listOpenByWorkspace = Effect.fn("ChatRepository.listOpenByWorkspace")(
    function* (workspaceId: Workspace.WorkspaceId) {
      return yield* selectOpenByWorkspace(workspaceId);
    },
    Effect.mapError(failure("chat.listOpenByWorkspace")),
  );

  const create = Effect.fn("ChatRepository.create")(
    function* (chat: Chat.NewChat) {
      return yield* insert(chat);
    },
    Effect.mapError(failure("chat.create")),
  );

  const archive = Effect.fn("ChatRepository.archive")(
    function* (id: Chat.ChatId, archivedAt: number) {
      return yield* updateArchive({ id, archivedAt });
    },
    Effect.mapError(failure("chat.archive")),
  );

  const bindExternalId = Effect.fn("ChatRepository.bindExternalId")(
    function* (input: typeof BindExternalId.Type) {
      return yield* updateExternalId(input);
    },
    Effect.mapError(failure("chat.bindExternalId")),
  );

  const findById = Effect.fn("ChatRepository.findById")(
    function* (id: Chat.ChatId) {
      return yield* selectById(id);
    },
    Effect.mapError(failure("chat.findById")),
  );

  const findByExternalId = Effect.fn("ChatRepository.findByExternalId")(
    function* (workspaceId: Workspace.WorkspaceId, externalId: string) {
      return yield* selectByExternalId({ workspaceId, externalId });
    },
    Effect.mapError(failure("chat.findByExternalId")),
  );

  return ChatRepository.of({
    listOpenByWorkspace,
    create,
    archive,
    bindExternalId,
    findById,
    findByExternalId,
  });
});

export const layer = Layer.effect(ChatRepository, make());
