import * as Schema from "effect/Schema";

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

export class ApplicationError extends Schema.TaggedError<ApplicationError>()("ApplicationError", {
  message: Schema.String,
}) {}

export class ChatClosed extends Schema.TaggedError<ChatClosed>()("ChatClosed", {}) {}

const WorkspacePathInvalidReason = Schema.Literals([
  "surrounding-whitespace",
  "not-absolute",
  "not-found",
  "not-directory",
  "unreadable",
]);

export const WorkspaceBindingInvalidIssue = Schema.Union([
  Schema.Struct({ field: Schema.Literal("cwd"), reason: WorkspacePathInvalidReason }),
  Schema.Struct({
    field: Schema.Literal("repository"),
    reason: Schema.Union([WorkspacePathInvalidReason, Schema.Literal("not-repository")]),
  }),
  Schema.Struct({
    field: Schema.Literal("branch"),
    reason: Schema.Literals(["surrounding-whitespace", "not-commit"]),
  }),
  Schema.Struct({
    field: Schema.Literal("prefix"),
    reason: Schema.Literals(["surrounding-whitespace", "invalid-ref"]),
  }),
]);
export type WorkspaceBindingInvalidIssue = typeof WorkspaceBindingInvalidIssue.Type;

export class WorkspaceBindingInvalid extends Schema.TaggedError<WorkspaceBindingInvalid>()(
  "WorkspaceBindingInvalid",
  { issue: WorkspaceBindingInvalidIssue },
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
