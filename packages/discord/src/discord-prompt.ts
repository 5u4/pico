import * as AgentMessage from "@pico/contract/agent-message";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

export interface DiscordMessage {
  readonly guildId?: bigint;
  readonly webhookId?: bigint;
  readonly author: { readonly id: bigint; readonly bot?: boolean };
  readonly channelId: bigint;
  readonly id: bigint;
  readonly content: string;
  readonly attachments?: ReadonlyArray<{
    readonly filename: string;
    readonly contentType?: string;
    readonly size: number;
    readonly url: string;
  }>;
}

const maximumAttachmentCount = AgentMessage.MAX_AGENT_IMAGE_ATTACHMENTS;
const maximumAttachmentBytes = AgentMessage.MAX_AGENT_IMAGE_ATTACHMENT_BYTES;
const maximumMessageAttachmentBytes = AgentMessage.MAX_AGENT_IMAGE_BYTES;
const attachmentPolicyMessage =
  "Attach up to 10 PNG, JPEG, GIF, or WebP images. Each image must be 20 MiB or smaller, with 40 MiB total.";
const attachmentDownloadMessage =
  "I couldn't read every image attachment. Try sending the message again.";

class DiscordAttachmentError extends Schema.TaggedError<DiscordAttachmentError>()(
  "DiscordAttachmentError",
  {
    reply: Schema.String,
    reason: Schema.Literals(["policy", "transport", "http", "body", "timeout", "configuration"]),
    status: Schema.optional(Schema.Number),
    attachmentIndex: Schema.optional(Schema.Number),
    phase: Schema.optional(Schema.Literals(["attachment", "prompt"])),
  },
) {}

const attachmentError = (
  reason: DiscordAttachmentError["reason"],
  fields: Pick<DiscordAttachmentError, "status" | "attachmentIndex" | "phase"> = {},
) =>
  new DiscordAttachmentError({
    reply: reason === "policy" ? attachmentPolicyMessage : attachmentDownloadMessage,
    reason,
    ...fields,
  });

const sanitizeAttachmentName = (name: string, index: number) => {
  const safeCharacters = Array.from(name, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return " ";
    }
    return character === "/" || character === "\\" ? "_" : character;
  }).join("");
  const normalized = safeCharacters.trim().replace(/\s+/g, " ");
  const sanitized = Array.from(normalized).slice(0, 100).join("");
  return sanitized.length === 0 ? `image-${index + 1}` : sanitized;
};

const hasBytes = (bytes: Uint8Array, expected: ReadonlyArray<number>) =>
  bytes.length >= expected.length && expected.every((byte, index) => bytes[index] === byte);

const sniffImageMimeType = (bytes: Uint8Array): AgentMessage.AgentImageMimeType | undefined => {
  if (hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (hasBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return "image/gif";
  if (hasBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (
    hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
};
const maximumImageEdge = AgentMessage.MAX_AGENT_IMAGE_EDGE;
const maximumImagePixels = AgentMessage.MAX_AGENT_IMAGE_PIXELS;

const validateDecodedImage = Effect.fn("Discord.validateDecodedImage")(function* (
  bytes: Uint8Array,
) {
  const metadata = yield* Effect.tryPromise({
    try: () => new Bun.Image(bytes).metadata(),
    catch: () => attachmentError("policy"),
  });
  if (
    metadata.width < 1 ||
    metadata.height < 1 ||
    metadata.width > maximumImageEdge ||
    metadata.height > maximumImageEdge ||
    metadata.width * metadata.height > maximumImagePixels
  ) {
    return yield* Effect.fail(attachmentError("policy"));
  }
});

const attachmentUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "cdn.discordapp.com" ||
        url.port.length > 0 ||
        url.username.length > 0 ||
        url.password.length > 0
      ) {
        throw new Error("Invalid attachment URL");
      }
      return url;
    },
    catch: () => new DiscordAttachmentError({ reason: "policy", reply: attachmentDownloadMessage }),
  });

interface AttachmentBodyState {
  readonly chunks: Uint8Array[];
  readonly length: number;
}

const emptyAttachmentBody = (): AttachmentBodyState => ({ chunks: [], length: 0 });

const readBoundedBody = Effect.fn("Discord.readBoundedAttachment")(function* (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
) {
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(attachmentError("http", { status: response.status }));
  }
  const contentLength = response.headers["content-length"];
  if (contentLength !== undefined) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > limit) {
      return yield* Effect.fail(attachmentError("policy"));
    }
  }

  const state = yield* response.stream.pipe(
    Stream.runFoldEffect(emptyAttachmentBody, (current, chunk) => {
      const length = current.length + chunk.byteLength;
      if (length > limit) return Effect.fail(attachmentError("policy"));
      current.chunks.push(chunk);
      return Effect.succeed({ chunks: current.chunks, length });
    }),
    Effect.mapError((error) =>
      error instanceof DiscordAttachmentError ? error : attachmentError("body"),
    ),
  );
  const bytes = new Uint8Array(state.length);
  let offset = 0;
  for (const chunk of state.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});

export const projectDiscordPrompt = Effect.fn("Discord.projectPrompt")(
  function* (message: DiscordMessage, httpClient: HttpClient.HttpClient | undefined) {
    const source = message.attachments ?? [];
    if (source.length > maximumAttachmentCount) {
      return yield* Effect.fail(attachmentError("policy"));
    }
    let declaredTotal = 0;
    for (const attachment of source) {
      if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
        return yield* Effect.fail(attachmentError("policy"));
      }
      declaredTotal += attachment.size;
      if (
        attachment.size > maximumAttachmentBytes ||
        declaredTotal > maximumMessageAttachmentBytes
      ) {
        return yield* Effect.fail(attachmentError("policy"));
      }
    }

    const attachments: AgentMessage.AgentImageAttachment[] = [];
    let actualTotal = 0;
    for (const [index, attachment] of source.entries()) {
      if (httpClient === undefined) {
        return yield* Effect.fail(attachmentError("configuration", { attachmentIndex: index }));
      }
      const url = yield* attachmentUrl(attachment.url);
      const remaining = maximumMessageAttachmentBytes - actualTotal;
      const bytes = yield* httpClient.get(url).pipe(
        Effect.mapError(() => attachmentError("transport")),
        Effect.flatMap((response) =>
          readBoundedBody(response, Math.min(maximumAttachmentBytes, remaining)),
        ),
        Effect.timeout("15 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(attachmentError("timeout", { phase: "attachment" })),
        ),
        Effect.mapError(
          (error) => new DiscordAttachmentError({ ...error, attachmentIndex: index }),
        ),
      );
      const mimeType = sniffImageMimeType(bytes);
      if (mimeType === undefined) {
        return yield* Effect.fail(attachmentError("policy"));
      }
      yield* validateDecodedImage(bytes);
      actualTotal += bytes.byteLength;
      attachments.push({
        type: "image",
        name: sanitizeAttachmentName(attachment.filename, index),
        data: Buffer.from(bytes).toString("base64"),
        mimeType,
      });
    }
    return AgentMessage.AgentPrompt.make({ text: message.content, attachments });
  },
  Effect.timeout("30 seconds"),
  Effect.catchTag("TimeoutError", () =>
    Effect.fail(attachmentError("timeout", { phase: "prompt" })),
  ),
);
