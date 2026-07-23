import { Data } from "effect";

export class InvalidCwd extends Data.TaggedError("InvalidCwd")<{
  readonly path: string;
}> {}

export class CwdNotFound extends Data.TaggedError("CwdNotFound")<{
  readonly path: string;
}> {}

export class NotADirectory extends Data.TaggedError("NotADirectory")<{
  readonly path: string;
}> {}

export class InvalidSpaceName extends Data.TaggedError("InvalidSpaceName")<
  Record<string, never>
> {}

export class InvalidChatTitle extends Data.TaggedError("InvalidChatTitle")<
  Record<string, never>
> {}

export class SpaceHasActiveChats extends Data.TaggedError(
  "SpaceHasActiveChats",
)<{
  readonly spaceId: string;
}> {}
