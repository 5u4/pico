import NodeFileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { HistoryEntryId } from "@pico/contract/agent-history";
import { AbsolutePath } from "@pico/contract/path";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const importNative = async () => {
  const [
    managers,
    loaders,
    contexts,
    titles,
    auth,
    registries,
    settings,
    sessionSettings,
    blobs,
    adapter,
  ] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/session/session-manager"),
    import("@oh-my-pi/pi-coding-agent/session/session-loader"),
    import("@oh-my-pi/pi-coding-agent/session/session-context"),
    import("@oh-my-pi/pi-coding-agent/session/session-title-slot"),
    import("@oh-my-pi/pi-coding-agent/session/auth-storage"),
    import("@oh-my-pi/pi-coding-agent/config/model-registry"),
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    import("./session-settings.ts"),
    import("@oh-my-pi/pi-coding-agent/session/blob-store"),
    import("./layer.ts"),
  ]);
  return {
    ...managers,
    ...loaders,
    ...contexts,
    ...titles,
    ...auth,
    ...registries,
    ...settings,
    ...sessionSettings,
    ...blobs,
    normalizeHistory: adapter.normalizeHistory,
    projectHistoryPreview: adapter.projectHistoryPreview,
  };
};

let native: Awaited<ReturnType<typeof importNative>>;
let root: string;

beforeAll(async () => {
  root = await NodeFileSystem.realpath(
    await NodeFileSystem.mkdtemp(join(tmpdir(), "pico-history-cursor-")),
  );
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("OMP_PROFILE", "default");
  vi.stubEnv("PI_PROFILE", "default");
  vi.stubEnv("PI_TEST_RUNTIME", "1");
  vi.stubEnv("PI_NO_TITLE", "1");
  native = await importNative();
}, 30_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (root) await NodeFileSystem.rm(root, { recursive: true, force: true });
});

const userMessage = (content: string): UserMessage => ({ role: "user", content, timestamp: 1 });

const withJournal = async (
  run: (
    manager: SessionManager,
    file: string,
    cwd: string,
    reopen: () => Promise<SessionManager>,
  ) => Promise<void>,
) => {
  const cwd = await NodeFileSystem.mkdtemp(join(root, "session-"));
  let manager = native.SessionManager.create(cwd, join(cwd, "sessions"));
  const file = manager.getSessionFile();
  if (file === undefined) throw new Error("Expected a file-backed native session");
  try {
    await manager.ensureOnDisk();
    await run(manager, file, cwd, async () => {
      await manager.close();
      manager = await native.SessionManager.open(file, undefined, undefined, {
        initialCwd: cwd,
        suppressBreadcrumb: true,
        throwIfMissing: true,
      });
      return manager;
    });
  } finally {
    await manager.close();
  }
};

describe("native history cursor persistence", () => {
  it("restarts at a branch or explicit root without adding logical entries", async () => {
    await withJournal(async (manager, file, _cwd, reopen) => {
      const first = manager.appendMessage(userMessage("First"));
      const tail = manager.appendMessage(userMessage("Tail"));
      await manager.flush();

      for (const leaf of [first, null]) {
        if (leaf === null) manager.resetLeaf();
        else manager.branch(leaf);
        await manager.flush();
        const before = await NodeFileSystem.readFile(file, "utf8");
        const expectedMessages = leaf === null ? [] : [userMessage("First")];
        const loaded = [
          native.parseSessionContent(before),
          await native.loadEntriesFromFileStream(file, { throwIfMissing: true }),
        ];
        for (const result of loaded) {
          expect(result.cursor?.leafId).toBe(leaf);
          expect(result.entries.map((entry) => entry.type)).toEqual([
            "session",
            "message",
            "message",
          ]);
        }
        const history = await native.loadSessionHistoryReadOnly(file);
        expect(history.activeLeafId).toBe(leaf);
        expect(history.entries.map((entry) => entry.id)).toEqual([first, tail]);
        expect(native.buildSessionContext(history.entries, history.activeLeafId).messages).toEqual(
          expectedMessages,
        );
        expect(await native.loadSessionMessagesReadOnly(file)).toEqual(expectedMessages);
        expect((await native.loadSessionSnapshotReadOnly(file)).messages).toEqual(expectedMessages);

        manager = await reopen();
        expect(manager.getLeafId()).toBe(leaf);
        expect(manager.getBranch().map((entry) => entry.id)).toEqual(leaf === null ? [] : [first]);
        expect(manager.buildSessionContext().messages).toEqual(expectedMessages);
        expect(
          manager.getTree().map((node) => ({
            id: node.entry.id,
            children: node.children.map((child) => child.entry.id),
          })),
        ).toEqual([{ id: first, children: [tail] }]);
        expect(await NodeFileSystem.readFile(file, "utf8")).toBe(before);
      }

      const newRoot = manager.appendMessage(userMessage("New root"));
      await manager.flush();
      manager = await reopen();
      expect(manager.getEntry(newRoot)?.parentId).toBeNull();
      expect(manager.getTree().map((node) => node.entry.id)).toEqual([first, newRoot]);
      expect(await native.loadSessionMessagesReadOnly(file)).toEqual([userMessage("New root")]);
    });
  });

  it("keeps off-branch appends off the active path and advances for an ordinary append", async () => {
    await withJournal(async (manager, file, _cwd, reopen) => {
      const first = manager.appendMessage(userMessage("First"));
      const active = manager.appendMessage(userMessage("Active"));
      const side = manager.appendMessageToBranch(userMessage("Side"), first);
      await manager.flush();
      manager = await reopen();
      expect(manager.getLeafId()).toBe(active);
      expect(manager.getEntries().map((entry) => entry.id)).toEqual([first, active, side]);
      expect(manager.getChildren(first).map((entry) => entry.id)).toEqual([active, side]);
      expect(await native.loadSessionMessagesReadOnly(file)).toEqual([
        userMessage("First"),
        userMessage("Active"),
      ]);
      for (const result of [
        native.parseSessionContent(await NodeFileSystem.readFile(file, "utf8")),
        await native.loadEntriesFromFileStream(file),
      ]) {
        expect(result.cursor?.leafId).toBe(active);
        expect(result.entries.at(-1)?.id).toBe(side);
      }

      manager.resetLeaf();
      const late = manager.appendMessageToBranch(userMessage("Late"), side);
      await manager.flush();
      manager = await reopen();
      expect(manager.getLeafId()).toBeNull();
      expect(manager.getEntry(late)?.parentId).toBe(side);
      expect((await native.loadSessionHistoryReadOnly(file)).activeLeafId).toBeNull();
      expect(await native.loadSessionMessagesReadOnly(file)).toEqual([]);

      manager.branch(active);
      const next = manager.appendMessage(userMessage("Next"));
      await manager.flush();
      manager = await reopen();
      expect(manager.getLeafId()).toBe(next);
      expect(manager.getEntry(next)?.parentId).toBe(active);
      for (const result of [
        native.parseSessionContent(await NodeFileSystem.readFile(file, "utf8")),
        await native.loadEntriesFromFileStream(file),
      ]) {
        expect(result.cursor?.leafId).toBe(next);
      }
      expect(await native.loadSessionMessagesReadOnly(file)).toEqual([
        userMessage("First"),
        userMessage("Active"),
        userMessage("Next"),
      ]);
    });
  });

  it("resolves a cold chat's genuine model from the selected branch", async () => {
    await withJournal(async (manager, file, cwd, reopen) => {
      const auth = await native.AuthStorage.create(join(cwd, "auth.db"));
      try {
        auth.setRuntimeApiKey("openai", "local-history-test");
        const registry = new native.ModelRegistry(auth, join(cwd, "models.yml"), {
          settings: native.Settings.isolated({}),
          ignoreLocalModelConfig: true,
        });
        const first = manager.appendModelChange("openai/gpt-4.1", "default");
        const second = manager.appendModelChange("openai/gpt-4.1-mini", "default");
        for (const [leaf, id] of [
          [first, "gpt-4.1"],
          [second, "gpt-4.1-mini"],
        ] as const) {
          manager.branch(leaf);
          await manager.flush();
          manager = await reopen();
          const before = await NodeFileSystem.readFile(file, "utf8");
          const selected = await Effect.runPromise(
            native.loadCurrentModel(registry, AbsolutePath.make(cwd), file),
          );
          expect(selected).toMatchObject({ provider: "openai", id });
          expect(manager.buildSessionContext().models.default).toBe(`openai/${id}`);
          expect(await NodeFileSystem.readFile(file, "utf8")).toBe(before);
        }
      } finally {
        auth.close();
      }
    });
  });

  it("preserves bounded header reads and raw non-object JSON around cursor records", async () => {
    await withJournal(async (manager, file) => {
      const first = manager.appendMessage(userMessage("First"));
      manager.resetLeaf();
      manager.branch(first);
      await manager.close();
      const valid = await NodeFileSystem.readFile(file, "utf8");
      const header = { ...manager.getHeader(), title: "Legacy title" };
      const slot = native.serializeTitleSlot({ updatedAt: "2026-09-15T00:00:00.000Z" });
      for (const value of [null, 42, false, "not an entry", []]) {
        const content = `${slot}${JSON.stringify(value)}\n${JSON.stringify(header)}\n`;
        await NodeFileSystem.writeFile(file, content);
        const visited: unknown[] = [];
        await native.visitEntriesFromFileStream(
          file,
          (entry) => {
            visited.push(entry);
            return false;
          },
          { maxRecords: 1 },
        );
        expect(visited).toEqual([value]);
        for (const result of [
          native.parseSessionContent(content),
          await native.loadEntriesFromFileStream(file),
        ]) {
          expect(result.invalidHeader).toBe(true);
          expect(result.malformedRecords).toBe(0);
          expect(result.entries[0]).toEqual(value);
        }
        expect(await NodeFileSystem.readFile(file, "utf8")).toBe(content);

        const afterCursor = `${valid}${JSON.stringify(value)}\n`;
        await NodeFileSystem.writeFile(file, afterCursor);
        for (const result of [
          native.parseSessionContent(afterCursor),
          await native.loadEntriesFromFileStream(file),
        ]) {
          expect(result.cursor?.leafId).toBe(first);
          expect(result.entries.at(-1)).toEqual(value);
        }
      }
    });
  });

  it("rejects malformed or dangling actual cursors without rewriting the journal", async () => {
    await withJournal(async (manager, file, cwd) => {
      const first = manager.appendMessage(userMessage("First"));
      manager.resetLeaf();
      manager.branch(first);
      await manager.close();
      const original = await NodeFileSystem.readFile(file, "utf8");
      const lines = original.trimEnd().split("\n");
      const lastLine = lines.pop();
      if (lastLine === undefined) throw new Error("Expected a persisted cursor record");
      const cursor = JSON.parse(lastLine);
      expect(cursor).toMatchObject({ type: "session_cursor", leafId: first });
      const prefix = `${lines.join("\n")}\n`;
      for (const corrupt of [
        { ...cursor, leafId: 42 },
        { ...cursor, revision: "" },
        { ...cursor, leafId: "missing-entry" },
      ]) {
        const content = `${prefix}${JSON.stringify(corrupt)}\n`;
        await NodeFileSystem.writeFile(file, content);
        expect(() => native.parseSessionContent(content)).toThrow(/cursor/i);
        for (const load of [
          () => native.loadEntriesFromFileStream(file),
          () => native.loadSessionHistoryReadOnly(file),
          () => native.loadSessionMessagesReadOnly(file),
          () =>
            native.SessionManager.open(file, undefined, undefined, {
              initialCwd: cwd,
              suppressBreadcrumb: true,
              throwIfMissing: true,
            }),
        ]) {
          await expect(load()).rejects.toThrow(/cursor/i);
          expect(await NodeFileSystem.readFile(file, "utf8")).toBe(content);
        }
      }
    });
  });

  it("repairs truncated legacy frames before projecting metadata context without rewriting", async () => {
    const file = join(root, "legacy-archive.jsonl");
    const timestamp = "2026-09-18T00:00:00.000Z";
    const content = [
      { type: "session", version: 2, id: "legacy-session", timestamp, cwd: root },
      {
        type: "message",
        id: "legacy-note",
        parentId: null,
        timestamp,
        message: {
          role: "hookMessage",
          customType: "legacy-note",
          content: "Legacy note",
          display: true,
          timestamp: 1,
        },
      },
      {
        type: "compaction",
        id: "compacted",
        parentId: "legacy-note",
        timestamp,
        summary: "Recovered archive",
        firstKeptEntryId: "kept",
        tokensBefore: 100,
        preserveData: {
          snapcompact: {
            text: "Archived source text",
            frames: [
              {
                data: "invalid\n\n[Session persistence truncated large content]",
                mimeType: "image/png",
                cols: 1,
                rows: 1,
                chars: 20,
              },
            ],
          },
        },
      },
      {
        type: "message",
        id: "kept",
        parentId: "compacted",
        timestamp,
        message: userMessage("Kept prompt"),
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await NodeFileSystem.writeFile(file, content);
    const history = await native.loadSessionHistoryReadOnly(file);
    expect(history.entries[0]).toMatchObject({
      message: { role: "custom", content: "Legacy note" },
    });
    expect(history.entries[1]).toMatchObject({
      preserveData: {
        snapcompact: {
          frames: [],
          text: "Archived source text",
          textHead: "Archived source text",
          textTail: "",
        },
      },
    });
    const context = native.buildSessionContext(history.entries, history.activeLeafId);
    expect(JSON.stringify(context.messages)).toContain("Archived source text");
    expect(JSON.stringify(context.messages)).not.toContain("Session persistence truncated");
    expect(await NodeFileSystem.readFile(file, "utf8")).toBe(content);
  });

  it.each(["buffered", "streamed"] as const)(
    "keeps %s history images externalized across search, preview, and cold model reads",
    async (mode) => {
      const cwd = await NodeFileSystem.mkdtemp(join(root, "metadata-"));
      const file = join(cwd, "history.jsonl");
      const blobs = new native.BlobStore(join(root, "agent", "blobs"));
      const payloads = [Buffer.alloc(2048, 1), Buffer.alloc(3072, 2), Buffer.alloc(4096, 3)];
      const stored = await Promise.all(payloads.map((data) => blobs.put(data)));
      const image = (index: number) => {
        const blob = stored[index];
        if (blob === undefined) throw new Error(`Missing fixture image ${index}`);
        return { type: "image", mimeType: "image/png", data: blob.ref };
      };
      const visibleText = `  Full selected prompt\n${"visible text ".repeat(100)}needle-at-tail`;
      const timestamp = "2026-09-18T00:00:00.000Z";
      const records = [
        { type: "session", version: 3, id: "metadata-session", cwd, timestamp },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp,
          model: "openai/gpt-4.1",
          role: "default",
        },
        { type: "message", id: "root", parentId: "model", timestamp, message: userMessage("Root") },
        {
          type: "message",
          id: "selected",
          parentId: "root",
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: visibleText }, image(0), image(1)],
            timestamp: 2,
          },
        },
        {
          type: "message",
          id: "side",
          parentId: "root",
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "Off-branch image" }, image(2)],
            timestamp: 3,
          },
        },
        {
          type: "message",
          id: "missing",
          parentId: "side",
          timestamp,
          message: {
            role: "user",
            content: [
              { type: "image", mimeType: "image/png", data: `blob:sha256:${"f".repeat(64)}` },
            ],
            timestamp: 4,
          },
        },
        ...(mode === "streamed"
          ? [
              {
                type: "custom",
                id: "padding",
                parentId: "side",
                timestamp,
                customType: "padding",
                data: "x".repeat(8 * 1024 * 1024),
              },
            ]
          : []),
        { type: "session_cursor", leafId: "selected", revision: "metadata-revision" },
      ];
      const original = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
      await NodeFileSystem.writeFile(file, original);
      const auth = await native.AuthStorage.create(join(cwd, "auth.db"));
      auth.setRuntimeApiKey("openai", "local-history-test");
      const registry = new native.ModelRegistry(auth, join(cwd, "models.yml"), {
        settings: native.Settings.isolated({}),
        ignoreLocalModelConfig: true,
      });
      const blobFiles = await NodeFileSystem.readdir(blobs.dir);
      const get = vi.spyOn(native.BlobStore.prototype, "get");
      const getSync = vi.spyOn(native.BlobStore.prototype, "getSync");
      try {
        let version: string | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          const history = await native.loadSessionHistoryReadOnly(file);
          expect(history).toMatchObject({
            sessionId: "metadata-session",
            activeLeafId: "selected",
            revision: "metadata-revision",
          });
          if (version !== undefined) expect(history.version).toBe(version);
          version = history.version;
          const selected = history.entries.find((entry) => entry.id === "selected");
          expect(selected).toMatchObject({
            message: { content: [{ type: "text", text: visibleText }, image(0), image(1)] },
          });
          expect(history.entries.find((entry) => entry.id === "side")).toMatchObject({
            message: { content: [{ type: "text", text: "Off-branch image" }, image(2)] },
          });
          expect(native.normalizeHistory(history.entries, "needle-at-tail").matches).toEqual([
            "selected",
          ]);
          expect(native.normalizeHistory(history.entries, "off-branch image").matches).toEqual([
            "side",
          ]);
          const preview = native.projectHistoryPreview(
            await native.loadSessionHistoryReadOnly(file),
            HistoryEntryId.make("selected"),
          );
          expect(preview).toEqual({
            targetId: "selected",
            version,
            destinationLeafId: "root",
            blocks: [
              { label: "User", text: "Root" },
              { label: "User", text: `${visibleText}\n[Image]\n[Image]` },
            ],
          });
          expect(
            await Effect.runPromise(
              native.loadCurrentModel(registry, AbsolutePath.make(cwd), file),
            ),
          ).toMatchObject({ provider: "openai", id: "gpt-4.1" });
        }
        expect(get.mock.calls).toEqual([]);
        expect(getSync.mock.calls).toEqual([]);
        expect(await NodeFileSystem.readFile(file, "utf8")).toBe(original);
        expect(await NodeFileSystem.readdir(blobs.dir)).toEqual(blobFiles);
        for (const [index, blob] of stored.entries()) {
          expect(await NodeFileSystem.readFile(blob.path)).toEqual(payloads[index]);
        }
      } finally {
        get.mockRestore();
        getSync.mockRestore();
        auth.close();
      }
    },
    30_000,
  );
});
