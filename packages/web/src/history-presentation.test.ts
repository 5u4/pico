import { assert, describe, it } from "@effect/vitest";
import { HistoryEntryId, type HistoryNode } from "@pico/contract/agent-history";
import { presentHistoryItems } from "./history-presentation.ts";

const assistantId = HistoryEntryId.make("assistant");
const toolId = HistoryEntryId.make("tool");
const hiddenId = HistoryEntryId.make("hidden-assistant");
const hiddenToolId = HistoryEntryId.make("hidden-tool");
const nodes: readonly HistoryNode[] = [
  {
    entryId: assistantId,
    parentId: null,
    defaultTargetId: toolId,
    kind: "assistant",
    timestamp: "2026-09-18T12:00:00Z",
    label: null,
    excerpt: "Checking the project",
    visibleByDefault: true,
  },
  {
    entryId: toolId,
    parentId: assistantId,
    defaultTargetId: toolId,
    kind: "tool",
    timestamp: "2026-09-18T12:00:01Z",
    label: null,
    excerpt: "Project files",
    visibleByDefault: false,
  },
  {
    entryId: hiddenId,
    parentId: toolId,
    defaultTargetId: hiddenToolId,
    kind: "assistant",
    timestamp: "2026-09-18T12:00:02Z",
    label: null,
    excerpt: "Internal follow-up",
    visibleByDefault: false,
  },
  {
    entryId: hiddenToolId,
    parentId: hiddenId,
    defaultTargetId: hiddenToolId,
    kind: "tool",
    timestamp: "2026-09-18T12:00:03Z",
    label: null,
    excerpt: "Follow-up result",
    visibleByDefault: false,
  },
];

describe("history presentation", () => {
  it("keeps a grouped row's continuation target and selection when search matches it", () => {
    const unfiltered = presentHistoryItems(
      { nodes, activeLeafId: toolId, matches: [] },
      { revealAll: false, previewTargetId: toolId },
    );
    const searched = presentHistoryItems(
      { nodes, activeLeafId: toolId, matches: [assistantId] },
      { revealAll: false, previewTargetId: toolId },
    );

    assert.deepStrictEqual(
      unfiltered.map(({ id, targetId, matched, active, preview }) => ({
        id,
        targetId,
        matched,
        active,
        preview,
      })),
      [{ id: "assistant", targetId: "tool", matched: false, active: true, preview: true }],
    );
    assert.deepStrictEqual(
      searched.map(({ id, targetId, matched, active, preview }) => ({
        id,
        targetId,
        matched,
        active,
        preview,
      })),
      [{ id: "assistant", targetId: "tool", matched: true, active: true, preview: true }],
    );
  });

  it("selects exact native entries when all entries are revealed", () => {
    const items = presentHistoryItems(
      { nodes, activeLeafId: toolId, matches: [assistantId] },
      { revealAll: true, previewTargetId: assistantId },
    );

    assert.deepStrictEqual(
      items.map(({ id, targetId, active, preview }) => ({ id, targetId, active, preview })),
      [
        { id: "assistant", targetId: "assistant", active: false, preview: true },
        { id: "tool", targetId: "tool", active: true, preview: false },
        { id: "hidden-assistant", targetId: "hidden-assistant", active: false, preview: false },
        { id: "hidden-tool", targetId: "hidden-tool", active: false, preview: false },
      ],
    );
  });

  it("reveals hidden search matches without redirecting them to grouped targets", () => {
    const items = presentHistoryItems(
      { nodes, activeLeafId: toolId, matches: [hiddenId, hiddenToolId] },
      { revealAll: false, previewTargetId: hiddenId },
    );

    assert.deepStrictEqual(
      items.map(({ id, targetId, matched, visibleByDefault, preview }) => ({
        id,
        targetId,
        matched,
        visibleByDefault,
        preview,
      })),
      [
        {
          id: "assistant",
          targetId: "tool",
          matched: false,
          visibleByDefault: true,
          preview: false,
        },
        {
          id: "hidden-assistant",
          targetId: "hidden-assistant",
          matched: true,
          visibleByDefault: false,
          preview: true,
        },
        {
          id: "hidden-tool",
          targetId: "hidden-tool",
          matched: true,
          visibleByDefault: false,
          preview: false,
        },
      ],
    );
  });
});
