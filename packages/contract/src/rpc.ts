import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as AgentEvent from "./agent-event.ts";
import * as AgentMessage from "./agent-message.ts";
import * as Chat from "./chat-model.ts";
import * as Errors from "./errors.ts";

export const PicoRpcs = RpcGroup.make(
  Rpc.make("Transcript", {
    payload: { chatId: Chat.ChatId },
    success: AgentMessage.AgentTranscript,
    error: Errors.ApplicationError,
  }),
  Rpc.make("SendMessage", {
    payload: { chatId: Chat.ChatId, prompt: AgentMessage.AgentPrompt },
    success: Schema.Void,
    error: Schema.Union([Errors.ApplicationError, Errors.ChatClosed]),
  }),
  Rpc.make("Abort", {
    payload: { chatId: Chat.ChatId },
    success: Schema.Void,
    error: Errors.ApplicationError,
  }),
  Rpc.make("Events", {
    payload: Schema.Void,
    success: AgentEvent.AgentEventEnvelope,
    stream: true,
  }),
);
