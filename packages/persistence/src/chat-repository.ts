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

const make = Effect.fn("ChatRepository.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insert = SqlSchema.findOne({
    Request: Chat.NewChat,
    Result: Chat.Chat,
    execute: (chat) => sql`
      INSERT INTO chats (id, workspace_id, cwd, external_id, created_at)
      VALUES (
        ${chat.id},
        ${chat.workspaceId},
        ${chat.cwd},
        ${chat.externalId},
        ${chat.createdAt}
      )
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

  return ChatRepository.of({ create, archive, findById, findByExternalId });
});

export const layer = Layer.effect(ChatRepository, make());
