import { type ComponentProps, createContext, memo, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const LinkContext = createContext(false);
const remarkPlugins = [remarkGfm, remarkBreaks];
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
  pre({ children }) {
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
