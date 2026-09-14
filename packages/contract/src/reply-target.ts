import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ChatId } from "./chat-model.ts";
import type { AgentError } from "./errors.ts";
import { WorkspacePlatform } from "./workspace-model.ts";

export const ReplyTarget = Schema.Struct({
  platform: WorkspacePlatform.pick(["discord"]),
  conversationId: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
});
export type ReplyTarget = typeof ReplyTarget.Type;

export class ReplyDelivery extends Context.Service<
  ReplyDelivery,
  {
    // Daemon sends scheduled results to the destination captured when the schedule was created.
    readonly send: (
      chatId: ChatId,
      target: ReplyTarget,
      content: string,
    ) => Effect.Effect<void, AgentError>;
  }
>()("@pico/contract/reply/ReplyDelivery") {}
