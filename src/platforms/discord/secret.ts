import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok, ResultAsync } from "neverthrow";
import { errMessage } from "../../util/result";

export function readBotToken(): ResultAsync<string, string> {
  const path = join(homedir(), ".pico", "secrets", "discord_bot_token");
  return ResultAsync.fromPromise(Bun.file(path).exists(), errMessage).andThen(
    (exists) => {
      if (!exists)
        return err<string, string>(
          `discord bot token not found at ${path}; write it there (chmod 600) and restart`,
        );
      return ResultAsync.fromPromise(Bun.file(path).text(), errMessage).andThen(
        (raw) => {
          const value = raw.trim();
          if (value.length === 0) return err(`secret ${path} is empty`);
          return ok(value);
        },
      );
    },
  );
}
