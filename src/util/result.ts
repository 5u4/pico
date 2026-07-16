import { Result } from "neverthrow";

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const parseJson = Result.fromThrowable(
  (input: string): unknown => JSON.parse(input),
  errMessage,
);
