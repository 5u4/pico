import * as Schema from "effect/Schema";

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

export class ApplicationError extends Schema.TaggedError<ApplicationError>()("ApplicationError", {
  message: Schema.String,
}) {}

export const WorkspaceCwdInvalidReason = Schema.Literals([
  "surrounding-whitespace",
  "not-absolute",
  "not-found",
  "not-directory",
  "unreadable",
]);
export type WorkspaceCwdInvalidReason = typeof WorkspaceCwdInvalidReason.Type;

export class WorkspaceCwdInvalid extends Schema.TaggedError<WorkspaceCwdInvalid>()(
  "WorkspaceCwdInvalid",
  {
    cwd: Schema.String,
    reason: WorkspaceCwdInvalidReason,
  },
) {}

export class PersistenceError extends Schema.TaggedError<PersistenceError>()("PersistenceError", {
  message: Schema.String,
}) {}

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String,
}) {}

export class LoggingError extends Schema.TaggedError<LoggingError>()("LoggingError", {
  message: Schema.String,
}) {}

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
}) {}
