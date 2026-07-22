import { Schema } from "effect";

export const WebMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literal("user", "assistant"),
  text: Schema.String,
});

export const ThreadState = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
  messages: Schema.Array(WebMessage),
});

export type ThreadState = typeof ThreadState.Type;
