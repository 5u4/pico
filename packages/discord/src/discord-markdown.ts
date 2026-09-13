import type {
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
  Strong,
  Table,
  TableCell,
  Text,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { spoilerFromMarkdown, spoilerToMarkdown } from "mdast-util-inline-spoiler";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { spoiler } from "micromark-extension-inline-spoiler";

export const DISCORD_MESSAGE_LIMIT = 2_000;
export const THINKING_LIMIT = 800;
export const TOOL_MESSAGE_LIMIT = 500;

export interface MarkdownChunk {
  readonly content: string;
  readonly payloadStart: number;
  readonly payloadEnd: number;
}

interface Range {
  readonly start: number;
  readonly end: number;
}

interface Wrapper extends Range {
  readonly depth: number;
  readonly opener: string;
  readonly closer: string;
  readonly contentStart: number;
  readonly contentEnd: number;
}

interface MarkdownIndex {
  readonly wrappers: ReadonlyArray<Wrapper>;
  readonly leaves: ReadonlyArray<Range>;
  readonly code: ReadonlyArray<Range>;
  readonly boundaries: ReadonlySet<number>;
  readonly graphemes: ReadonlySet<number>;
  readonly unsafeBoundaries: ReadonlySet<number>;
  readonly multilineQuoteStart: number | undefined;
}

interface Replacement extends Range {
  readonly content: string;
}

const parse = (source: string) =>
  fromMarkdown(source, {
    extensions: [gfm(), spoiler()],
    mdastExtensions: [gfmFromMarkdown(), spoilerFromMarkdown()],
  });

const offset = (node: Nodes, edge: "start" | "end") => node.position?.[edge].offset;

const children = (node: Nodes): ReadonlyArray<Nodes> => ("children" in node ? node.children : []);

const text = (value: string): Text => ({ type: "text", value });

const nonEmpty = (cell: TableCell) => plainText(cell.children).trim().length > 0;

const plainText = (nodes: ReadonlyArray<Nodes>): string => {
  let value = "";
  for (const node of nodes) {
    if ("value" in node && typeof node.value === "string") value += node.value;
    value += plainText(children(node));
  }
  return value;
};

const strong = (content: ReadonlyArray<PhrasingContent>): Strong => ({
  type: "strong",
  children: [...content],
});

const paragraph = (content: ReadonlyArray<PhrasingContent>): Paragraph => ({
  type: "paragraph",
  children: [...content],
});

const field = (
  header: TableCell | undefined,
  cell: TableCell | undefined,
  column: number,
): ListItem => {
  const label =
    header !== undefined && nonEmpty(header) ? header.children : [text(`Column ${column}`)];
  const value = cell?.children ?? [];
  const content: PhrasingContent[] = [strong([...label, text(":")])];
  if (value.length > 0) content.push(text(" "), ...value);
  return {
    type: "listItem",
    children: [paragraph(content)],
  };
};

const rowItems = (
  headers: ReadonlyArray<TableCell>,
  cells: ReadonlyArray<TableCell>,
): ListItem[] => {
  const fields: ListItem[] = [];
  for (let index = 1; index < cells.length; index++) {
    const cell = cells[index];
    if (cell === undefined || cell.children.length === 0) continue;

    const header = headers[index];
    const content: PhrasingContent[] = [];
    if (header !== undefined && nonEmpty(header)) content.push(...header.children, text(": "));
    content.push(...cell.children);
    fields.push({ type: "listItem", children: [paragraph(content)] });
  }

  const title = cells[0];
  if (title === undefined || title.children.length === 0) return fields;

  const item: ListItem = {
    type: "listItem",
    spread: false,
    children: [paragraph([strong(title.children)])],
  };
  if (fields.length > 0) {
    const nested: List = { type: "list", ordered: false, spread: false, children: fields };
    item.children.push(nested);
  }
  return [item];
};

const tableList = (table: Table): Root => {
  const [headerRow, ...bodyRows] = table.children;
  const headers = headerRow?.children ?? [];
  const items = bodyRows.flatMap((row) => rowItems(headers, row.children));

  if (bodyRows.length === 0) {
    const fields = headers.map((header, index) => field(undefined, header, index + 1));
    const columns: ListItem = {
      type: "listItem",
      spread: false,
      children: [paragraph([strong([text("Columns")])])],
    };
    if (fields.length > 0) {
      columns.children.push({ type: "list", ordered: false, spread: false, children: fields });
    }
    items.push(columns);
  }

  return {
    type: "root",
    children:
      items.length > 0 ? [{ type: "list", ordered: false, spread: false, children: items }] : [],
  };
};

const continuationPrefix = (source: string, start: number) => {
  const lineStart = Math.max(source.lastIndexOf("\n", start - 1) + 1, 0);
  const prefix = source.slice(lineStart, start);
  return /^(?:[\t ]*(?:> ?|>>> ?))*[\t ]*$/u.test(prefix) ? prefix : "";
};

const collectTables = (source: string, node: Nodes, replacements: Replacement[]) => {
  if (node.type === "table") {
    const start = offset(node, "start");
    const end = offset(node, "end");
    if (start === undefined || end === undefined) throw new Error("GFM table is missing offsets");
    const prefix = continuationPrefix(source, start);
    const serialized = toMarkdown(tableList(node), {
      bullet: "-",
      extensions: [gfmToMarkdown(), spoilerToMarkdown()],
    }).replace(/\n$/u, "");
    replacements.push({
      start,
      end,
      content: prefix.length === 0 ? serialized : serialized.replaceAll("\n", `\n${prefix}`),
    });
    return;
  }
  for (const child of children(node)) collectTables(source, child, replacements);
};

export const transformTables = (source: string): string => {
  if (source.length === 0) return source;
  const replacements: Replacement[] = [];
  collectTables(source, parse(source), replacements);
  if (replacements.length === 0) return source;

  let transformed = source;
  replacements.sort((left, right) => right.start - left.start);
  for (const replacement of replacements) {
    transformed = `${transformed.slice(0, replacement.start)}${replacement.content}${transformed.slice(replacement.end)}`;
  }
  return transformed;
};

const delimiterWrapper = (source: string, node: Nodes, depth: number): Wrapper | undefined => {
  const start = offset(node, "start");
  const end = offset(node, "end");
  const nested = children(node);
  const first = nested[0];
  const last = nested[nested.length - 1];
  const innerStart = first === undefined ? undefined : offset(first, "start");
  const innerEnd = last === undefined ? undefined : offset(last, "end");
  if (
    start === undefined ||
    end === undefined ||
    innerStart === undefined ||
    innerEnd === undefined ||
    innerStart <= start ||
    innerEnd >= end
  ) {
    return undefined;
  }
  const opener = source.slice(start, innerStart);
  const closer = source.slice(innerEnd, end);
  return opener.length === 0 || closer.length === 0
    ? undefined
    : { start, end, contentStart: innerStart, contentEnd: innerEnd, depth, opener, closer };
};

const quoteDepthAt = (source: string, position: number) => {
  const lineStart = Math.max(source.lastIndexOf("\n", position - 1) + 1, 0);
  return Array.from(source.slice(lineStart, position)).filter((character) => character === ">")
    .length;
};

const fencedCode = (raw: string, quoteDepth: number) => {
  const opening = raw.match(/^(([\t ]{0,3})(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$))/u);
  if (opening === null) return undefined;
  const opener = opening[1];
  const fence = opening[3];
  if (opener === undefined || fence === undefined) return undefined;

  const closingStart = raw.lastIndexOf("\n");
  const closingLine = raw.slice(closingStart + 1);
  const closingMatch = closingLine.match(/^((?:[\t ]{0,3}> ?)*)[\t ]{0,3}(`{3,}|~{3,})[\t ]*$/u);
  const closingFence = closingMatch?.[2];
  const closingDepth = Array.from(closingMatch?.[1] ?? "").filter(
    (character) => character === ">",
  ).length;
  const closing =
    closingStart >= 0 &&
    closingFence !== undefined &&
    closingDepth === quoteDepth &&
    closingFence[0] === fence[0] &&
    closingFence.length >= fence.length
      ? raw.slice(closingStart)
      : undefined;
  return { opener, fence, closing };
};

const codeWrapper = (source: string, node: Nodes, depth: number): Wrapper | undefined => {
  const start = offset(node, "start");
  const end = offset(node, "end");
  if (start === undefined || end === undefined) return undefined;
  const raw = source.slice(start, end);

  if (node.type === "inlineCode") {
    const opening = raw.match(/^(`+)/u)?.[1];
    const closing = raw.match(/(`+)$/u)?.[1];
    if (opening === undefined || closing === undefined) return undefined;
    return {
      start,
      end,
      contentStart: start + opening.length,
      contentEnd: end - closing.length,
      depth,
      opener: opening,
      closer: closing,
    };
  }

  const fenced = fencedCode(raw, quoteDepthAt(source, start));
  if (fenced === undefined) return undefined;
  return {
    start,
    end: fenced.closing === undefined ? end + 1 : end,
    contentStart: start + fenced.opener.length,
    contentEnd: fenced.closing === undefined ? end : end - fenced.closing.length,
    depth,
    opener: fenced.opener,
    closer: `\n${fenced.fence}`,
  };
};

const splittableCodeRange = (source: string, node: Nodes): Range | undefined => {
  const start = offset(node, "start");
  const end = offset(node, "end");
  if (start === undefined || end === undefined) return undefined;
  const raw = source.slice(start, end);
  if (node.type === "inlineCode") {
    const opening = raw.match(/^(`+)/u)?.[1];
    const closing = raw.match(/(`+)$/u)?.[1];
    if (opening === undefined || closing === undefined) return undefined;
    return { start: start + opening.length, end: end - closing.length };
  }
  const fenced = fencedCode(raw, quoteDepthAt(source, start));
  if (fenced === undefined) return undefined;
  return {
    start: start + fenced.opener.length,
    end: fenced.closing === undefined ? end : end - fenced.closing.length,
  };
};

const inside = (ranges: ReadonlyArray<Range>, position: number) =>
  ranges.some((range) => range.start < position && position < range.end);

const buildIndex = (source: string, root: Root): MarkdownIndex => {
  const wrappers: Wrapper[] = [];
  const leaves: Range[] = [];
  const code: Range[] = [];
  const boundaries = new Set<number>([0, source.length]);

  const visit = (node: Nodes, depth: number) => {
    const start = offset(node, "start");
    const end = offset(node, "end");
    if (start !== undefined) boundaries.add(start);
    if (end !== undefined) boundaries.add(end);

    if (
      node.type === "emphasis" ||
      node.type === "strong" ||
      node.type === "delete" ||
      node.type === "spoiler" ||
      node.type === "link" ||
      node.type === "linkReference"
    ) {
      const wrapper = delimiterWrapper(source, node, depth);
      if (wrapper !== undefined) wrappers.push(wrapper);
    } else if (node.type === "inlineCode" || node.type === "code") {
      const wrapper = codeWrapper(source, node, depth);
      const range = splittableCodeRange(source, node);
      if (start !== undefined && end !== undefined) code.push({ start, end });
      if (wrapper !== undefined) wrappers.push(wrapper);
      if (range !== undefined && range.end > range.start) leaves.push(range);
    } else if (node.type === "text" && start !== undefined && end !== undefined) {
      leaves.push({ start, end });
    }

    for (const child of children(node)) visit(child, depth + 1);
  };
  visit(root, 0);

  const graphemes = new Set<number>([0, source.length]);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const segment of segmenter.segment(source)) {
    graphemes.add(segment.index);
    graphemes.add(segment.index + segment.segment.length);
  }
  const unsafeBoundaries = new Set<number>();
  for (let index = 0; index + 1 < source.length; index++) {
    if (source.charCodeAt(index) === 92) {
      unsafeBoundaries.add(index + 1);
      index++;
    }
  }
  for (const match of source.matchAll(/&(?:#[xX][\dA-Fa-f]+|#\d+|[A-Za-z][\dA-Za-z]+);/gu)) {
    for (let index = match.index + 1; index < match.index + match[0].length; index++) {
      unsafeBoundaries.add(index);
    }
  }

  let multilineQuoteStart: number | undefined;
  for (const match of source.matchAll(/(?:^|\n)>>> ?/gu)) {
    const position = match.index + (match[0].startsWith("\n") ? 1 : 0);
    if (!inside(code, position)) {
      multilineQuoteStart = position;
      break;
    }
  }
  return {
    wrappers,
    leaves,
    code,
    boundaries,
    graphemes,
    unsafeBoundaries,
    multilineQuoteStart,
  };
};

const activePrefix = (wrappers: ReadonlyArray<Wrapper>, position: number) =>
  wrappers.filter((wrapper) => wrapper.start < position && position < wrapper.contentEnd);

const activeSuffix = (wrappers: ReadonlyArray<Wrapper>, position: number) =>
  wrappers.filter((wrapper) => wrapper.contentStart <= position && position < wrapper.end);

const discordLinePrefix = (source: string, index: MarkdownIndex, position: number) => {
  if (inside(index.code, position)) return "";
  if (position === 0) return "";
  if (source.charCodeAt(position - 1) === 10) {
    return index.multilineQuoteStart !== undefined && position > index.multilineQuoteStart
      ? ">>> "
      : "";
  }
  const lineStart = Math.max(source.lastIndexOf("\n", position - 1) + 1, 0);
  const before = source.slice(lineStart, position);
  const prefix = before.match(
    /^(?:(?:[\t ]{0,3}> ?)|(?:>>> ?)|(?:-# ?)|(?:[\t ]{0,3}(?:[-+*]|\d+[.)])[\t ]+)|(?:[\t ]+))+/u,
  )?.[0];
  if (prefix !== undefined && /(?:>|-#|[-+*]|\d+[.)])/u.test(prefix)) return prefix;

  return index.multilineQuoteStart !== undefined && position > index.multilineQuoteStart
    ? ">>> "
    : "";
};

const wrappersFor = (source: string, index: MarkdownIndex, start: number, end: number) => {
  const atStart = activePrefix(index.wrappers, start).sort(
    (left, right) => left.depth - right.depth,
  );
  const atEnd = activeSuffix(index.wrappers, end).sort((left, right) => right.depth - left.depth);
  return {
    prefix: `${discordLinePrefix(source, index, start)}${atStart.map((wrapper) => wrapper.opener).join("")}`,
    suffix: atEnd.map((wrapper) => wrapper.closer).join(""),
  };
};

const safeBoundary = (index: MarkdownIndex, position: number) => {
  if (!index.graphemes.has(position) || index.unsafeBoundaries.has(position)) return false;
  if (index.boundaries.has(position)) return true;
  return index.leaves.some((leaf) => leaf.start <= position && position <= leaf.end);
};

const renderSlice = (
  source: string,
  index: MarkdownIndex,
  start: number,
  end: number,
  limit: number,
): string | undefined => {
  const { prefix, suffix } = wrappersFor(source, index, start, end);
  const content = `${prefix}${source.slice(start, end)}${suffix}`;
  return content.length <= limit ? content : undefined;
};

const chooseEnd = (
  source: string,
  index: MarkdownIndex,
  start: number,
  limit: number,
): { readonly end: number; readonly content: string } | undefined => {
  const ceiling = Math.min(start + limit, source.length);
  if (ceiling === source.length && safeBoundary(index, ceiling)) {
    const content = renderSlice(source, index, start, ceiling, limit);
    if (content !== undefined) return { end: ceiling, content };
  }

  let furthest: { readonly end: number; readonly content: string } | undefined;
  let whitespace: { readonly end: number; readonly content: string } | undefined;
  let preferredFloor = start + 1;

  for (let end = ceiling; end > start; end--) {
    if (furthest !== undefined && end < preferredFloor) break;
    if (!safeBoundary(index, end)) continue;
    const content = renderSlice(source, index, start, end, limit);
    if (content === undefined) continue;
    const candidate = { end, content };
    if (furthest === undefined) {
      furthest = candidate;
      preferredFloor = Math.max(start + 1, end - 300);
    }
    const previous = source.charCodeAt(end - 1);
    if (previous === 10 || previous === 13) return candidate;
    if (whitespace === undefined && /\s/u.test(source.at(end - 1) ?? "")) whitespace = candidate;
  }
  return whitespace ?? furthest;
};
const literalEnd = (source: string, index: MarkdownIndex, start: number, limit: number) => {
  let end = Math.min(start + limit, source.length);
  while (end > start && !index.graphemes.has(end)) end--;
  if (end === start) {
    end = Math.min(start + limit, source.length);
    if (
      end < source.length &&
      end > start &&
      source.charCodeAt(end - 1) >= 0xd800 &&
      source.charCodeAt(end - 1) <= 0xdbff &&
      source.charCodeAt(end) >= 0xdc00 &&
      source.charCodeAt(end) <= 0xdfff
    ) {
      end--;
    }
  }
  return end;
};

const longestRun = (source: string, marker: "`" | "~") => {
  let longest = 0;
  let current = 0;
  for (const character of source) {
    current = character === marker ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
};

const literalFence = (payload: string) => {
  const backticks = "`".repeat(Math.max(3, longestRun(payload, "`") + 1));
  const tildes = "~".repeat(Math.max(3, longestRun(payload, "~") + 1));
  return backticks.length <= tildes.length ? backticks : tildes;
};

const literalContent = (payload: string) => {
  const fence = literalFence(payload);
  return `${fence}\n${payload}\n${fence}`;
};

const literalChunk = (
  source: string,
  index: MarkdownIndex,
  start: number,
  limit: number,
): { readonly end: number; readonly content: string } | undefined => {
  let end = literalEnd(source, index, start, limit);
  while (end > start) {
    const content = literalContent(source.slice(start, end));
    if (content.length <= limit) return { end, content };
    end--;
    while (end > start && !index.graphemes.has(end)) end--;
  }
  return undefined;
};

const truncateLiteral = (source: string, limit: number) => {
  const codePoints = Array.from(source);
  for (let end = Math.min(codePoints.length, limit - 1); end > 0; end--) {
    const content = literalContent(`${codePoints.slice(0, end).join("")}…`);
    if (codePointLength(content) <= limit) return content;
  }
  return limit > 0 ? "…" : undefined;
};

const insideWrapperSyntax = (wrappers: ReadonlyArray<Wrapper>, position: number) =>
  wrappers.some(
    (wrapper) =>
      (wrapper.start < position && position < wrapper.contentStart) ||
      (wrapper.contentEnd < position && position < wrapper.end),
  );

export const split = (
  source: string,
  limit = DISCORD_MESSAGE_LIMIT,
): ReadonlyArray<MarkdownChunk> => {
  if (source.length === 0 || limit < 1) return [];
  const transformed = transformTables(source);
  const index = buildIndex(transformed, parse(transformed));
  const chunks: MarkdownChunk[] = [];
  let start = 0;

  while (start < transformed.length) {
    const rendered = insideWrapperSyntax(index.wrappers, start)
      ? undefined
      : chooseEnd(transformed, index, start, limit);
    if (rendered !== undefined) {
      chunks.push({ content: rendered.content, payloadStart: start, payloadEnd: rendered.end });
      start = rendered.end;
      continue;
    }

    const literal = literalChunk(transformed, index, start, limit);
    if (literal === undefined) throw new Error("Discord message limit cannot contain one grapheme");
    chunks.push({ content: literal.content, payloadStart: start, payloadEnd: literal.end });
    start = literal.end;
  }
  return chunks;
};

const codePointLength = (value: string) => Array.from(value).length;

export const truncate = (source: string, limit: number): string | undefined => {
  const trimmed = source.trim();
  if (trimmed.length === 0 || limit < 1) return undefined;
  const index = buildIndex(trimmed, parse(trimmed));
  const complete = `${trimmed}${wrappersFor(trimmed, index, 0, trimmed.length).suffix}`;
  if (codePointLength(complete) <= limit) return complete;

  const boundaries = Array.from(index.graphemes)
    .filter((value) => value > 0 && safeBoundary(index, value))
    .sort((a, b) => b - a);
  for (const end of boundaries) {
    const { suffix } = wrappersFor(trimmed, index, 0, end);
    const content = `${trimmed.slice(0, end)}…${suffix}`;
    if (codePointLength(content) <= limit) return content;
  }

  return truncateLiteral(trimmed, limit);
};
