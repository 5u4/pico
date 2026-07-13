import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export const configSchema = z.object({
  name: z.string().min(1),
  port: z.number().int().positive(),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): Result<Config, string> {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return err(parsed.error.issues.map((i) => i.message).join("; "));
  }
  return ok(parsed.data);
}

export function greet(cfg: Config): string {
  return `${cfg.name} listening on ${Bun.env.HOST ?? "localhost"}:${cfg.port}`;
}
