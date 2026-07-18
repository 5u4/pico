const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  ],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED]"],
  [/AIza[0-9A-Za-z_-]{35}/g, "[REDACTED]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    "[REDACTED]",
  ],
  [/bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "Bearer [REDACTED]"],
];

export function scrub(input: string): string {
  let current = input;
  for (const [pattern, replacement] of PATTERNS) {
    current = current.replace(pattern, replacement);
  }
  return current;
}
