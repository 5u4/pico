import type { HistoryNode, HistorySnapshot } from "@pico/contract/agent-history";
import type { HistoryItemPresentation } from "./chat/chat-model.ts";

const historyTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function presentHistoryItems(
  history: Pick<HistorySnapshot, "nodes" | "matches" | "activeLeafId"> | null,
  options: { readonly revealAll: boolean; readonly previewTargetId: string | null },
): readonly HistoryItemPresentation[] {
  if (history === null) return [];
  const nodes = new Map(history.nodes.map((node) => [node.entryId, node]));
  const matches = new Set(history.matches);
  const children = new Map<HistoryNode["parentId"], HistoryNode[]>();
  for (const node of history.nodes) {
    const parent = node.parentId !== null && nodes.has(node.parentId) ? node.parentId : null;
    const siblings = children.get(parent);
    if (siblings) siblings.push(node);
    else children.set(parent, [node]);
  }
  const pending = (children.get(null) ?? []).map((node) => ({ node, depth: 0 })).reverse();
  const items: HistoryItemPresentation[] = [];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { node, depth } = next;
    const descendants = children.get(node.entryId) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) {
      const child = descendants[index];
      if (child) pending.push({ node: child, depth: depth + (descendants.length > 1 ? 1 : 0) });
    }
    const matched = matches.has(node.entryId);
    const visibleByDefault = node.visibleByDefault && node.kind !== "tool";
    const targetId = options.revealAll || !visibleByDefault ? node.entryId : node.defaultTargetId;
    const active = history.activeLeafId === targetId || history.activeLeafId === node.entryId;
    const preview = options.previewTargetId === targetId;
    if (
      !options.revealAll &&
      !visibleByDefault &&
      !matched &&
      (node.kind === "tool" || (!active && !preview))
    )
      continue;
    const kindLabel =
      node.kind === "user"
        ? "User"
        : node.kind === "assistant"
          ? "Assistant"
          : node.kind === "tool"
            ? "Tool"
            : node.kind === "summary"
              ? "Summary"
              : "Metadata";
    const timestamp = Date.parse(node.timestamp);
    items.push({
      id: node.entryId,
      targetId,
      depth,
      kindLabel,
      timestampLabel: Number.isNaN(timestamp)
        ? node.timestamp
        : historyTimeFormat.format(timestamp),
      label: node.label?.trim() || `${kindLabel} entry`,
      excerpt: node.excerpt,
      matched,
      visibleByDefault,
      active,
      preview,
    });
  }
  return items;
}
