import { type ComponentProps, createContext, memo, useContext } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { MermaidBlock, type MermaidFence } from "./mermaid-block.tsx";

const LinkContext = createContext(false);
const MERMAID_CLOSED_PROPERTY = "data-mermaid-closed-fence";

type MarkdownCompileContext = {
  readonly stack: Array<{ readonly type?: string; readonly [key: string]: unknown }>;
  readonly data: {
    mermaidFenceSequenceByCode?: WeakMap<CodeNode, number>;
  };
};

type HastElement = NonNullable<ExtraProps["node"]>;
type HastText = Extract<HastElement["children"][number], { type: "text" }>;

type CodeNode = {
  readonly type: "code";
  readonly lang?: string | null;
  data?: {
    hProperties?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

const remarkPlugins = [remarkGfm, remarkBreaks, remarkMermaidFenceMetadata];

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

    return (
      <pre aria-label="Code block" tabIndex={0}>
        {children}
      </pre>
    );
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
      <ReactMarkdown components={components} remarkPlugins={remarkPlugins}>
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
        remarkPlugins={remarkPlugins}
        unwrapDisallowed
      >
        {text}
      </ReactMarkdown>
    </span>
  );
});

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

export function remarkMermaidFenceMetadata(this: {
  data(key: "fromMarkdownExtensions"): unknown;
  data(key: "fromMarkdownExtensions", value: unknown): undefined;
}) {
  const extensions = (this.data("fromMarkdownExtensions") as Array<unknown> | undefined) ?? [];
  extensions.push({
    exit: {
      codeFencedFenceSequence(this: MarkdownCompileContext) {
        onCodeFenceSequence(this);
      },
    },
  });
  this.data("fromMarkdownExtensions", extensions);
}

export function mermaidFenceFromPre(node: HastElement | undefined): MermaidFence | undefined {
  if (node?.tagName !== "pre") return;
  const codeElement = node.children.find(isCodeElement);
  if (!codeElement) return;
  const className = readClassNames(codeElement.properties?.className);
  if (!className.includes("language-mermaid")) return;
  const source = readCodeValue(codeElement.children);
  const closed =
    codeElement.properties?.[MERMAID_CLOSED_PROPERTY] === true ||
    codeElement.properties?.[MERMAID_CLOSED_PROPERTY] === "true";
  return { kind: closed ? "closed" : "open", source };
}

function onCodeFenceSequence(context: MarkdownCompileContext): void {
  const codeNode = findNearestCodeNode(context.stack);
  if (!codeNode) return;
  const sequenceByCode = context.data.mermaidFenceSequenceByCode ?? new WeakMap<CodeNode, number>();
  context.data.mermaidFenceSequenceByCode = sequenceByCode;
  const nextSequence = (sequenceByCode.get(codeNode) ?? 0) + 1;
  sequenceByCode.set(codeNode, nextSequence);
  if (nextSequence < 2) return;
  if (codeNode.lang?.trim().toLowerCase() !== "mermaid") return;

  const data = codeNode.data ?? {};
  const hProperties = data.hProperties ?? {};
  hProperties[MERMAID_CLOSED_PROPERTY] = "true";
  data.hProperties = hProperties;
  codeNode.data = data;
}

function findNearestCodeNode(stack: MarkdownCompileContext["stack"]): CodeNode | undefined {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index];
    if (entry?.type === "code") {
      return entry as CodeNode;
    }
  }
}

function isCodeElement(node: HastElement["children"][number]): node is HastElement {
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

function readCodeValue(children: HastElement["children"]): string {
  const text = children
    .filter((node): node is HastText => node.type === "text")
    .map((node) => node.value)
    .join("");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
