import { describe, it } from "@effect/vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { assert } from "vitest";
import * as Btw from "./discord-btw.ts";
import type { MarkdownChunk } from "./discord-markdown.ts";

const bodies = (chunks: ReadonlyArray<MarkdownChunk>, userId: bigint) =>
  chunks.map((chunk, index) => {
    const header = `**/btw · <@${userId}>${index === 0 ? "" : " · 续"}**\n\n`;
    assert.isTrue(chunk.content.startsWith(header));
    assert.isAtMost(chunk.content.length, 2_000);
    return chunk.content.slice(header.length);
  });

const assertPayload = (source: string, chunks: ReadonlyArray<MarkdownChunk>) => {
  assert.strictEqual(chunks[0]?.payloadStart, 0);
  assert.strictEqual(chunks.at(-1)?.payloadEnd, source.length);
  for (let index = 1; index < chunks.length; index++) {
    assert.strictEqual(chunks[index - 1]?.payloadEnd, chunks[index]?.payloadStart);
  }
  assert.strictEqual(
    chunks.map((chunk) => source.slice(chunk.payloadStart, chunk.payloadEnd)).join(""),
    source,
  );
};

describe("Discord /btw formatting", () => {
  it("contains question markup and mentions without changing answer Markdown", () => {
    const lines = [
      ">>> keep this literal",
      "```ts",
      "",
      "**bold** _italics_ ||spoiler|| [link](https://example.com)",
      "\\path <@200> @everyone",
      "```",
    ];
    const answer =
      "**Native answer** with [a link](https://example.com)\n\n```ts\nconst x = 1;\n```";
    const chunks = Btw.format({ userId: 100n, question: lines.join("\r\n"), answer });
    const content = bodies(chunks, 100n).join("");
    assert.strictEqual(chunks.length, 1);
    assert.isTrue(content.endsWith(`\n\n${answer}`));
    assert.notMatch(content.slice(0, -answer.length), /(?<!\\)<@|(?<!\\)@everyone/u);
    const nodes = fromMarkdown(content).children;
    const quote = nodes[0];
    if (quote?.type !== "blockquote") assert.fail("Question must be a blockquote");
    const paragraphs = quote.children.map((paragraph) => {
      if (paragraph.type !== "paragraph") assert.fail("Question must remain literal text");
      return paragraph.children
        .map((text) => {
          if (text.type !== "text") assert.fail("Question Markdown must not become formatting");
          return text.value;
        })
        .join("");
    });
    assert.strictEqual(paragraphs.join("\n\n"), lines.join("\n"));
    assert.strictEqual(nodes[1]?.type, "paragraph");
    assert.strictEqual(nodes[2]?.type, "code");
  });

  it("keeps an oversized escaped question quoted on every continuation", () => {
    const question = "\\".repeat(6_000);
    const answer = "**Done**";
    const source = `> ${"\\\\".repeat(6_000)}\n\n${answer}`;
    const chunks = Btw.format({ userId: 18_446_744_073_709_551_615n, question, answer });
    const content = bodies(chunks, 18_446_744_073_709_551_615n);
    assertPayload(source, chunks);
    assert.isAbove(chunks.length, 1);
    for (const body of content) {
      const nodes = fromMarkdown(body).children;
      assert.strictEqual(nodes[0]?.type, "blockquote");
      assert.isFalse(nodes.some((node) => node.type === "code"));
    }
    assert.isTrue(content.at(-1)?.endsWith(answer));
  });

  it("reserves continuation headers while balancing a long native code answer", () => {
    const question = "What changed?";
    const answer = `\`\`\`ts\n${"x".repeat(6_000)}\u{1f600}${"y".repeat(3_000)}\n\`\`\``;
    const source = `> ${question}\n\n${answer}`;
    const chunks = Btw.format({ userId: 100n, question, answer });
    const content = bodies(chunks, 100n);
    assertPayload(source, chunks);
    assert.isAbove(chunks.length, 1);
    for (const body of content) {
      assert.match(body, /```ts\n/u);
      assert.isTrue(body.endsWith("\n```"));
      assert.strictEqual(fromMarkdown(body).children.at(-1)?.type, "code");
    }
  });
});
