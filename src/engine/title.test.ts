import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { autoTitle } from "./title";

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
