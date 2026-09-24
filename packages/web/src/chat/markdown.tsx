import { CheckIcon, CodeIcon, CopyIcon } from "@phosphor-icons/react";
import {
  type ComponentProps,
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { MermaidBlock, type MermaidFence } from "./mermaid-block.tsx";

const LinkContext = createContext(false);
const MERMAID_CLOSED_PROPERTY = "data-mermaid-closed-fence";

type FormulaTransformMode = "typeset" | "source";

type MarkdownCompileContext = {
  readonly stack: Array<{ readonly type?: string; readonly [key: string]: unknown }>;
  readonly data: {
    fenceSequenceByNode?: WeakMap<MarkdownNode, number>;
  };
};

type HastElement = NonNullable<ExtraProps["node"]>;
type HastChild = HastElement["children"][number];

type MarkdownNode = {
  readonly type: string;
  readonly lang?: string | null;
  readonly value?: string;
  readonly position?: {
    readonly start?: { readonly offset?: number };
    readonly end?: { readonly offset?: number };
  };
  data?: {
    hProperties?: Record<string, unknown>;
    hName?: string;
    hChildren?: HastChild[];
    closedFence?: boolean;
    [key: string]: unknown;
  };
  children?: MarkdownNode[];
  [key: string]: unknown;
};

type CopyState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "copying" | "copied" | "failed";
      readonly source: string;
    };

const remarkPlugins: ComponentProps<typeof ReactMarkdown>["remarkPlugins"] = [
  remarkGfm,
  remarkBreaks,
  remarkMath,
  [remarkFormulaMetadata, { mode: "typeset" }],
];
const labelRemarkPlugins: ComponentProps<typeof ReactMarkdown>["remarkPlugins"] = [
  remarkGfm,
  remarkBreaks,
  remarkMath,
  [remarkFormulaMetadata, { mode: "source" }],
];
const rehypeKatexTransformer = rehypeKatex({
  errorColor: "var(--raw-danger)",
  maxExpand: 1000,
  maxSize: 20,
  output: "htmlAndMathml",
  trust: false,
});
const rehypeCodeHighlightTransformer = rehypeHighlight({
  detect: false,
  plainText: ["mermaid"],
});
const rehypePlugins = [rehypeKatexPlugin, rehypeCodeHighlightPlugin];

const components = {
  a({ node: _node, children, href, ...props }) {
    if (!href) return <span>{children}</span>;
    return (
      <LinkContext value={true}>
        <a
          {...props}
          href={href}
          referrerPolicy="no-referrer"
          rel="noopener noreferrer"
          target={href.startsWith("#") ? undefined : "_blank"}
        >
          {children}
        </a>
      </LinkContext>
    );
  },
  img: MarkdownImage,
  input({ checked }) {
    return (
      <input
        aria-label={checked ? "Completed task" : "Incomplete task"}
        checked={checked}
        disabled
        type="checkbox"
      />
    );
  },
  pre({ node, children }) {
    const fence = mermaidFenceFromPre(node);
    if (fence) {
      return <MermaidBlock fence={fence} />;
    }

    return <MarkdownCodeBlock node={node}>{children}</MarkdownCodeBlock>;
  },
  table({ children }) {
    return (
      <div aria-label="Table" className="chat-markdown-table" role="region" tabIndex={0}>
        <table>{children}</table>
      </div>
    );
  },
} satisfies Components;

const labelComponents = {
  p: MarkdownLabelBoundary,
  h1: MarkdownLabelBoundary,
  h2: MarkdownLabelBoundary,
  h3: MarkdownLabelBoundary,
  h4: MarkdownLabelBoundary,
  h5: MarkdownLabelBoundary,
  h6: MarkdownLabelBoundary,
  blockquote: MarkdownLabelBoundary,
  pre: MarkdownLabelBoundary,
  br: MarkdownLabelBoundary,
  hr: MarkdownLabelBoundary,
  li({ children }) {
    return <span>• {children} </span>;
  },
  td: MarkdownLabelCell,
  th: MarkdownLabelCell,
  tr({ children }) {
    return <span>{children}; </span>;
  },
  img({ alt }) {
    return <MarkdownImage alt={alt} />;
  },
  input({ checked }) {
    return <span>{checked ? "[x] " : "[ ] "}</span>;
  },
  section() {
    return null;
  },
} satisfies Components;

const labelAllowedElements = [
  "strong",
  "em",
  "del",
  "code",
  "sup",
  ...Object.keys(labelComponents),
];

export const Markdown = memo(function Markdown({
  text,
  className,
  streaming = false,
}: {
  readonly text: string;
  readonly className?: string;
  readonly streaming?: boolean;
}) {
  return (
    <div
      className={className ? `chat-markdown ${className}` : "chat-markdown"}
      data-streaming={streaming || undefined}
    >
      <ReactMarkdown
        components={components}
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export const MarkdownLabel = memo(function MarkdownLabel({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  return (
    <span className={className ? `chat-markdown ${className}` : "chat-markdown"}>
      <ReactMarkdown
        allowedElements={labelAllowedElements}
        components={labelComponents}
        remarkPlugins={labelRemarkPlugins}
        unwrapDisallowed
      >
        {text}
      </ReactMarkdown>
    </span>
  );
});

function MarkdownCodeBlock({
  node,
  children,
}: {
  readonly node: HastElement | undefined;
  readonly children: ReactNode;
}) {
  const codeElement = node?.tagName === "pre" ? node.children.find(isCodeElement) : undefined;
  const source = codeElement ? readCodeValue(codeElement.children) : "";
  const languageLabel = readLanguageLabel(codeElement);
  const lineCount = countCodeLines(source);
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, lineNumber) => lineNumber + 1),
    [lineCount],
  );
  const [copyState, setCopyState] = useState<CopyState>({ kind: "idle" });
  const current =
    copyState.kind !== "idle" && copyState.source === source ? copyState.kind : "idle";
  const requestIdRef = useRef(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const copy = useCallback(async () => {
    if (current === "copying") return;
    const sourceAtRequest = sourceRef.current;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setCopyState({ kind: "copying", source: sourceAtRequest });
    try {
      await navigator.clipboard.writeText(sourceAtRequest);
      if (!mountedRef.current) return;
      if (requestIdRef.current !== requestId) return;
      if (sourceRef.current !== sourceAtRequest) return;
      setCopyState({ kind: "copied", source: sourceAtRequest });
    } catch {
      if (!mountedRef.current) return;
      if (requestIdRef.current !== requestId) return;
      if (sourceRef.current !== sourceAtRequest) return;
      setCopyState({ kind: "failed", source: sourceAtRequest });
    }
  }, [current]);

  return (
    <figure className="chat-code-block">
      <figcaption className="chat-code-block-header">
        <span className="chat-code-block-language">
          <CodeIcon aria-hidden="true" size={13} weight="duotone" />
          <span title={languageLabel}>{languageLabel}</span>
        </span>
        <button
          aria-label={`Copy ${languageLabel.toLowerCase()} code`}
          className={`chat-code-block-copy ${current === "copied" ? "chat-code-block-copy-copied" : ""}`}
          disabled={current === "copying"}
          onClick={copy}
          type="button"
        >
          {current === "copied" ? (
            <CheckIcon aria-hidden="true" size={12} />
          ) : (
            <CopyIcon aria-hidden="true" size={12} />
          )}
          {current === "copying" ? "Copying" : current === "copied" ? "Copied" : "Copy"}
        </button>
      </figcaption>
      <div aria-label="Code block" className="chat-code-block-scroll" role="region" tabIndex={0}>
        <div className="chat-code-block-frame">
          <span aria-hidden="true" className="chat-code-block-gutter">
            {lineNumbers.map((lineNumber) => (
              <span key={lineNumber}>{lineNumber}</span>
            ))}
          </span>
          <pre className="chat-code-block-pre">{children}</pre>
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {current === "copied" ? "Code copied" : ""}
      </p>
      {current === "failed" && (
        <p className="chat-code-block-copy-error" role="alert">
          Could not copy code. Select the text and copy it manually.
        </p>
      )}
    </figure>
  );
}

function MarkdownLabelBoundary({ children }: ComponentProps<"span">) {
  return <span>{children} </span>;
}

function MarkdownLabelCell({ children }: ComponentProps<"span">) {
  return <span>{children} | </span>;
}

function MarkdownImage({ alt, src, title }: ComponentProps<"img">) {
  const insideLink = useContext(LinkContext);
  const label = alt ? `Image: ${alt}` : "Image";
  if (insideLink || typeof src !== "string" || !src) return <span>{label}</span>;
  return (
    <a
      href={src}
      referrerPolicy="no-referrer"
      rel="noopener noreferrer"
      target="_blank"
      title={title}
    >
      {label}
    </a>
  );
}

export function remarkFormulaMetadata(
  this: {
    data(key: "fromMarkdownExtensions"): unknown;
    data(key: "fromMarkdownExtensions", value: unknown): undefined;
  },
  options?: { readonly mode?: FormulaTransformMode },
) {
  const extensions = (this.data("fromMarkdownExtensions") as Array<unknown> | undefined) ?? [];
  extensions.push({
    exit: {
      codeFencedFenceSequence(this: MarkdownCompileContext) {
        onFenceSequence(this, "code");
      },
      mathFlowFenceSequence(this: MarkdownCompileContext) {
        onFenceSequence(this, "math");
      },
    },
  });
  this.data("fromMarkdownExtensions", extensions);

  return (tree: MarkdownNode, file: { readonly value?: unknown }) => {
    const mode = options?.mode ?? "typeset";
    const source = typeof file.value === "string" ? file.value : undefined;
    rewriteFormulaNodes(tree, source, mode);
  };
}

export function mermaidFenceFromPre(node: HastElement | undefined): MermaidFence | undefined {
  if (node?.tagName !== "pre") return;
  const codeElement = node.children.find(isCodeElement);
  if (!codeElement) return;
  const className = readClassNames(codeElement.properties?.className);
  if (!className.includes("language-mermaid")) return;
  const source = readCodeValue(codeElement.children);
  const closed = isClosedFenceValue(codeElement.properties?.[MERMAID_CLOSED_PROPERTY]);
  return { kind: closed ? "closed" : "open", source };
}

function rewriteFormulaNodes(
  parent: MarkdownNode,
  source: string | undefined,
  mode: FormulaTransformMode,
): void {
  if (!parent.children) return;
  for (let index = 0; index < parent.children.length; index++) {
    const node = parent.children[index];
    if (!node) continue;
    if (node.type === "inlineMath") {
      if (mode === "source") {
        parent.children[index] = {
          type: "text",
          value: readNodeSource(node, source) ?? node.value ?? "",
        };
      }
    } else if (node.type === "math" || (node.type === "code" && node.lang === "math")) {
      parent.children[index] =
        mode === "typeset" && node.data?.closedFence
          ? toTypesetMathBlock(node)
          : {
              type: "paragraph",
              data: { hName: "div", hProperties: { className: ["chat-math-source"] } },
              children: [{ type: "text", value: readNodeSource(node, source) ?? node.value ?? "" }],
            };
    } else {
      rewriteFormulaNodes(node, source, mode);
    }
  }
}

function toTypesetMathBlock(node: MarkdownNode): MarkdownNode {
  const value = typeof node.value === "string" ? node.value : "";
  const data = { ...(node.data ?? {}) };
  data.hName = "div";
  data.hProperties = {
    "aria-label": "Math formula",
    className: ["chat-math-block"],
    role: "region",
    tabIndex: 0,
  };
  data.hChildren = [
    {
      type: "element",
      tagName: "code",
      properties: {
        className: ["language-math", "math-display"],
      },
      children: [{ type: "text", value }],
    },
  ];
  return { ...node, type: "math", data };
}

function readNodeSource(node: MarkdownNode, source: string | undefined): string | undefined {
  if (!source) return;
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number") return;
  if (start < 0 || end < start || end > source.length) return;
  return source.slice(start, end);
}

function onFenceSequence(context: MarkdownCompileContext, type: "code" | "math"): void {
  const node = context.stack.findLast((entry) => entry.type === type) as MarkdownNode | undefined;
  if (!node) return;
  context.data.fenceSequenceByNode ??= new WeakMap<MarkdownNode, number>();
  const sequences = context.data.fenceSequenceByNode;
  const count = (sequences.get(node) ?? 0) + 1;
  sequences.set(node, count);
  if (count < 2) return;
  node.data ??= {};
  const data = node.data;
  data.closedFence = true;
  if (type === "code" && node.lang?.trim().toLowerCase() === "mermaid") {
    data.hProperties ??= {};
    const properties = data.hProperties;
    properties[MERMAID_CLOSED_PROPERTY] = "true";
  }
}

function isClosedFenceValue(value: unknown): boolean {
  return value === true || value === "true";
}

function rehypeKatexPlugin() {
  return rehypeKatexTransformer;
}

function rehypeCodeHighlightPlugin() {
  return rehypeCodeHighlightTransformer;
}

function isCodeElement(node: HastChild): node is HastElement {
  return node.type === "element" && node.tagName === "code";
}

function readClassNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string") {
    return value.split(/\s+/u).filter(Boolean);
  }
  return [];
}

function readLanguageLabel(codeElement: HastElement | undefined): string {
  if (!codeElement) return "Plain text";
  const classNames = readClassNames(codeElement.properties?.className);
  for (const className of classNames) {
    if (className.startsWith("language-")) {
      return formatLanguageLabel(className.slice(9));
    }
    if (className.startsWith("lang-")) {
      return formatLanguageLabel(className.slice(5));
    }
  }
  return "Plain text";
}

function formatLanguageLabel(language: string): string {
  const trimmed = language.trim();
  if (!trimmed) return "Plain text";
  return trimmed.replace(/[-_]+/gu, " ");
}

function countCodeLines(source: string): number {
  let lines = 1;
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10) lines++;
  }
  return lines;
}

function readCodeValue(children: HastElement["children"]): string {
  const text = readTextNodes(children);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function readTextNodes(children: HastElement["children"]): string {
  return children.map(readTextNode).join("");
}

function readTextNode(node: HastChild): string {
  if (node.type === "text") {
    return node.value;
  }
  if (node.type === "element") {
    return readTextNodes(node.children);
  }
  return "";
}
