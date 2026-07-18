import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok, Result } from "neverthrow";
import { z } from "zod";

export const configSchema = z.object({
  workspaceCwd: z.string().min(1).default(join(homedir(), ".pico")),
  worktreeCwd: z
    .string()
    .min(1)
    .default(join(homedir(), ".pico", "worktrees")),
  web: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().positive().default(4141),
    })
    .prefault({}),
});
export type Config = z.infer<typeof configSchema>;

export function defaultConfigPath(): string {
  return join(homedir(), ".pico", "config.toml");
}

export function parseConfig(raw: unknown): Result<Config, string> {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return err(parsed.error.issues.map((i) => i.message).join("; "));
  }
  return ok(parsed.data);
}

export async function loadConfig(
  path = defaultConfigPath(),
): Promise<Result<Config, string>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return parseConfig({});
  const text = await file.text();
  return Result.fromThrowable(
    () => Bun.TOML.parse(text) as unknown,
    (e) =>
      `invalid config toml at ${path}: ${e instanceof Error ? e.message : String(e)}`,
  )().andThen(parseConfig);
}
