import { basename } from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { scrub } from "./redact";

const SECRET_BASENAMES: ReadonlySet<string> = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "secrets.yml",
  "secrets.yaml",
  ".npmrc",
  ".pypirc",
]);

const SECRET_SUFFIXES: ReadonlyArray<string> = [".pem", ".key"];

const ENV_TEMPLATE_SUFFIXES: ReadonlyArray<string> = [
  ".example",
  ".sample",
  ".template",
  ".dist",
];

export function isSecretPath(path: string): boolean {
  const name = basename(path.trim());
  if (name.length === 0) return false;
  if (SECRET_BASENAMES.has(name)) return true;
  if (SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (name === ".env" || name.startsWith(".env.")) {
    return !ENV_TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
  }
  return false;
}

function scrubContent(
  content: ReadonlyArray<TextContent | ImageContent>,
): (TextContent | ImageContent)[] | undefined {
  let changed = false;
  const next = content.map((block) => {
    if (block.type !== "text") return block;
    const scrubbed = scrub(block.text);
    if (scrubbed === block.text) return block;
    changed = true;
    return { ...block, text: scrubbed };
  });
  return changed ? next : undefined;
}

export function secretGuard(pi: ExtensionAPI): void {
  pi.on("input", (event) => {
    const scrubbed = scrub(event.text);
    if (scrubbed === event.text) return;
    return { text: scrubbed };
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "read" && event.toolName !== "grep") return;
    const input = event.input;
    if (!input || typeof input !== "object" || !("path" in input)) return;
    const path = input.path;
    if (typeof path !== "string" || !isSecretPath(path)) return;
    return {
      block: true,
      reason: `Reading ${path} is blocked: it may contain secrets. Ask the user to share only the specific non-secret values you need.`,
    };
  });

  pi.on("tool_result", (event) => {
    const next = scrubContent(event.content);
    if (!next) return;
    return { content: next };
  });
}
