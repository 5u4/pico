import { Data } from "effect";

export class InvalidChatId extends Data.TaggedError("InvalidChatId")<{
  readonly chatId: string;
}> {}

export class ChatBusy extends Data.TaggedError("ChatBusy")<{
  readonly chatId: string;
}> {}

export class SessionInitFailed extends Data.TaggedError("SessionInitFailed")<{
  readonly chatId: string;
  readonly cause: unknown;
}> {}

export class ModelUnavailable extends Data.TaggedError("ModelUnavailable")<{
  readonly detail: string;
}> {}

export class AuthUnavailable extends Data.TaggedError("AuthUnavailable")<{
  readonly cause: unknown;
}> {}
