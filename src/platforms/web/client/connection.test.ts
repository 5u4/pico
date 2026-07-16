import { describe, expect, test } from "bun:test";
import {
  backoffDelayMs,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "./connection";

describe("backoffDelayMs", () => {
  test("first attempt uses the base delay", () => {
    expect(backoffDelayMs(0)).toBe(RECONNECT_BASE_MS);
  });

  test("doubles per attempt", () => {
    expect(backoffDelayMs(1)).toBe(RECONNECT_BASE_MS * 2);
    expect(backoffDelayMs(2)).toBe(RECONNECT_BASE_MS * 4);
  });

  test("caps at the max delay", () => {
    expect(backoffDelayMs(20)).toBe(RECONNECT_MAX_MS);
  });

  test("clamps negative attempts to the base delay", () => {
    expect(backoffDelayMs(-5)).toBe(RECONNECT_BASE_MS);
  });
});
