import { ApplicationError, ChatClosed, WorkspaceBindingInvalid } from "@pico/contract/errors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const AcknowledgementAttemptNumber = Schema.Literals([1, 2]);

const DiscordAcknowledgementAttemptEvidenceSchema = Schema.Union([
  Schema.Struct({
    attempt: AcknowledgementAttemptNumber,
    outcome: Schema.Literal("not-started"),
  }),
  Schema.Struct({
    attempt: AcknowledgementAttemptNumber,
    outcome: Schema.Literal("pending"),
    startedAfterAcknowledgementMs: Schema.Number,
  }),
  Schema.Struct({
    attempt: AcknowledgementAttemptNumber,
    outcome: Schema.Literal("fulfilled"),
    startedAfterAcknowledgementMs: Schema.Number,
    elapsedMs: Schema.Number,
  }),
  Schema.Struct({
    attempt: AcknowledgementAttemptNumber,
    outcome: Schema.Literal("rejected"),
    startedAfterAcknowledgementMs: Schema.Number,
    elapsedMs: Schema.Number,
    status: Schema.optional(Schema.Number),
    discordCode: Schema.optional(Schema.Number),
  }),
]);
export type DiscordAcknowledgementAttemptEvidence =
  typeof DiscordAcknowledgementAttemptEvidenceSchema.Type;

const DiscordAcknowledgementEvidenceSchema = Schema.Struct({
  mode: Schema.Literals(["defer", "defer-edit"]),
  decision: Schema.Literals(["fulfilled", "qualified-40060", "rejected"]),
  winningAttempt: Schema.optional(AcknowledgementAttemptNumber),
  deliveryAgeAtAcknowledgementMs: Schema.Number,
  firstStartedAfterAcknowledgementMs: Schema.optional(Schema.Number),
  hedgeDueAfterFirstStartMs: Schema.optional(Schema.Number),
  decisionAfterAcknowledgementMs: Schema.Number,
  attempts: Schema.Tuple([
    DiscordAcknowledgementAttemptEvidenceSchema,
    DiscordAcknowledgementAttemptEvidenceSchema,
  ]),
});
export type DiscordAcknowledgementEvidence = typeof DiscordAcknowledgementEvidenceSchema.Type;

export class DiscordError extends Schema.TaggedError<DiscordError>()("DiscordError", {
  message: Schema.String,
  operation: Schema.String,
  status: Schema.optional(Schema.Number),
  discordCode: Schema.optional(Schema.Number),
  guildId: Schema.optional(Schema.String),
  editStatus: Schema.optional(Schema.Number),
  messageId: Schema.optional(Schema.String),
  chunkIndex: Schema.optional(Schema.Number),
  chunkCount: Schema.optional(Schema.Number),
  editDiscordCode: Schema.optional(Schema.Number),
  acknowledgement: Schema.optional(DiscordAcknowledgementEvidenceSchema),
}) {}

export const acknowledgementLogAnnotations = (evidence: DiscordAcknowledgementEvidence) => ({
  acknowledgementMode: evidence.mode,
  acknowledgementDecision: evidence.decision,
  ...(evidence.winningAttempt === undefined
    ? {}
    : { acknowledgementWinningAttempt: evidence.winningAttempt }),
  deliveryAgeAtAcknowledgementMs: evidence.deliveryAgeAtAcknowledgementMs,
  ...(evidence.firstStartedAfterAcknowledgementMs === undefined
    ? {}
    : { firstStartedAfterAcknowledgementMs: evidence.firstStartedAfterAcknowledgementMs }),
  ...(evidence.hedgeDueAfterFirstStartMs === undefined
    ? {}
    : { hedgeDueAfterFirstStartMs: evidence.hedgeDueAfterFirstStartMs }),
  acknowledgementDecisionAfterMs: evidence.decisionAfterAcknowledgementMs,
  acknowledgementAttempts: evidence.attempts,
});

const Rejection = Schema.Struct({
  status: Schema.optional(Schema.Int),
  body: Schema.optional(Schema.Unknown),
});
const decodeRejection = Schema.decodeUnknownOption(Rejection);
const ErrorBody = Schema.Struct({ code: Schema.Int });
const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.Union([ErrorBody, Schema.fromJsonString(ErrorBody)]),
);

export const discordError = (operation: string, cause: unknown, guildId?: string) => {
  if (cause instanceof DiscordError) return cause;
  const rejection = decodeRejection(
    cause instanceof Error && cause.cause !== undefined ? cause.cause : cause,
  );
  const details = Option.isSome(rejection) ? rejection.value : undefined;
  const body = decodeErrorBody(details?.body);
  return new DiscordError({
    message: `Discord ${operation} failed`,
    operation,
    ...(details?.status === undefined ? {} : { status: details.status }),
    ...(Option.isNone(body) ? {} : { discordCode: body.value.code }),
    ...(guildId === undefined ? {} : { guildId }),
  });
};

export const promiseBoundary = <A>(
  operation: string,
  evaluate: () => Promise<A>,
  guildId?: string,
) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => discordError(operation, cause, guildId),
  });

const safeCause = (operation: string, cause: Cause.Cause<unknown>) =>
  Cause.fromReasons(
    cause.reasons.map((reason): Cause.Reason<DiscordError | ApplicationError> => {
      if (reason._tag === "Interrupt") return reason;
      if (reason._tag === "Die") return Cause.makeDieReason(discordError(operation, undefined));
      const error = reason.error;
      return Cause.makeFailReason(
        error instanceof DiscordError || error instanceof ApplicationError
          ? error
          : discordError(operation, error),
      );
    }),
  );

export const reportFailure = (
  operation: string,
  cause: Cause.Cause<unknown>,
  level: "error" | "warning" = "error",
) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
  const expected = cause.reasons.every(
    (reason) =>
      reason._tag === "Interrupt" ||
      (reason._tag === "Fail" &&
        (reason.error instanceof ChatClosed ||
          reason.error instanceof WorkspaceBindingInvalid ||
          (reason.error instanceof ApplicationError && reason.error.reason !== "operation"))),
  );
  if (expected) return Effect.void;
  const safe = safeCause(operation, cause);
  const failure = safe.reasons.find(
    (reason) => reason._tag === "Fail" && reason.error instanceof DiscordError,
  );
  const error =
    failure?._tag === "Fail" && failure.error instanceof DiscordError ? failure.error : undefined;
  return (
    level === "warning"
      ? Effect.logWarning("Discord operation degraded", safe)
      : Effect.logError("Discord operation failed", safe)
  ).pipe(
    Effect.annotateLogs({
      component: "discord",
      operation,
      ...(error === undefined
        ? {}
        : {
            discordOperation: error.operation,
            ...(error.status === undefined ? {} : { status: error.status }),
            ...(error.discordCode === undefined ? {} : { discordCode: error.discordCode }),
            ...(error.guildId === undefined ? {} : { guildId: error.guildId }),
            ...(error.messageId === undefined ? {} : { messageId: error.messageId }),
            ...(error.editStatus === undefined ? {} : { editStatus: error.editStatus }),
            ...(error.editDiscordCode === undefined
              ? {}
              : { editDiscordCode: error.editDiscordCode }),
            ...(error.chunkIndex === undefined ? {} : { chunkIndex: error.chunkIndex }),
            ...(error.chunkCount === undefined ? {} : { chunkCount: error.chunkCount }),
            ...(error.acknowledgement === undefined
              ? {}
              : acknowledgementLogAnnotations(error.acknowledgement)),
          }),
    }),
  );
};
