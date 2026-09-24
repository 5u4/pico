import { AgentMessageId } from "@pico/contract/agent-message";
import { ChatId, type ChatResultSummaryEntry } from "@pico/contract/chat-model";
import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";
import { ChatReadState } from "./chat-read-state.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  failReads = false;
  failWrites = false;

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    if (this.failReads) throw new Error("Storage unavailable");
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    if (this.failWrites) throw new Error("Storage unavailable");
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("Storage unavailable");
    this.values.set(key, value);
  }
}

class MemoryLocks {
  private readonly pending = new Map<string, Promise<unknown>>();

  request<A>(name: string, callback: () => Promise<A> | A): Promise<A> {
    const result = (this.pending.get(name) ?? Promise.resolve()).then(callback);
    this.pending.set(name, result);
    return result;
  }
}

const chatId = ChatId.make("01900000-0000-7000-8000-000000000011");
const otherChatId = ChatId.make("01900000-0000-7000-8000-000000000012");
const seenKey = `pico-unread.v1.seen.${chatId}`;
const manualKey = `pico-unread.v1.manual.${chatId}`;
const lockKey = `pico-unread.v1.${chatId}`;
const cursor = (entryId: string) => ({ sessionId: "session-1", entryId });
const summaryEntry = (
  relation: "none" | "covered" | "behind",
  seenRevision: number,
  entryId: string | null = "entry-1",
): ChatResultSummaryEntry => ({
  chatId,
  seenRevision,
  summary: {
    kind: "ready",
    latest:
      entryId === null
        ? null
        : {
            cursor: cursor(entryId),
            messageId: AgentMessageId.make(`assistant-${entryId}`),
          },
    relation,
  },
});
const catalog = (entry: ChatResultSummaryEntry) => new Map([[entry.chatId, entry]]);
let storage: MemoryStorage;
let locks: MemoryLocks;

beforeEach(() => {
  storage = new MemoryStorage();
  locks = new MemoryLocks();
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("navigator", { locks });
});

afterEach(() => vi.unstubAllGlobals());

describe("chat read state", () => {
  it("baselines old results but leaves later results in initially empty and new chats unread", async () => {
    const state = new ChatReadState();
    await state.reconcileCatalog(
      new Map([
        [chatId, summaryEntry("none", 0, null)],
        [otherChatId, { ...summaryEntry("none", 0), chatId: otherChatId }],
      ]),
    );
    assert.strictEqual(
      state.unread(otherChatId, { ...summaryEntry("covered", 1), chatId: otherChatId }),
      false,
    );
    const later = summaryEntry("none", 1, "entry-2");
    await state.reconcileCatalog(catalog(later));
    assert.strictEqual(state.unread(chatId, later), true);
    await state.forgetChat(otherChatId);
    const newlyDiscovered = { ...summaryEntry("none", 0, "entry-3"), chatId: otherChatId };
    await state.reconcileCatalog(catalog(newlyDiscovered));
    assert.strictEqual(state.unread(otherChatId, newlyDiscovered), true);
  });

  it("does not baseline a new result when another page already completed initialization", async () => {
    const dormant = new ChatReadState();
    const active = new ChatReadState();
    await active.reconcileCatalog(new Map());
    const firstResult = summaryEntry("none", 0);
    await dormant.reconcileCatalog(catalog(firstResult));
    assert.strictEqual(dormant.unread(chatId, firstResult), true);
    assert.deepStrictEqual(dormant.buildRequest().chats, []);
  });

  it("keeps a new result unread when another page initializes while its catalog waits for a lock", async () => {
    const waiting = new ChatReadState();
    const initializing = new ChatReadState();
    const releaseInitialization = Promise.withResolvers<void>();
    const releaseChat = Promise.withResolvers<void>();
    const heldInitialization = locks.request(
      "pico-unread.v1.initialized",
      () => releaseInitialization.promise,
    );
    const heldChat = locks.request(lockKey, () => releaseChat.promise);
    const initialized = Promise.withResolvers<boolean>();
    const request = locks.request.bind(locks);
    vi.spyOn(locks, "request").mockImplementationOnce((name, callback) => {
      initialized.resolve(initializing.reconcileCatalog(new Map()));
      return request(name, callback);
    });
    const firstResult = summaryEntry("none", 0);
    const reconciliation = waiting.reconcileCatalog(catalog(firstResult));
    releaseInitialization.resolve();
    try {
      await initialized.promise;
    } finally {
      releaseChat.resolve();
    }
    await Promise.all([heldInitialization, heldChat, reconciliation]);
    assert.strictEqual(waiting.unread(chatId, firstResult), true);
    assert.deepStrictEqual(waiting.buildRequest().chats, []);
    assert.strictEqual(new ChatReadState().unread(chatId, firstResult), true);
  });

  it("finishes initialization with unavailable chats and leaves their recovered results unread", async () => {
    const state = new ChatReadState();
    const unavailable: ChatResultSummaryEntry = {
      chatId: otherChatId,
      seenRevision: 0,
      summary: { kind: "unavailable" },
    };
    await state.reconcileCatalog(
      new Map([
        [chatId, summaryEntry("none", 0, null)],
        [otherChatId, unavailable],
      ]),
    );
    assert.strictEqual(state.unread(otherChatId, unavailable), false);
    assert.strictEqual(await state.confirm(otherChatId, unavailable, null), false);
    assert.strictEqual(await state.markRead(otherChatId, unavailable), false);
    assert.deepStrictEqual(state.buildRequest().chats, [{ chatId, seen: null, seenRevision: 1 }]);
    const later = summaryEntry("none", 1, "entry-2");
    await state.reconcileCatalog(
      new Map([
        [chatId, later],
        [otherChatId, unavailable],
      ]),
    );
    assert.strictEqual(state.unread(chatId, later), true);
    const recovered = { ...summaryEntry("none", 0, "entry-3"), chatId: otherChatId };
    await state.reconcileCatalog(catalog(recovered));
    assert.strictEqual(state.unread(otherChatId, recovered), true);
    assert.deepStrictEqual(state.buildRequest().chats, [{ chatId, seen: null, seenRevision: 1 }]);
    const restored = new ChatReadState();
    assert.strictEqual(restored.unread(chatId, later), true);
    assert.strictEqual(restored.unread(otherChatId, recovered), true);
  });

  it("preserves reminders and seen records while a chat summary is unavailable", async () => {
    const state = new ChatReadState();
    await state.reconcileCatalog(catalog(summaryEntry("none", 0)));
    await state.markUnread(chatId);
    const unavailable: ChatResultSummaryEntry = {
      chatId,
      seenRevision: 1,
      summary: { kind: "unavailable" },
    };
    assert.strictEqual(await state.confirm(chatId, unavailable, state.captureOpen(chatId)), false);
    assert.strictEqual(await state.markRead(chatId, unavailable), false);
    await state.reconcileCatalog(catalog(unavailable));
    assert.strictEqual(state.unread(chatId, unavailable), true);
    assert.deepStrictEqual(state.buildRequest().chats, [
      { chatId, seen: cursor("entry-1"), seenRevision: 1 },
    ]);
    const restored = new ChatReadState();
    assert.strictEqual(restored.unread(chatId, unavailable), true);
    assert.strictEqual(await restored.markRead(chatId, summaryEntry("behind", 1, "entry-2")), true);
    assert.strictEqual(restored.unread(chatId, summaryEntry("covered", 2, "entry-2")), false);
    assert.deepStrictEqual(restored.buildRequest().chats, [
      { chatId, seen: cursor("entry-2"), seenRevision: 2 },
    ]);
  });

  it("propagates initialization callback failures without retrying or disabling persistence", async () => {
    const state = new ChatReadState();
    const failure = new Error("Subscriber failed");
    const unsubscribe = state.subscribe(() => {
      throw failure;
    });
    await state.reconcileCatalog(catalog(summaryEntry("none", 0))).then(
      () => assert.fail("Expected the subscriber failure"),
      (error) => assert.strictEqual(error, failure),
    );
    unsubscribe();
    await state.markUnread(chatId);
    const restored = new ChatReadState();
    assert.strictEqual(restored.unread(chatId, summaryEntry("covered", 1)), true);
    assert.deepStrictEqual(restored.buildRequest().chats, [
      { chatId, seen: cursor("entry-1"), seenRevision: 1 },
    ]);
  });

  it("keeps reminders across reload and passive confirmation until an explicit open", async () => {
    const state = new ChatReadState();
    await state.reconcileCatalog(catalog(summaryEntry("none", 0)));
    await state.markUnread(chatId);
    const restored = new ChatReadState();
    const covered = summaryEntry("covered", 1);
    await restored.confirm(chatId, covered, null);
    restored.syncFromStorage();
    assert.strictEqual(restored.unread(chatId, covered), true);
    await restored.confirm(chatId, covered, restored.captureOpen(chatId));
    assert.strictEqual(restored.unread(chatId, covered), false);
    state.syncFromStorage();
    assert.strictEqual(state.unread(chatId, covered), false);
    assert.strictEqual(await restored.confirm(chatId, covered, null), false);
    assert.strictEqual(await restored.markRead(chatId, undefined), false);
  });

  it("does not clear a reminder created while mark read waits for the lock", async () => {
    const state = new ChatReadState();
    await state.reconcileCatalog(catalog(summaryEntry("none", 0)));
    await state.markUnread(chatId);
    const replace = locks.request(lockKey, () =>
      storage.setItem(manualKey, JSON.stringify("new-reminder")),
    );
    const marking = state.markRead(chatId, summaryEntry("behind", 1, "entry-2"));
    await replace;
    await marking;
    assert.strictEqual(state.unread(chatId, summaryEntry("covered", 2, "entry-2")), true);
    assert.deepStrictEqual(state.buildRequest().chats, [
      { chatId, seen: cursor("entry-2"), seenRevision: 2 },
    ]);
    await state.markRead(chatId, summaryEntry("covered", 2, "entry-2"));
    assert.strictEqual(state.unread(chatId, summaryEntry("covered", 2, "entry-2")), false);
  });

  it("rejects stale acknowledgements and stale covered responses after another page advances", async () => {
    const state = new ChatReadState();
    await state.reconcileCatalog(catalog(summaryEntry("none", 0)));
    await state.markUnread(chatId);
    const capture = state.captureOpen(chatId);
    const other = new ChatReadState();
    await other.markRead(chatId, summaryEntry("behind", 1, "entry-3"));
    await other.markUnread(chatId);
    assert.strictEqual(await state.confirm(chatId, summaryEntry("covered", 1), capture), false);
    state.syncFromStorage();
    assert.strictEqual(state.unread(chatId, summaryEntry("covered", 2, "entry-3")), true);
    await state.markRead(chatId, summaryEntry("covered", 2, "entry-3"));
    assert.strictEqual(state.unread(chatId, summaryEntry("behind", 1, "entry-2")), false);
    assert.deepStrictEqual(state.buildRequest().chats, [
      { chatId, seen: cursor("entry-3"), seenRevision: 2 },
    ]);
  });

  it("requires a matching chat capture and a still-current view", async () => {
    const state = new ChatReadState();
    await state.reconcileCatalog(catalog(summaryEntry("none", 0)));
    await state.markUnread(chatId);
    const capture = state.captureOpen(chatId);
    await state.confirm(chatId, summaryEntry("covered", 1), { ...capture, chatId: otherChatId });
    let current = true;
    const confirmation = state.confirm(
      chatId,
      summaryEntry("behind", 1, "entry-2"),
      capture,
      () => current,
    );
    current = false;
    assert.strictEqual(await confirmation, false);
    assert.strictEqual(state.unread(chatId, summaryEntry("covered", 1)), true);
    assert.deepStrictEqual(state.buildRequest().chats, [
      { chatId, seen: cursor("entry-1"), seenRevision: 1 },
    ]);
  });

  it("rebases reset history without removing a manual reminder", async () => {
    const state = new ChatReadState();
    await state.reconcileCatalog(catalog(summaryEntry("none", 0)));
    await state.markUnread(chatId);
    const reset: ChatResultSummaryEntry = {
      chatId,
      seenRevision: 1,
      summary: {
        kind: "reset",
        latest: {
          cursor: { sessionId: "session-2", entryId: "entry-1" },
          messageId: AgentMessageId.make("new-result"),
        },
      },
    };
    await state.reconcileCatalog(catalog(reset));
    assert.strictEqual(state.unread(chatId, reset), true);
    assert.deepStrictEqual(state.buildRequest().chats, [
      { chatId, seen: { sessionId: "session-2", entryId: "entry-1" }, seenRevision: 2 },
    ]);
  });

  it("preserves reminders and records written while initial catalog processing waits", async () => {
    const state = new ChatReadState();
    const other = new ChatReadState();
    const marking = other.markUnread(chatId);
    const baseline = state.reconcileCatalog(catalog(summaryEntry("none", 0)));
    await marking;
    await baseline;
    assert.strictEqual(state.unread(chatId, summaryEntry("none", 0)), true);
    assert.deepStrictEqual(state.buildRequest().chats, []);
    const third = new ChatReadState();
    const acknowledge = third.markRead(chatId, summaryEntry("none", 0, "entry-2"));
    await acknowledge;
    state.syncFromStorage();
    assert.deepStrictEqual(state.buildRequest().chats, [
      { chatId, seen: cursor("entry-2"), seenRevision: 1 },
    ]);
  });

  it("keeps successful in-memory writes after persistence becomes unavailable", async () => {
    const state = new ChatReadState();
    await state.reconcileCatalog(catalog(summaryEntry("none", 0)));
    storage.failWrites = true;
    await state.markUnread(chatId);
    state.syncFromStorage();
    assert.strictEqual(state.unread(chatId, summaryEntry("covered", 1)), true);
    await state.markRead(chatId, summaryEntry("behind", 1, "entry-2"));
    state.syncFromStorage();
    assert.strictEqual(state.unread(chatId, summaryEntry("covered", 2, "entry-2")), false);
    assert.deepStrictEqual(state.buildRequest().chats, [
      { chatId, seen: cursor("entry-2"), seenRevision: 2 },
    ]);
  });

  it("preserves cached state when storage reads fail and does not claim cross-page writes without locks", async () => {
    const state = new ChatReadState();
    await state.reconcileCatalog(catalog(summaryEntry("none", 0)));
    await state.markUnread(chatId);
    storage.failReads = true;
    state.syncFromStorage();
    assert.strictEqual(state.unread(chatId, summaryEntry("covered", 1)), true);
    storage.failReads = false;
    vi.stubGlobal("navigator", {});
    const unlocked = new ChatReadState();
    await unlocked.markRead(chatId, summaryEntry("covered", 1));
    unlocked.syncFromStorage();
    assert.strictEqual(unlocked.unread(chatId, summaryEntry("covered", 1)), false);
    assert.strictEqual(new ChatReadState().unread(chatId, summaryEntry("covered", 1)), true);
  });

  it("ignores malformed versioned storage instead of trusting invalid cursor and revision values", async () => {
    storage.setItem("pico-unread.v1.initialized", "1");
    storage.setItem(
      seenKey,
      JSON.stringify({ seen: { sessionId: "", entryId: "entry-1" }, revision: -1 }),
    );
    storage.setItem(manualKey, JSON.stringify({ token: "not-a-token" }));
    const state = new ChatReadState();
    assert.strictEqual(state.unread(chatId, summaryEntry("none", 0)), true);
    await state.markRead(chatId, summaryEntry("none", 0));
    assert.strictEqual(state.unread(chatId, summaryEntry("covered", 1)), false);
  });
});
