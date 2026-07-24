import type { Chat, ChatEvent, ChatMessage, InFlight, Space } from "@pico/core";
import type {
  StreamFrame,
  WireChat,
  WireInFlight,
  WireMessage,
  WireSpace,
} from "@pico/web-protocol";
import { Option } from "effect";

export const toWireSpace = (space: Space): WireSpace => ({
  id: space.id,
  name: space.name,
  platform: space.platform,
  defaultCwd: space.defaultCwd,
  externalId: Option.getOrNull(space.externalId),
  checkoutBranch: Option.getOrNull(space.checkoutBranch),
  branchPrefix: Option.getOrNull(space.branchPrefix),
  createdAt: space.createdAt.getTime(),
});

export const toWireChat = (chat: Chat): WireChat => ({
  id: chat.id,
  spaceId: chat.spaceId,
  cwd: chat.cwd,
  title: chat.title,
  externalId: Option.getOrNull(chat.externalId),
  createdAt: chat.createdAt.getTime(),
  archivedAt: Option.getOrUndefined(chat.archivedAt)?.getTime() ?? null,
});

export const toWireMessage = (message: ChatMessage): WireMessage => ({
  role: message.role,
  text: message.text,
});

export const toWireInFlight = (inFlight: InFlight): WireInFlight => ({
  index: inFlight.index,
  message: toWireMessage(inFlight.message),
});

const assertNever = (event: never): never => {
  throw new Error(`unhandled chat event: ${JSON.stringify(event)}`);
};

export const toStreamFrame = (event: ChatEvent): StreamFrame => {
  switch (event._tag) {
    case "text_delta":
      return { _tag: "text_delta", index: event.index, delta: event.delta };
    case "thinking_delta":
      return {
        _tag: "thinking_delta",
        index: event.index,
        delta: event.delta,
      };
    case "tool_execution_start":
      return {
        _tag: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_end":
      return {
        _tag: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    case "agent_start":
      return { _tag: "agent_start" };
    case "agent_end":
      return { _tag: "agent_end" };
    case "turn_start":
      return { _tag: "turn_start" };
    case "turn_end":
      return { _tag: "turn_end" };
    case "error":
      return { _tag: "error", reason: event.reason, message: event.message };
    default:
      return assertNever(event);
  }
};
