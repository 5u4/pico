export type ConnectionStatus =
  | "connecting"
  | "online"
  | "reconnecting"
  | "reconnected";

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 15_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const RECONNECTED_NOTICE_MS = 2_000;
export const FILE_SEARCH_DEBOUNCE_MS = 120;

export function backoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt);
  const raw = RECONNECT_BASE_MS * 2 ** exponent;
  return Math.min(raw, RECONNECT_MAX_MS);
}
