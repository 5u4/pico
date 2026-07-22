import { Data } from "effect";

export class DbError extends Data.TaggedError("DbError")<{
  readonly op: string;
  readonly cause: unknown;
}> {}

export class DuplicateExternalId extends Data.TaggedError(
  "DuplicateExternalId",
)<{
  readonly externalId: string;
}> {}

export class SpaceNotFound extends Data.TaggedError("SpaceNotFound")<{
  readonly spaceId: string;
}> {}

export class ChatNotFound extends Data.TaggedError("ChatNotFound")<{
  readonly chatId: string;
}> {}
