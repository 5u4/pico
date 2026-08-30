import * as Schema from "effect/Schema";

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

export class PersistenceError extends Schema.TaggedError<PersistenceError>()("PersistenceError", {
  message: Schema.String,
}) {}

export class LoggingError extends Schema.TaggedError<LoggingError>()("LoggingError", {
  message: Schema.String,
}) {}

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
}) {}
