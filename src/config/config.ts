import { homedir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export const configSchema = z.object({
  port: z.number().int().positive().default(4141),
  workspaceCwd: z.string().min(1).default(join(homedir(), ".pico")),
});

export type Config = z.infer<typeof configSchema>;

export function defaultConfigPath(): string {
  return join(homedir(), ".pico", "config.json");
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
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return err(
      `invalid config json at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return parseConfig(raw);
}
