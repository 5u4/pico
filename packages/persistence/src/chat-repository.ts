import * as Chat from "@pico/contract/chat-model";
import { ChatRepository } from "@pico/contract/chat-repository";
import { PersistenceError } from "@pico/contract/errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const failure = (message: string) => () => new PersistenceError({ message });

const make = Effect.fn("ChatRepository.make")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRegular = SqlSchema.findOne({
    Request: Chat.NewRegularChat,
    Result: Chat.Chat,
    execute: (chat) => sql`
      INSERT INTO chats (id, workspace_id, cwd, external_id, created_at)
      SELECT
        ${chat.id},
        id,
        default_cwd,
        ${chat.externalId},
        ${chat.createdAt}
      FROM workspaces
      WHERE id = ${chat.workspaceId}
        AND worktree_branch IS NULL
        AND worktree_prefix IS NULL
      RETURNING
        id,
        workspace_id AS "workspaceId",
        cwd,
        external_id AS "externalId",
        created_at AS "createdAt",
        archived_at AS "archivedAt"
    `,
  });

  const insertWorktree = SqlSchema.findOne({
    Request: Chat.NewWorktreeChat,
    Result: Chat.Chat,
    execute: (chat) => sql`
      INSERT INTO chats (id, workspace_id, cwd, external_id, created_at)
      SELECT
        ${chat.id},
        id,
        ${chat.cwd},
        ${chat.externalId},
        ${chat.createdAt}
      FROM workspaces
      WHERE id = ${chat.workspaceId}
        AND worktree_branch IS NOT NULL
        AND worktree_prefix IS NOT NULL
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

  const createRegular = Effect.fn("ChatRepository.createRegular")(
    function* (chat: Chat.NewRegularChat) {
      return yield* insertRegular(chat);
    },
    Effect.mapError(failure("Failed to create regular chat")),
  );

  const createWorktree = Effect.fn("ChatRepository.createWorktree")(
    function* (chat: Chat.NewWorktreeChat) {
      return yield* insertWorktree(chat);
    },
    Effect.mapError(failure("Failed to create worktree chat")),
  );

  const findById = Effect.fn("ChatRepository.findById")(
    function* (id: Chat.ChatId) {
      return yield* selectById(id);
    },
    Effect.mapError(failure("Failed to find chat")),
  );

  return ChatRepository.of({ createRegular, createWorktree, findById });
});

export const layer = Layer.effect(ChatRepository, make());
