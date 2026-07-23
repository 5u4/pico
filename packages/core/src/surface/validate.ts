import { type Stats, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Effect } from "effect";
import { normalizeCwd } from "../store/paths.ts";
import { CwdNotFound, InvalidCwd, NotADirectory } from "./errors.ts";

export const validatePath = (
  input: string,
): Effect.Effect<string, InvalidCwd | CwdNotFound | NotADirectory> =>
  Effect.gen(function* () {
    const normalized = normalizeCwd(input);
    if (!isAbsolute(normalized)) return yield* new InvalidCwd({ path: input });
    const stat = yield* Effect.try({
      try: (): Stats => statSync(normalized),
      catch: (): CwdNotFound => new CwdNotFound({ path: normalized }),
    });
    if (!stat.isDirectory()) {
      return yield* new NotADirectory({ path: normalized });
    }
    return normalized;
  });
