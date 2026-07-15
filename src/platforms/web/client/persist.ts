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
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
}

export function writePersisted<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
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
