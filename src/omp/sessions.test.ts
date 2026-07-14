import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { newId } from "../util/id";
import type { OmpRuntime } from "./runtime";
import { Sessions } from "./sessions";

interface FakeSession {
  id: string;
  disposeCount: number;
}

class TestSessions extends Sessions {
  constructCount = 0;
  readonly created: FakeSession[] = [];
  readonly gates = new Map<string, PromiseWithResolvers<void>>();
  readonly failConstruct = new Set<string>();
  readonly failDispose = new Set<string>();

  constructor() {
    super({} as OmpRuntime, { sessionsRoot: "/tmp/pico-sessions-test" });
  }

  gate(id: string): PromiseWithResolvers<void> {
    const created = Promise.withResolvers<void>();
    this.gates.set(id, created);
    return created;
  }

  protected override async construct(
    conversationId: string,
  ): Promise<AgentSession> {
    this.constructCount++;
    await this.gates.get(conversationId)?.promise;
    if (this.failConstruct.has(conversationId)) {
      throw new Error(`construct failed: ${conversationId}`);
    }
    const fake: FakeSession = { id: conversationId, disposeCount: 0 };
    this.created.push(fake);
    const session = {
      dispose: (): Promise<void> => {
        fake.disposeCount++;
        if (this.failDispose.has(conversationId)) {
          return Promise.reject(new Error(`dispose failed: ${conversationId}`));
        }
        return Promise.resolve();
      },
    };
    return session as unknown as AgentSession;
  }
}

describe("Sessions.open", () => {
  test("rejects a non-ULID id without constructing", async () => {
    const sessions = new TestSessions();
    const result = await sessions.open("../evil", { cwd: "/x" });
    expect(result.isErr()).toBe(true);
    expect(sessions.constructCount).toBe(0);
  });

  test("reuses a live session instead of rebuilding", async () => {
    const sessions = new TestSessions();
    const id = newId();
    const first = await sessions.open(id, { cwd: "/x" });
    const second = await sessions.open(id, { cwd: "/x" });
    expect(sessions.constructCount).toBe(1);
    expect(first._unsafeUnwrap()).toBe(second._unsafeUnwrap());
  });

  test("dedups concurrent opens of the same id to one construct", async () => {
    const sessions = new TestSessions();
    const id = newId();
    const gate = sessions.gate(id);
    const opens = [
      sessions.open(id, { cwd: "/x" }),
      sessions.open(id, { cwd: "/x" }),
      sessions.open(id, { cwd: "/x" }),
    ];
    gate.resolve();
    const results = await Promise.all(opens);
    expect(sessions.constructCount).toBe(1);
    const values = results.map((r) => r._unsafeUnwrap());
    expect(values[0]).toBe(values[1]);
    expect(values[1]).toBe(values[2]);
    expect(sessions.get(id)).toBe(values[0]);
  });

  test("propagates a construct failure and clears pending for retry", async () => {
    const sessions = new TestSessions();
    const id = newId();
    sessions.failConstruct.add(id);
    const failed = await sessions.open(id, { cwd: "/x" });
    expect(failed.isErr()).toBe(true);
    expect(sessions.get(id)).toBeUndefined();

    sessions.failConstruct.delete(id);
    const retried = await sessions.open(id, { cwd: "/x" });
    expect(retried.isOk()).toBe(true);
    expect(sessions.constructCount).toBe(2);
  });

  test("loses to a concurrent closeAll and disposes the orphan", async () => {
    const sessions = new TestSessions();
    const id = newId();
    const gate = sessions.gate(id);
    const opening = sessions.open(id, { cwd: "/x" });
    const closing = sessions.closeAll();
    gate.resolve();
    await closing;
    const result = await opening;

    expect(result.isErr()).toBe(true);
    expect(sessions.get(id)).toBeUndefined();
    expect(sessions.created[0]?.disposeCount).toBeGreaterThanOrEqual(1);
  });
});

describe("Sessions.closeAll", () => {
  test("disposes every live session and tolerates a dispose failure", async () => {
    const sessions = new TestSessions();
    const a = newId();
    const b = newId();
    await sessions.open(a, { cwd: "/x" });
    await sessions.open(b, { cwd: "/x" });
    sessions.failDispose.add(a);

    await sessions.closeAll();

    expect(sessions.get(a)).toBeUndefined();
    expect(sessions.get(b)).toBeUndefined();
    const fakeA = sessions.created.find((f) => f.id === a);
    const fakeB = sessions.created.find((f) => f.id === b);
    expect(fakeA?.disposeCount).toBeGreaterThanOrEqual(1);
    expect(fakeB?.disposeCount).toBe(1);
  });
});
