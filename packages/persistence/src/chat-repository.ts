import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { PersistenceError } from "@pico/contract/errors";
import * as Workspace from "@pico/contract/workspace-model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const failure = (message: string) => () => new PersistenceError({ message });

const ExternalChat = Schema.Struct({
  workspaceId: Workspace.WorkspaceId,
  externalId: Schema.NonEmptyString,
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
    Effect.mapError(failure("Failed to create chat")),
  );

  const findById = Effect.fn("ChatRepository.findById")(
    function* (id: Chat.ChatId) {
      return yield* selectById(id);
    },
    Effect.mapError(failure("Failed to find chat")),
  );

  const findByExternalId = Effect.fn("ChatRepository.findByExternalId")(
    function* (workspaceId: Workspace.WorkspaceId, externalId: string) {
      return yield* selectByExternalId({ workspaceId, externalId });
    },
    Effect.mapError(failure("Failed to find chat")),
  );

  return ChatRepository.of({ create, findById, findByExternalId });
});

export const layer = Layer.effect(ChatRepository, make());
