import { assert, describe, it } from "@effect/vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { mermaidFenceFromPre, remarkMermaidFenceMetadata } from "./markdown.tsx";

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
        remarkPlugins: [remarkMermaidFenceMetadata, remarkGfm, remarkBreaks],
      },
      markdown,
    ),
  );

  return captured;
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
