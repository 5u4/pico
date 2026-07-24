import type {
  ChatBusy,
  ChatNotFound,
  CwdNotFound,
  DbError,
  InvalidChatId,
  InvalidChatTitle,
  InvalidCwd,
  InvalidSpaceName,
  ModelUnavailable,
  NotADirectory,
  SessionInitFailed,
  SpaceHasActiveChats,
  SpaceNotFound,
} from "@pico/core";
import type { WireError } from "@pico/web-protocol";

export type SurfaceError =
  | SpaceNotFound
  | ChatNotFound
  | InvalidSpaceName
  | InvalidChatTitle
  | InvalidChatId
  | InvalidCwd
  | CwdNotFound
  | NotADirectory
  | SpaceHasActiveChats
  | ChatBusy
  | ModelUnavailable
  | SessionInitFailed
  | DbError;

export interface WireFailure {
  readonly status: number;
  readonly body: WireError;
}

const assertNever = (error: never): never => {
  throw new Error(`unhandled surface error: ${JSON.stringify(error)}`);
};

export const toWireFailure = (error: SurfaceError): WireFailure => {
  switch (error._tag) {
    case "SpaceNotFound":
      return {
        status: 404,
        body: {
          _tag: "SpaceNotFound",
          message: `space not found: ${error.spaceId}`,
          spaceId: error.spaceId,
        },
      };
    case "ChatNotFound":
      return {
        status: 404,
        body: {
          _tag: "ChatNotFound",
          message: `chat not found: ${error.chatId}`,
          chatId: error.chatId,
        },
      };
    case "InvalidSpaceName":
      return {
        status: 400,
        body: { _tag: "InvalidSpaceName", message: "space name is empty" },
      };
    case "InvalidChatTitle":
      return {
        status: 400,
        body: { _tag: "InvalidChatTitle", message: "chat title is empty" },
      };
    case "InvalidChatId":
      return {
        status: 400,
        body: {
          _tag: "InvalidChatId",
          message: `invalid chat id: ${error.chatId}`,
          chatId: error.chatId,
        },
      };
    case "InvalidCwd":
      return {
        status: 400,
        body: {
          _tag: "InvalidCwd",
          message: `invalid cwd: ${error.path}`,
          path: error.path,
        },
      };
    case "CwdNotFound":
      return {
        status: 400,
        body: {
          _tag: "CwdNotFound",
          message: `cwd not found: ${error.path}`,
          path: error.path,
        },
      };
    case "NotADirectory":
      return {
        status: 400,
        body: {
          _tag: "NotADirectory",
          message: `not a directory: ${error.path}`,
          path: error.path,
        },
      };
    case "SpaceHasActiveChats":
      return {
        status: 409,
        body: {
          _tag: "SpaceHasActiveChats",
          message: `space has active chats: ${error.spaceId}`,
          spaceId: error.spaceId,
        },
      };
    case "ChatBusy":
      return {
        status: 409,
        body: {
          _tag: "ChatBusy",
          message: `chat is busy: ${error.chatId}`,
          chatId: error.chatId,
        },
      };
    case "ModelUnavailable":
      return {
        status: 503,
        body: {
          _tag: "ModelUnavailable",
          message: `model unavailable: ${error.detail}`,
          detail: error.detail,
        },
      };
    case "SessionInitFailed":
      return {
        status: 503,
        body: {
          _tag: "SessionInitFailed",
          message: "failed to initialize chat session",
          chatId: error.chatId,
        },
      };
    case "DbError":
      return {
        status: 500,
        body: { _tag: "DbError", message: "internal error" },
      };
    default:
      return assertNever(error);
  }
};
