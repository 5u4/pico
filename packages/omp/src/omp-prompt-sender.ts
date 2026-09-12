import { tryRunRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type * as OmpAgentSession from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as AgentMessage from "@pico/contract/agent-message";
import type { ChatId } from "@pico/contract/chat-model";
import { AgentError } from "@pico/contract/errors";
import * as Cause from "effect/Cause";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

interface PromptDiagnostics {
  readonly chatId: ChatId;
  readonly runEffect: typeof Effect.runPromise;
}

type OmpPromptSession = Parameters<typeof tryRunRpcSkillCommand>[0] &
  Pick<OmpAgentSession.AgentSession, "prompt" | "sendUserMessage" | "setPromptDropped"> & {
    readonly sessionManager: Pick<OmpAgentSession.AgentSession["sessionManager"], "getSessionFile">;
  };

interface PersistedAttachment {
  readonly attachment: AgentMessage.AgentImageAttachment;
  readonly path: string;
}

const extensionFor = (mimeType: AgentMessage.AgentImageMimeType) => {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default: {
      const exhaustive: never = mimeType;
      return exhaustive;
    }
  }
};
const bunFormatFor = (mimeType: AgentMessage.AgentImageMimeType) => {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpeg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default: {
      const exhaustive: never = mimeType;
      return exhaustive;
    }
  }
};

const validateImageBytes = async (
  attachment: AgentMessage.AgentImageAttachment,
  bytes: Uint8Array,
) => {
  let metadata: Awaited<ReturnType<Bun.Image["metadata"]>>;
  try {
    metadata = await new Bun.Image(bytes).metadata();
  } catch {
    throw new AgentError({ message: "Invalid image attachment bytes" });
  }
  if (
    metadata.format !== bunFormatFor(attachment.mimeType) ||
    metadata.width < 1 ||
    metadata.height < 1 ||
    metadata.width > AgentMessage.MAX_AGENT_IMAGE_EDGE ||
    metadata.height > AgentMessage.MAX_AGENT_IMAGE_EDGE ||
    metadata.width * metadata.height > AgentMessage.MAX_AGENT_IMAGE_PIXELS
  ) {
    throw new AgentError({ message: "Image attachment format or dimensions are invalid" });
  }
};

const isSystemReason = (error: PlatformError.PlatformError, reason: PlatformError.SystemErrorTag) =>
  error.reason._tag === reason;

const removeWrittenOriginals = async (
  fileSystem: FileSystem.FileSystem,
  files: ReadonlyArray<string>,
  attachmentsDirectory: string,
  sessionDirectory: string,
  createdAttachmentsDirectory: boolean,
  createdSessionDirectory: boolean,
) => {
  const failures: unknown[] = [];
  for (const file of files.toReversed()) {
    try {
      await Effect.runPromise(fileSystem.remove(file, { force: true }));
    } catch (error) {
      failures.push(error);
    }
  }
  const directories: ReadonlyArray<readonly [string, boolean]> = [
    [attachmentsDirectory, createdAttachmentsDirectory],
    [sessionDirectory, createdSessionDirectory],
  ];
  for (const [directory, created] of directories) {
    if (!created) continue;
    try {
      await Effect.runPromise(fileSystem.remove(directory, { force: true, recursive: true }));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Failed to remove image originals");
};

const withOriginalReferences = (text: string, originals: ReadonlyArray<PersistedAttachment>) => {
  const references = originals
    .map(({ attachment, path }) => `- ${JSON.stringify(attachment.name)}: ${JSON.stringify(path)}`)
    .join("\n");
  const heading = `Original image files:\n${references}`;
  return text.length === 0 ? heading : `${text}\n\n${heading}`;
};

const hexDigest = async (crypto: Crypto.Crypto, bytes: Uint8Array) => {
  const digest = await Effect.runPromise(crypto.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const validatePrompt = Schema.decodeUnknownSync(AgentMessage.AgentPrompt, {
  onExcessProperty: "error",
});

const serialize = () => {
  let tail = Promise.resolve();
  return <A>(operation: () => Promise<A>) => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
};

export const makeOmpPromptSender = (
  session: OmpPromptSession,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
  diagnostics: PromptDiagnostics,
) => {
  const runSerialized = serialize();
  return (input: AgentMessage.AgentPrompt): Promise<void> =>
    runSerialized(async () => {
      const prompt = validatePrompt(input);
      if (prompt.attachments.length === 0) {
        const skillResult = await tryRunRpcSkillCommand(session, prompt.text, "steer");
        if (skillResult !== false) return;
        await session.sendUserMessage(prompt.text);
        return;
      }
      const decoded = await Promise.all(
        prompt.attachments.map(async (attachment) => {
          const bytes = Buffer.from(attachment.data, "base64");
          await validateImageBytes(attachment, bytes);
          return { attachment, bytes };
        }),
      );

      const sessionFile = session.sessionManager.getSessionFile();
      if (sessionFile === undefined)
        throw new AgentError({ message: "OMP session has no journal path" });
      const sessionDirectory = path.join(
        path.dirname(sessionFile),
        path.basename(sessionFile, path.extname(sessionFile)),
      );
      const attachmentsDirectory = path.join(sessionDirectory, "attachments");
      let createdSessionDirectory = false;
      let createdAttachmentsDirectory = false;

      const written: string[] = [];
      const originals: PersistedAttachment[] = [];
      try {
        createdSessionDirectory = !(await Effect.runPromise(fileSystem.exists(sessionDirectory)));
        await Effect.runPromise(
          fileSystem.makeDirectory(sessionDirectory, { recursive: true, mode: 0o700 }),
        );
        await Effect.runPromise(fileSystem.chmod(sessionDirectory, 0o700));
        createdAttachmentsDirectory = !(await Effect.runPromise(
          fileSystem.exists(attachmentsDirectory),
        ));
        await Effect.runPromise(
          fileSystem.makeDirectory(attachmentsDirectory, { recursive: true, mode: 0o700 }),
        );
        await Effect.runPromise(fileSystem.chmod(attachmentsDirectory, 0o700));

        for (const { attachment, bytes } of decoded) {
          const digest = await hexDigest(crypto, bytes);
          const file = path.join(
            attachmentsDirectory,
            `${digest}.${extensionFor(attachment.mimeType)}`,
          );
          const created = await Effect.runPromise(
            fileSystem.writeFile(file, bytes, { flag: "wx", mode: 0o600 }).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                isSystemReason(error, "AlreadyExists") ? Effect.succeed(false) : Effect.fail(error),
              ),
            ),
          );
          if (created) written.push(file);
          originals.push({ attachment, path: file });
        }

        let dropped = false;
        session.setPromptDropped(() => {
          dropped = true;
        });
        try {
          await session.prompt(withOriginalReferences(prompt.text, originals), {
            images: prompt.attachments.map(({ data, mimeType }) => ({
              type: "image",
              data,
              mimeType,
            })),
            expandPromptTemplates: false,
            streamingBehavior: "steer",
          });
        } finally {
          session.setPromptDropped(undefined);
        }
        if (dropped) throw new DOMException("OMP image prompt was dropped", "AbortError");
      } catch (error) {
        try {
          await removeWrittenOriginals(
            fileSystem,
            written,
            attachmentsDirectory,
            sessionDirectory,
            createdAttachmentsDirectory,
            createdSessionDirectory,
          );
        } catch {
          await diagnostics.runEffect(
            Effect.logError(
              "Failed to remove image originals after prompt rejection",
              Cause.fail(new AgentError({ message: "Image rollback failed" })),
            ).pipe(
              Effect.annotateLogs({
                component: "omp",
                operation: "image-cleanup",
                chatId: diagnostics.chatId,
                phase: "prompt-rollback",
              }),
            ),
          );
        }
        throw error;
      }
    });
};
