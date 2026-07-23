import { type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { Effect } from "effect";
import { CwdNotFound, InvalidCwd, NotADirectory } from "./errors.ts";

const expandTilde = (input: string): string => {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return `${homedir()}/${input.slice(2)}`;
  return input;
};

export const validatePath = (
  input: string,
): Effect.Effect<string, InvalidCwd | CwdNotFound | NotADirectory> =>
  Effect.gen(function* () {
    const expanded = expandTilde(input);
    if (!isAbsolute(expanded)) return yield* new InvalidCwd({ path: input });
    const normalized = normalize(expanded);
    const stat = yield* Effect.try({
      try: (): Stats => statSync(normalized),
      catch: (): CwdNotFound => new CwdNotFound({ path: normalized }),
    });
    if (!stat.isDirectory()) {
      return yield* new NotADirectory({ path: normalized });
    }
    return normalized;
  });
