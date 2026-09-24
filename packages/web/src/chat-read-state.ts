import {
  ChatId,
  type ChatResultSummaryEntry,
  type ChatResultsRequest,
  ResultCursor,
} from "@pico/contract/chat-model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const SeenRecord = Schema.Struct({
  seen: Schema.NullOr(ResultCursor),
  revision: Schema.Natural,
});
type SeenRecord = typeof SeenRecord.Type;

interface LockManagerLike {
  request<A>(name: string, callback: () => Promise<A> | A): Promise<A>;
}

export interface OpenCapture {
  readonly chatId: ChatId;
  readonly reminderToken: string | null;
}

const storagePrefix = "pico-unread.v1";
const initializedKey = `${storagePrefix}.initialized`;
const seenPrefix = `${storagePrefix}.seen.`;
const manualPrefix = `${storagePrefix}.manual.`;
const probeKey = `${storagePrefix}.probe`;
const seenKey = (chatId: ChatId) => `${seenPrefix}${chatId}`;
const manualKey = (chatId: ChatId) => `${manualPrefix}${chatId}`;
const chatLockKey = (chatId: ChatId) => `${storagePrefix}.${chatId}`;
const decodeSeen = Schema.decodeUnknownOption(Schema.fromJsonString(SeenRecord));
const decodeManual = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.NonEmptyString));
const decodeChatId = Schema.decodeUnknownOption(ChatId);

const equalCursor = (left: ResultCursor | null, right: ResultCursor | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.sessionId === right.sessionId &&
    left.entryId === right.entryId);

export class ChatReadState {
  private storage: Storage | null = null;
  private locks: LockManagerLike | null = null;
  private seen = new Map<ChatId, SeenRecord>();
  private manual = new Map<ChatId, string>();
  private readonly listeners = new Set<() => void>();
  private initialized = false;
  private request: ChatResultsRequest | null = null;

  constructor() {
    try {
      this.locks = navigator.locks ?? null;
      const storage = window.localStorage;
      storage.setItem(probeKey, "1");
      storage.removeItem(probeKey);
      this.storage = storage;
      this.reloadFromStorage();
    } catch {
      this.storage = null;
    }
    if (this.locks === null) this.storage = null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  buildRequest(): ChatResultsRequest {
    this.request ??= {
      chats: [...this.seen].map(([chatId, record]) => ({
        chatId,
        seen: record.seen,
        seenRevision: record.revision,
      })),
      includeAllOpenChats: true,
    };
    return this.request;
  }

  captureOpen(chatId: ChatId): OpenCapture {
    return { chatId, reminderToken: this.readManualCurrent(chatId) ?? null };
  }

  unread(chatId: ChatId, entry: ChatResultSummaryEntry | undefined): boolean {
    if (this.manual.has(chatId)) return true;
    if (entry?.summary.kind !== "ready" || entry.summary.latest === null) return false;
    const seen = this.seen.get(chatId);
    if (equalCursor(seen?.seen ?? null, entry.summary.latest.cursor)) return false;
    if ((seen?.revision ?? 0) !== entry.seenRevision) return false;
    return (
      entry.summary.relation === "behind" || (entry.summary.relation === "none" && this.initialized)
    );
  }

  async markUnread(chatId: ChatId): Promise<boolean> {
    return this.withLock(chatLockKey(chatId), () => {
      this.persistManual(chatId, crypto.randomUUID());
      this.notify();
      return true;
    });
  }

  markRead(chatId: ChatId, entry: ChatResultSummaryEntry | undefined): Promise<boolean> {
    const summary = entry?.summary;
    if (summary?.kind === "unavailable") return Promise.resolve(false);
    const capture = this.captureOpen(chatId);
    const revision = entry?.seenRevision ?? this.readSeenCurrent(chatId)?.revision ?? 0;
    return this.withLock(chatLockKey(chatId), () =>
      this.acknowledge(chatId, summary?.latest?.cursor ?? null, revision, capture),
    );
  }

  confirm(
    chatId: ChatId,
    entry: ChatResultSummaryEntry | undefined,
    capture: OpenCapture | null,
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    if (!entry) return Promise.resolve(false);
    const { summary } = entry;
    if (summary.kind === "unavailable") return Promise.resolve(false);
    return this.withLock(
      chatLockKey(chatId),
      () =>
        isCurrent() &&
        this.acknowledge(chatId, summary.latest?.cursor ?? null, entry.seenRevision, capture),
    );
  }

  private acknowledge(
    chatId: ChatId,
    latest: ResultCursor | null,
    revision: number,
    capture: OpenCapture | null,
  ): boolean {
    const previousRequest = this.request;
    const current = this.readSeenCurrent(chatId);
    if ((current?.revision ?? 0) !== revision) {
      if (previousRequest !== this.request) this.notify();
      return false;
    }
    let changed = false;
    if (latest !== null && !equalCursor(current?.seen ?? null, latest)) {
      this.persistSeen(chatId, { seen: latest, revision: revision + 1 });
      changed = true;
    }
    if (
      capture !== null &&
      capture.chatId === chatId &&
      capture.reminderToken !== null &&
      this.readManualCurrent(chatId) === capture.reminderToken
    ) {
      this.persistManual(chatId, undefined);
      changed = true;
    }
    if (changed) this.notify();
    return changed;
  }

  async reconcileCatalog(entries: ReadonlyMap<ChatId, ChatResultSummaryEntry>): Promise<boolean> {
    const reconcile = async () => {
      const wasInitialized = this.initialized;
      if (!wasInitialized) this.reloadFromStorage();
      const initializing = !this.initialized;
      let changed = wasInitialized !== this.initialized;
      for (const [chatId, entry] of entries) {
        const { summary } = entry;
        if (summary.kind === "unavailable") continue;
        if (!initializing && summary.kind !== "reset") continue;
        const wrote = await this.withLock(chatLockKey(chatId), () => {
          if (initializing && this.initialized) return false;
          const current = this.readSeenCurrent(chatId);
          if (
            initializing &&
            (current !== undefined || this.readManualCurrent(chatId) !== undefined)
          )
            return false;
          if ((current?.revision ?? 0) !== entry.seenRevision) return false;
          const target = summary.latest?.cursor ?? null;
          if (!initializing && equalCursor(current?.seen ?? null, target)) return false;
          this.persistSeen(chatId, { seen: target, revision: entry.seenRevision + 1 });
          return true;
        });
        changed = wrote || changed;
      }
      if (initializing && !this.initialized) {
        this.initialized = true;
        this.persist(initializedKey, "1");
        changed = true;
      }
      if (changed) this.notify();
      return changed;
    };
    return this.initialized ? reconcile() : this.withLock(initializedKey, reconcile);
  }

  forgetChat(chatId: ChatId): Promise<void> {
    return this.forgetChats([chatId]);
  }

  async forgetChats(chatIds: Iterable<ChatId>): Promise<void> {
    let changed = false;
    for (const chatId of chatIds) {
      await this.withLock(chatLockKey(chatId), () => {
        const hadSeen = this.readSeenCurrent(chatId) !== undefined;
        const hadManual = this.readManualCurrent(chatId) !== undefined;
        this.seen.delete(chatId);
        if (hadSeen) this.request = null;
        this.manual.delete(chatId);
        this.persist(seenKey(chatId), null);
        this.persist(manualKey(chatId), null);
        changed = hadSeen || hadManual || changed;
      });
    }
    if (changed) this.notify();
  }

  syncFromStorage(): void {
    this.reloadFromStorage();
    this.notify();
  }

  syncFromStorageEvent(event: StorageEvent): void {
    if (
      event.key === null ||
      event.key === initializedKey ||
      event.key.startsWith(seenPrefix) ||
      event.key.startsWith(manualPrefix)
    )
      this.syncFromStorage();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async withLock<A>(name: string, evaluate: () => Promise<A> | A): Promise<A> {
    if (this.storage === null || this.locks === null) return evaluate();
    let acquired = false;
    try {
      return await this.locks.request(name, () => {
        acquired = true;
        return evaluate();
      });
    } catch (error) {
      if (acquired) throw error;
      this.storage = null;
      this.locks = null;
      return evaluate();
    }
  }

  private readSeenCurrent(chatId: ChatId): SeenRecord | undefined {
    if (this.storage !== null) {
      try {
        const record = Option.getOrUndefined(decodeSeen(this.storage.getItem(seenKey(chatId))));
        const previous = this.seen.get(chatId);
        if (
          previous?.revision !== record?.revision ||
          !equalCursor(previous?.seen ?? null, record?.seen ?? null)
        )
          this.request = null;
        if (record === undefined) this.seen.delete(chatId);
        else this.seen.set(chatId, record);
      } catch {
        this.storage = null;
      }
    }
    return this.seen.get(chatId);
  }

  private readManualCurrent(chatId: ChatId): string | undefined {
    if (this.storage !== null) {
      try {
        const token = Option.getOrUndefined(decodeManual(this.storage.getItem(manualKey(chatId))));
        if (token === undefined) this.manual.delete(chatId);
        else this.manual.set(chatId, token);
      } catch {
        this.storage = null;
      }
    }
    return this.manual.get(chatId);
  }

  private persistSeen(chatId: ChatId, record: SeenRecord): void {
    this.seen.set(chatId, record);
    this.request = null;
    this.persist(seenKey(chatId), JSON.stringify(record));
  }

  private persistManual(chatId: ChatId, token: string | undefined): void {
    if (token === undefined) this.manual.delete(chatId);
    else this.manual.set(chatId, token);
    this.persist(manualKey(chatId), token === undefined ? null : JSON.stringify(token));
  }

  private persist(key: string, value: string | null): void {
    if (this.storage === null) return;
    try {
      if (value === null) this.storage.removeItem(key);
      else this.storage.setItem(key, value);
    } catch {
      this.storage = null;
    }
  }

  private reloadFromStorage(): void {
    if (this.storage === null) return;
    try {
      const initialized = this.storage.getItem(initializedKey) === "1";
      const seen = new Map<ChatId, SeenRecord>();
      const manual = new Map<ChatId, string>();
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (key === null) continue;
        if (key.startsWith(seenPrefix)) {
          const chatId = Option.getOrUndefined(decodeChatId(key.slice(seenPrefix.length)));
          const record = Option.getOrUndefined(decodeSeen(this.storage.getItem(key)));
          if (chatId !== undefined && record !== undefined) seen.set(chatId, record);
        } else if (key.startsWith(manualPrefix)) {
          const chatId = Option.getOrUndefined(decodeChatId(key.slice(manualPrefix.length)));
          const token = Option.getOrUndefined(decodeManual(this.storage.getItem(key)));
          if (chatId !== undefined && token !== undefined) manual.set(chatId, token);
        }
      }
      if (
        seen.size !== this.seen.size ||
        [...seen].some(([chatId, record]) => {
          const previous = this.seen.get(chatId);
          return (
            previous?.revision !== record.revision ||
            !equalCursor(previous?.seen ?? null, record.seen)
          );
        })
      )
        this.request = null;
      this.seen = seen;
      this.manual = manual;
      this.initialized = initialized;
    } catch {
      this.storage = null;
    }
  }
}

export const createChatReadState = () => new ChatReadState();
