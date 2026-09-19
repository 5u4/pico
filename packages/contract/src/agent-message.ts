import * as Schema from "effect/Schema";

export const AgentMessageId = Schema.NonEmptyString.pipe(Schema.brand("AgentMessageId"));
export type AgentMessageId = typeof AgentMessageId.Type;

export const MAX_AGENT_IMAGE_ATTACHMENTS = 10;
export const MAX_AGENT_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_AGENT_IMAGE_BYTES = 40 * 1024 * 1024;
export const MAX_AGENT_IMAGE_EDGE = 16_384;
export const MAX_AGENT_IMAGE_PIXELS = 40_000_000;

const maximumBase64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

const base64ByteLength = (data: string) => {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
};

export const AgentImageMimeType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export type AgentImageMimeType = typeof AgentImageMimeType.Type;

export const AgentImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: Schema.NonEmptyString,
  data: Schema.NonEmptyString.check(
    Schema.isMaxLength(maximumBase64Length(MAX_AGENT_IMAGE_ATTACHMENT_BYTES)).abort(),
    Schema.makeFilter(
      (data) => {
        if (data.length % 4 !== 0) return false;
        const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
        const contentLength = data.length - padding;
        for (let index = 0; index < contentLength; index++) {
          const character = data.charCodeAt(index);
          if (
            (character >= 65 && character <= 90) ||
            (character >= 97 && character <= 122) ||
            (character >= 48 && character <= 57) ||
            character === 43 ||
            character === 47
          ) {
            continue;
          }
          return false;
        }
        return true;
      },
      { expected: "a base64 encoded string" },
    ),
  ),
  mimeType: AgentImageMimeType,
}).check(
  Schema.makeFilter((attachment) =>
    base64ByteLength(attachment.data) <= MAX_AGENT_IMAGE_ATTACHMENT_BYTES
      ? undefined
      : `an image attachment of at most ${MAX_AGENT_IMAGE_ATTACHMENT_BYTES} bytes`,
  ),
);
export type AgentImageAttachment = typeof AgentImageAttachment.Type;

export const AgentPrompt = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(AgentImageAttachment).check(
    Schema.isMaxLength(MAX_AGENT_IMAGE_ATTACHMENTS),
  ),
}).check(
  Schema.makeFilter((prompt) => {
    if (prompt.text.trim().length === 0 && prompt.attachments.length === 0) {
      return "a prompt with text or at least one image attachment";
    }
    const attachmentBytes = prompt.attachments.reduce(
      (total, attachment) => total + base64ByteLength(attachment.data),
      0,
    );
    return attachmentBytes <= MAX_AGENT_IMAGE_BYTES
      ? undefined
      : `image attachments totaling at most ${MAX_AGENT_IMAGE_BYTES} bytes`;
  }),
);
export type AgentPrompt = typeof AgentPrompt.Type;

export const AgentText = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type AgentText = typeof AgentText.Type;

export const AgentThinking = Schema.Struct({
  type: Schema.Literal("thinking"),
  text: Schema.String,
});
export type AgentThinking = typeof AgentThinking.Type;

export const AgentImage = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.NonEmptyString,
});
export type AgentImage = typeof AgentImage.Type;

export const AgentToolCall = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  argumentsJson: Schema.String,
});
export type AgentToolCall = typeof AgentToolCall.Type;

export const AgentUserContent = Schema.Union([AgentText, AgentImage]);
export type AgentUserContent = typeof AgentUserContent.Type;

export const AgentAssistantContent = Schema.Union([
  AgentText,
  AgentThinking,
  AgentImage,
  AgentToolCall,
]);
export type AgentAssistantContent = typeof AgentAssistantContent.Type;

export const AgentToolResultContent = Schema.Union([AgentText, AgentImage]);
export type AgentToolResultContent = typeof AgentToolResultContent.Type;

export const AgentUserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Array(AgentUserContent),
  timestamp: Schema.Natural,
});
export type AgentUserMessage = typeof AgentUserMessage.Type;

const AgentCompletedAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  id: AgentMessageId,
  status: Schema.Literal("completed"),
  stopReason: Schema.Literals(["stop", "length", "tool-use"]),
  content: Schema.Array(AgentAssistantContent),
  model: Schema.NonEmptyString,
  timestamp: Schema.Natural,
});

const AgentFailedAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  id: AgentMessageId,
  status: Schema.Literal("failed"),
  stopReason: Schema.Literals(["error", "aborted"]),
  message: Schema.NullOr(Schema.String),
  content: Schema.Array(AgentAssistantContent),
  model: Schema.NonEmptyString,
  timestamp: Schema.Natural,
});

export const AgentAssistantMessage = Schema.Union([
  AgentCompletedAssistantMessage,
  AgentFailedAssistantMessage,
]);
export type AgentAssistantMessage = typeof AgentAssistantMessage.Type;

export const AgentToolResultMessage = Schema.Struct({
  role: Schema.Literal("tool-result"),
  toolCallId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
  content: Schema.Array(AgentToolResultContent),
  status: Schema.Literals(["succeeded", "failed"]),
  timestamp: Schema.Natural,
  todoSnapshot: Schema.optional(Schema.Literal(true)),
});
export type AgentToolResultMessage = typeof AgentToolResultMessage.Type;

export const AgentMessage = Schema.Union([
  AgentUserMessage,
  AgentAssistantMessage,
  AgentToolResultMessage,
]);
export type AgentMessage = typeof AgentMessage.Type;

export const AgentTranscript = Schema.Array(AgentMessage);
export type AgentTranscript = typeof AgentTranscript.Type;
