import { describe, it } from "@effect/vitest";
import { assert } from "vitest";
import * as Markdown from "./discord-markdown.ts";

const payload = (source: string, chunks: ReadonlyArray<Markdown.MarkdownChunk>) =>
  chunks.map((chunk) => source.slice(chunk.payloadStart, chunk.payloadEnd)).join("");

const assertChunks = (source: string) => {
  const transformed = Markdown.transformTables(source);
  const chunks = Markdown.split(source);
  assert.strictEqual(payload(transformed, chunks), transformed);
  assert.isTrue(chunks.every((chunk) => chunk.content.length <= Markdown.DISCORD_MESSAGE_LIMIT));
  assert.isTrue(chunks.every((chunk) => chunk.content.length > 0));
  for (let index = 1; index < chunks.length; index++) {
    assert.strictEqual(chunks[index - 1]?.payloadEnd, chunks[index]?.payloadStart);
  }
  return { transformed, chunks };
};

const assertLiteral = (content: string) => {
  const lines = content.split("\n");
  const fence = lines[0] ?? "";
  assert.match(fence, /^(?:`{3,}|~{3,})$/u);
  assert.strictEqual(lines.at(-1), fence);
};

describe("Discord Markdown", () => {
  it("preserves ordered header/value pairs, alignment, escaped pipes, and inline Markdown", () => {
    const source = [
      "before __untouched__  ",
      "",
      "| Name | Detail | Link |",
      "| :--- | :---: | ---: |",
      "| **Ada** | `a\\|b` | [site](https://example.com) |",
      "| | 空 | 😀 |",
      "",
      "after ||untouched||\r\n",
    ].join("\n");

    assert.strictEqual(
      Markdown.transformTables(source),
      [
        "before __untouched__  ",
        "",
        "- **Row 1**",
        "  - **Name:** **Ada**",
        "  - **Detail:** `a|b`",
        "  - **Link:** [site](https://example.com)",
        "- **Row 2**",
        "  - **Name:**",
        "  - **Detail:** 空",
        "  - **Link:** 😀",
        "",
        "after ||untouched||\r\n",
      ].join("\n"),
    );
  });

  it("keeps row boundaries and labels every value by its header", () => {
    assert.strictEqual(
      Markdown.transformTables("| A | B |\n| --- | --- |\n| x | y |\n| z | w |"),
      [
        "- **Row 1**",
        "  - **A:** x",
        "  - **B:** y",
        "- **Row 2**",
        "  - **A:** z",
        "  - **B:** w",
      ].join("\n"),
    );
    assert.strictEqual(
      Markdown.transformTables("| A | B |\n| --- | --- |"),
      "- **Columns**\n  - **Column 1:** A\n  - **Column 2:** B",
    );
  });

  it("retains blank, missing, and extra cells in uneven rows", () => {
    assert.strictEqual(
      Markdown.transformTables(
        "| | H |\n| --- | --- |\n| | |\n| title |\n| value | detail | extra |",
      ),
      [
        "- **Row 1**",
        "  - **Column 1:**",
        "  - **H:**",
        "- **Row 2**",
        "  - **Column 1:** title",
        "  - **H:**",
        "- **Row 3**",
        "  - **Column 1:** value",
        "  - **H:** detail",
        "  - **Column 3:** extra",
      ].join("\n"),
    );

    assert.strictEqual(
      Markdown.transformTables("| A | | A |\n| --- | --- | --- |"),
      "- **Columns**\n  - **Column 1:** A\n  - **Column 2:**\n  - **Column 3:** A",
    );
  });

  it("copies every non-table byte exactly across multiple replacements", () => {
    const source =
      "x\r\n\r\n| A |\r\n| --- |\r\n| one |\r\n\r\n__gap__  \n\n| B |\n| --- |\n| two |\n\nsuffix";
    const transformed = Markdown.transformTables(source);
    assert.isTrue(transformed.startsWith("x\r\n\r\n"));
    assert.include(transformed, "\r\n\r\n__gap__  \n\n");
    assert.isTrue(transformed.endsWith("\n\nsuffix"));
    assert.strictEqual(Markdown.transformTables("raw __text__\r\n  "), "raw __text__\r\n  ");
  });

  it("reconstructs the transformed payload exactly", () => {
    assertChunks(`prefix\n\n| A | B |\n| --- | --- |\n| ${"x".repeat(2_001)} | y |\n\nsuffix`);
  });

  it("balances nested raw delimiters and spoilers without normalizing underline", () => {
    const source = `__underline **bold *italic ||spoiler ~~${"x".repeat(2_100)}~~||***__`;
    const { chunks } = assertChunks(source);
    assert.isAbove(chunks.length, 1);
    assert.isTrue(chunks.every((chunk) => chunk.content.startsWith("__")));
    assert.isTrue(chunks.every((chunk) => chunk.content.endsWith("__")));
    assert.isTrue(chunks.every((chunk) => chunk.content.includes("||")));
  });

  it("keeps variable code spans, fences, links, and raw line prefixes self-contained", () => {
    const fixtures = [
      `\`\`code ${"x".repeat(2_050)} with \` inside\`\``,
      `~~~ts\n${"x".repeat(2_050)}\n~~~`,
      `[**linked ${"x".repeat(2_050)}**](https://example.com/a_(b))`,
      `> quoted ${"x".repeat(2_050)}`,
      `- listed ${"x".repeat(2_050)}`,
      `>>> quoted ${"x".repeat(2_050)}`,
      `-# quiet ${"x".repeat(2_050)}`,
      `\`\`\`js\nconst marker = "||not a spoiler||";\n${"x".repeat(2_050)}\n\`\`\``,
    ];

    for (const source of fixtures) assertChunks(source);
  });

  it("closes an unclosed fence without splitting short content", () => {
    const source = "```ts\nconst x = 1";
    const chunks = Markdown.split(source);
    const compact = Markdown.truncate(source, Markdown.THINKING_LIMIT);

    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(payload(source, chunks), source);
    assert.match(chunks[0]?.content ?? "", /\n```$/u);
    assert.match(compact ?? "", /\n```$/u);
  });

  it("distinguishes valid, mismatched, indented, and container fences", () => {
    assert.deepStrictEqual(
      Markdown.split("```js\nvalue\n  ```").map((chunk) => chunk.content),
      ["```js\nvalue\n  ```"],
    );
    assert.deepStrictEqual(
      Markdown.split("> ```js\n> value\n> ```").map((chunk) => chunk.content),
      ["> ```js\n> value\n> ```"],
    );
    assert.match(Markdown.split("```js\nvalue\n~~~")[0]?.content ?? "", /\n```$/u);
    assert.match(Markdown.split("```js\nvalue\n> ```")[0]?.content ?? "", /\n```$/u);
  });

  it("ignores Discord line markers inside fenced code", () => {
    const marker = "```txt\n>>> literal\n```\n\n";
    const afterCode = assertChunks(`${marker}${"x".repeat(2_100)}`).chunks;
    for (const chunk of afterCode) {
      if (chunk.payloadStart >= marker.length) assert.notMatch(chunk.content, /^>>> /u);
    }

    const codeChunks = assertChunks(`\`\`\`txt\n> ${"x".repeat(2_100)}\n\`\`\``).chunks;
    assert.isTrue(codeChunks.every((chunk) => !chunk.content.startsWith("> ```")));
  });

  it("does not cut Markdown escapes or character references", () => {
    const escaped = assertChunks(`${"a".repeat(1_999)}\\*x*`).chunks;
    assert.isTrue(escaped.every((chunk) => !chunk.content.endsWith("\\")));

    const entity = assertChunks(`${"a".repeat(1_997)}&amp;tail`).chunks;
    assert.isTrue(entity.every((chunk) => !/&(?:a|am|amp)$/u.test(chunk.content)));
  });

  it("uses balanced literal chunks for an oversized wrapper", () => {
    const source = `[x](https://example.com/${"a".repeat(2_100)})`;
    const chunks = assertChunks(source).chunks;
    const compact = Markdown.truncate(source, Markdown.TOOL_MESSAGE_LIMIT) ?? "";

    assert.isAbove(chunks.length, 1);
    for (const chunk of chunks) assertLiteral(chunk.content);
    assertLiteral(compact);
  });

  it("uses literal fallback when truncation reaches wrapper syntax", () => {
    const source = `\`\`\`${"typescript".repeat(100)}\nvalue\n\`\`\``;
    const compact = Markdown.truncate(source, Markdown.TOOL_MESSAGE_LIMIT) ?? "";
    assertLiteral(compact);
  });

  it("closes a bare opening fence", () => {
    assert.deepStrictEqual(
      Markdown.split("```").map((chunk) => chunk.content),
      ["```\n```"],
    );
    assert.strictEqual(Markdown.truncate("~~~", Markdown.TOOL_MESSAGE_LIMIT), "~~~\n~~~");
  });

  it("honors 1999, 2000, and 2001 UTF-16 boundaries", () => {
    assert.deepStrictEqual(
      Markdown.split("a".repeat(1_999)).map((chunk) => chunk.content),
      ["a".repeat(1_999)],
    );
    assert.deepStrictEqual(
      Markdown.split("a".repeat(2_000)).map((chunk) => chunk.content),
      ["a".repeat(2_000)],
    );
    const chunks = Markdown.split("a".repeat(2_001));
    assert.strictEqual(chunks.length, 2);
    assertChunks("a".repeat(2_001));
  });

  it("never cuts surrogate pairs or combining graphemes", () => {
    const source = `${"a".repeat(1_999)}😀e\u0301${"b".repeat(30)}`;
    const { transformed, chunks } = assertChunks(source);
    for (const chunk of chunks) {
      const part = transformed.slice(chunk.payloadStart, chunk.payloadEnd);
      assert.notMatch(part, /^[\u0300-\u036f]/u);
      assert.notMatch(part, /[\uD800-\uDBFF]$/u);
      assert.notMatch(part, /^[\uDC00-\uDFFF]/u);
    }
  });

  it("preserves malformed markup as literal source", () => {
    const source = `unclosed **bold [link]( and ||spoiler ${"x".repeat(2_100)}`;
    assertChunks(source);
  });

  it("truncates complete Markdown output within Unicode code-point caps", () => {
    const emphasis = Markdown.truncate(`🧠 **${"😀".repeat(900)}**`, Markdown.THINKING_LIMIT);
    const spoiler = Markdown.truncate(
      `⚙️ Working ||${"x".repeat(600)}||`,
      Markdown.TOOL_MESSAGE_LIMIT,
    );

    assert.isDefined(emphasis);
    assert.isDefined(spoiler);
    const emphasisText = emphasis ?? "";
    const spoilerText = spoiler ?? "";
    assert.isAtMost(Array.from(emphasisText).length, Markdown.THINKING_LIMIT);
    assert.isAtMost(Array.from(spoilerText).length, Markdown.TOOL_MESSAGE_LIMIT);
    assert.match(emphasisText, /…\*\*$/u);
    assert.match(spoilerText, /…\|\|$/u);
  });
});
