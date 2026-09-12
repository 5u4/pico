import { PersistenceError } from "@pico/contract/errors";
import * as Cause from "effect/Cause";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlError from "effect/unstable/sql/SqlError";

const detail = (error: unknown): string => {
  if (error instanceof PersistenceError) return error.message;
  if (SqlError.isSqlError(error)) {
    const cause = error.reason.cause;
    const code = Predicate.hasProperty(cause, "errno")
      ? cause.errno
      : Predicate.hasProperty(cause, "code")
        ? cause.code
        : undefined;
    const nativeCode =
      typeof code === "number" && Number.isSafeInteger(code) ? `, SQLite code ${code}` : "";
    return `${error.reason._tag}${nativeCode}`;
  }
  if (error instanceof Migrator.MigrationError) {
    return `migration ${error.kind}${error.cause === undefined ? "" : `, ${detail(error.cause)}`}`;
  }
  if (Cause.isNoSuchElementError(error)) return "required row missing";
  if (Schema.isSchemaError(error)) return "invalid stored row or repository input";
  return "database operation failed";
};

export const failure = (operation: string) => (error: unknown) =>
  new PersistenceError({ message: `${operation}: ${detail(error)}` });
