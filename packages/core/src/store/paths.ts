import { homedir } from "node:os";
import { join, normalize } from "node:path";

export const normalizeCwd = (input: string): string => {
  if (input.length === 0) return input;
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return normalize(input);
};
