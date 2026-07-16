import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { autoTitle, provisionalTitle } from "./title";

const unusedSession = {} as AgentSession;

const originalNoTitle = process.env.PI_NO_TITLE;

afterEach(() => {
  if (originalNoTitle === undefined) delete process.env.PI_NO_TITLE;
  else process.env.PI_NO_TITLE = originalNoTitle;
});

describe("autoTitle null branches", () => {
  test("returns null when PI_NO_TITLE is set without touching the session", async () => {
    process.env.PI_NO_TITLE = "1";
    expect(
      await autoTitle(unusedSession, "Add pagination to the users endpoint"),
    ).toBeNull();
  });

  test("returns null for low-signal input without touching the session", async () => {
    delete process.env.PI_NO_TITLE;
    expect(await autoTitle(unusedSession, "hi")).toBeNull();
    expect(await autoTitle(unusedSession, "thanks")).toBeNull();
  });
});

describe("provisionalTitle", () => {
  test("returns the first non-empty line trimmed", () => {
    expect(provisionalTitle("  fix the parser  \n more ")).toBe(
      "fix the parser",
    );
  });

  test("returns null for blank input", () => {
    expect(provisionalTitle("   \n  ")).toBeNull();
  });

  test("truncates a long line with an ellipsis", () => {
    const long = "a".repeat(80);
    const result = provisionalTitle(long);
    expect(result).toBe(`${"a".repeat(60)}…`);
  });
});
