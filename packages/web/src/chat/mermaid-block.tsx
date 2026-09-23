import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { MermaidRenderTheme } from "./mermaid-render.ts";

export type MermaidFence =
  | {
      readonly kind: "open";
      readonly source: string;
    }
  | {
      readonly kind: "closed";
      readonly source: string;
    };

type MermaidView = "preview" | "source";

type MermaidRenderState =
  | {
      readonly kind: "waiting";
      readonly source: string;
      readonly reason: "open-fence" | "loading";
    }
  | {
      readonly kind: "ready";
      readonly source: string;
      readonly svg: SVGSVGElement;
    }
  | {
      readonly kind: "failed";
      readonly source: string;
    };

type CopyState =
  | { readonly kind: "idle" }
  | { readonly kind: "copying" | "copied" | "failed"; readonly source: string };

let mermaidRenderModulePromise: Promise<typeof import("./mermaid-render.ts")> | null = null;

export function MermaidBlock({ fence }: { readonly fence: MermaidFence }) {
  const [view, setView] = useState<MermaidView>("preview");
  const [copyState, setCopyState] = useState<CopyState>({ kind: "idle" });
  const [theme, setTheme] = useState<MermaidRenderTheme | null>(null);
  const [renderState, setRenderState] = useState<MermaidRenderState>({
    kind: "waiting",
    source: fence.source,
    reason: "loading",
  });
  const previewRef = useRef<HTMLDivElement>(null);
  const current: MermaidRenderState =
    fence.kind === "open"
      ? { kind: "waiting", source: fence.source, reason: "open-fence" }
      : renderState.source === fence.source
        ? renderState
        : { kind: "waiting", source: fence.source, reason: "loading" };
  const showSource = view === "source" || current.kind !== "ready";
  const copyCurrent =
    copyState.kind !== "idle" && copyState.source === fence.source ? copyState.kind : "idle";

  useEffect(() => {
    const update = () => setTheme(readMermaidTheme());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (fence.kind === "open" || !theme) return;
    let active = true;
    setRenderState({ kind: "waiting", source: fence.source, reason: "loading" });
    void loadMermaidRenderModule()
      .then((module) => {
        if (!active) return;
        const svg = module.renderMermaidDiagram(fence.source, theme);
        setRenderState({ kind: "ready", source: fence.source, svg });
      })
      .catch(() => {
        if (active) setRenderState({ kind: "failed", source: fence.source });
      });
    return () => {
      active = false;
    };
  }, [fence.kind, fence.source, theme]);

  useEffect(() => {
    const host = previewRef.current;
    if (!host) return;
    if (showSource || renderState.kind !== "ready") {
      host.replaceChildren();
      return;
    }

    host.replaceChildren(renderState.svg);
    return () => {
      if (host.firstChild === renderState.svg) {
        host.replaceChildren();
      }
    };
  }, [renderState, showSource]);

  const fallbackMessage = previewFallbackMessage(current);
  const copy = async () => {
    if (copyState.kind === "copying") return;
    const source = fence.source;
    setCopyState({ kind: "copying", source });
    try {
      await navigator.clipboard.writeText(source);
      setCopyState({ kind: "copied", source });
    } catch {
      setCopyState({ kind: "failed", source });
      setView("source");
    }
  };

  return (
    <section className="chat-mermaid">
      <div className="chat-mermaid-controls">
        <div aria-label="Mermaid format" className="flex flex-wrap gap-1" role="group">
          <button
            aria-pressed={view === "preview"}
            className={`min-h-7 rounded-chip px-2 text-[12px] font-medium transition-colors duration-100 hover:bg-surface-hover ${view === "preview" ? "bg-field text-foreground shadow-hairline" : "text-muted"}`}
            onClick={() => setView("preview")}
            type="button"
          >
            Preview
          </button>
          <button
            aria-pressed={view === "source"}
            className={`min-h-7 rounded-chip px-2 text-[12px] font-medium transition-colors duration-100 hover:bg-surface-hover ${view === "source" ? "bg-field text-foreground shadow-hairline" : "text-muted"}`}
            onClick={() => setView("source")}
            type="button"
          >
            Source
          </button>
        </div>
        <button
          aria-label="Copy mermaid source"
          className={`flex min-h-7 items-center gap-1 rounded-chip px-1.5 text-[12px] font-medium transition-colors duration-100 hover:bg-surface-hover disabled:cursor-wait ${copyCurrent === "copied" ? "text-success" : "text-muted hover:text-foreground"}`}
          disabled={copyState.kind === "copying"}
          onClick={copy}
          type="button"
        >
          {copyCurrent === "copied" ? (
            <CheckIcon aria-hidden="true" size={12} />
          ) : (
            <CopyIcon aria-hidden="true" size={12} />
          )}
          {copyCurrent === "copying"
            ? "Copying"
            : copyCurrent === "copied"
              ? "Copied"
              : "Copy source"}
        </button>
      </div>

      {showSource ? (
        <div className="chat-mermaid-source-panel">
          {fallbackMessage ? (
            <p className="chat-mermaid-status" role="status">
              {fallbackMessage}
            </p>
          ) : null}
          <div
            aria-label="Mermaid source"
            className="chat-mermaid-source"
            role="region"
            tabIndex={0}
          >
            <pre className="chat-code-block-pre">
              <code>{fence.source}</code>
            </pre>
          </div>
        </div>
      ) : null}
      <div
        hidden={showSource}
        aria-label="Mermaid preview"
        className="chat-mermaid-preview"
        role="region"
        tabIndex={0}
      >
        <div className="chat-mermaid-stage" ref={previewRef} />
      </div>

      <p aria-live="polite" className="sr-only">
        {copyCurrent === "copied" ? "Mermaid source copied" : ""}
      </p>
      {copyCurrent === "failed" ? (
        <p className="mt-2 text-[12px] text-danger" role="alert">
          Could not copy mermaid source. Select the text and copy it manually.
        </p>
      ) : null}
    </section>
  );
}

function previewFallbackMessage(state: MermaidRenderState): string | null {
  if (state.kind === "waiting" && state.reason === "open-fence") {
    return "Preview appears when the code block is complete.";
  }
  if (state.kind === "waiting") {
    return "Rendering diagram preview.";
  }
  if (state.kind === "failed") {
    return "Preview unavailable. View or copy the Mermaid source below.";
  }
  return null;
}

function loadMermaidRenderModule(): Promise<typeof import("./mermaid-render.ts")> {
  mermaidRenderModulePromise ??= import("./mermaid-render.ts");
  return mermaidRenderModulePromise;
}

function readMermaidTheme(): MermaidRenderTheme {
  const style = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Cannot resolve diagram theme colors.");
  const color = (name: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = style.getPropertyValue(name).trim();
    context.fillRect(0, 0, 1, 1);
    return `#${Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3), (channel) =>
      channel.toString(16).padStart(2, "0"),
    ).join("")}`;
  };
  return {
    bg: color("--raw-surface"),
    fg: color("--raw-foreground"),
    line: color("--raw-muted"),
    accent: color("--raw-accent"),
    muted: color("--raw-muted"),
    surface: color("--raw-field"),
    border: color("--raw-border-strong"),
    fontSans: style.getPropertyValue("--raw-font-sans").trim(),
    fontMono: style.getPropertyValue("--raw-font-mono").trim(),
  };
}
