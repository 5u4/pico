import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { z } from "zod";

export const PERSIST_KEYS = {
  sidebarHidden: "pico:web:sidebar-hidden",
  workspacesCollapsed: "pico:web:workspaces-collapsed",
  activeConversation: "pico:web:active-conversation",
} as const;

export function readPersisted<T>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : fallback;
}

export function writePersisted<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function usePersisted<T>(
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    readPersisted(key, schema, fallback),
  );
  useEffect(() => {
    writePersisted(key, value);
  }, [key, value]);
  return [value, setValue];
}
