import { assert, describe, it } from "@effect/vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import {
  Markdown,
  MarkdownLabel,
  mermaidFenceFromPre,
  remarkFormulaMetadata,
} from "./markdown.tsx";

function parseFence(markdown: string) {
  let captured: ReturnType<typeof mermaidFenceFromPre>;
  const components: Components = {
    pre({ node }) {
      captured = mermaidFenceFromPre(node);
      return createElement("pre");
    },
  };

  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        components,
        remarkPlugins: [remarkFormulaMetadata, remarkGfm, remarkBreaks],
      },
      markdown,
    ),
  );

  return captured;
}

function renderMarkdown(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text }));
}

function renderMarkdownLabel(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownLabel, { text }));
}

describe("mermaid fence parsing", () => {
  it("marks an explicitly closed mermaid fence and preserves parser whitespace", () => {
    const fence = parseFence("```mermaid\ngraph LR\n  A --> B  \n\n```\n");

    assert.deepStrictEqual(fence, {
      kind: "closed",
      source: "graph LR\n  A --> B  \n",
    });
  });

  it("keeps an unterminated mermaid fence in waiting state", () => {
    const fence = parseFence("```mermaid\ngraph LR\nA --> B\n");

    assert.deepStrictEqual(fence, { kind: "open", source: "graph LR\nA --> B" });
  });

  it("withdraws preview metadata when a closer line has trailing text", () => {
    const fence = parseFence("```mermaid\ngraph LR\n``` trailing\n");

    assert.deepStrictEqual(fence, {
      kind: "open",
      source: "graph LR\n``` trailing",
    });
  });

  it("accepts tilde fences with explicit closure", () => {
    const fence = parseFence("~~~mermaid\nflowchart LR\nA --> B\n~~~\n");

    assert.deepStrictEqual(fence, {
      kind: "closed",
      source: "flowchart LR\nA --> B",
    });
  });

  it("uses container and delimiter semantics rather than scanning closing-looking lines", () => {
    assert.deepStrictEqual(
      parseFence("> ````mermaid\r\n> graph LR\r\n> A --> B\r\n> ```\r\n> `````"),
      {
        kind: "closed",
        source: "graph LR\r\nA --> B\r\n```",
      },
    );
    assert.deepStrictEqual(parseFence("- ~~~mermaid\n  graph LR\n  A --> B\n  ~~~"), {
      kind: "closed",
      source: "graph LR\nA --> B",
    });
  });
});

describe("formula rendering", () => {
  it("typesets explicitly closed math fences inside a focusable scroll region", () => {
    const markup = renderMarkdown("```math\n\\frac{a}{b}\n```\n");

    assert.match(markup, /class="chat-math-block"/u);
    assert.match(markup, /class="katex-display"/u);
    assert.match(markup, /role="region" tabindex="0"/u);
    assert.notMatch(markup, /chat-code-block/u);
  });

  it("keeps unterminated math fences as literal source text", () => {
    const markup = renderMarkdown("```math\n\\frac{a}{b}\n");

    assert.ok(markup.includes("```math"));
    assert.notMatch(markup, /katex-display/u);
  });

  it("treats fake closer lines as source instead of completing the fence", () => {
    const markup = renderMarkdown("```math\n\\frac{a}{b}\n``` trailing\n");

    assert.ok(markup.includes("``` trailing"));
    assert.notMatch(markup, /katex-display/u);
  });

  it("preserves tex fences as regular code blocks", () => {
    const markup = renderMarkdown("```tex\n\\frac{a}{b}\n```\n");

    assert.match(markup, /chat-code-block/u);
    assert.notMatch(markup, /katex-display/u);
  });

  it("keeps display math as source until the parser accepts its closing delimiter", () => {
    const partial = "$$\n\\frac{1}{2}";
    const open = renderMarkdown(partial);
    assert.ok(open.includes(partial));
    assert.notMatch(open, /class="katex/u);
    assert.match(renderMarkdown(`${partial}\n$$`), /class="katex-display"/u);
    assert.notMatch(renderMarkdown(`${partial}\n$$ trailing`), /class="katex/u);
  });

  it("follows math delimiter lengths and container boundaries", () => {
    assert.notMatch(renderMarkdown("$$$\r\nx\r\n$$"), /class="katex/u);
    assert.match(renderMarkdown("> $$$\r\n> x\r\n> $$$$"), /class="katex-display"/u);
    assert.notMatch(renderMarkdown("> $$\n> x\n\nAfter"), /class="katex/u);
  });

  it("preserves inline formula source in MarkdownLabel", () => {
    const markup = renderMarkdownLabel("Set $\\{x\\}$ and matrix $a \\\\ b$ now.");

    assert.ok(markup.includes("$\\{x\\}$ and matrix $a \\\\ b$"));
    assert.notMatch(markup, /katex|math-inline|math-display/u);
  });
});
