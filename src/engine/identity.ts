import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../util/log";
import { errMessage } from "../util/result";

const logger = log(["identity"]);

const persona = readFileSync(join(import.meta.dir, "persona.md"), "utf8");

export function defaultIdentityPath(): string {
  return join(homedir(), ".pico", "identity.md");
}

export function loadIdentity(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    logger.warning("reading identity.md failed at {path}: {error}", {
      path,
      error: errMessage(error),
    });
    return undefined;
  }
}

export function assembleAppendPrompt(identity: string | undefined): string {
  return identity === undefined ? persona : `${persona}\n\n${identity}`;
}
