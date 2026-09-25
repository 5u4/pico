import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewline,
  isolateHistory,
} from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  type StateEffect,
} from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  ArrowUpIcon,
  FolderSimpleIcon,
  StopIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type FormEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import type { ComposerPresentation, SkillCompletionPresentation } from "./chat-model.ts";

interface CaretSelection {
  readonly start: number;
  readonly end: number;
}

export interface ComposerProps {
  readonly presentation: ComposerPresentation;
  readonly completion: SkillCompletionPresentation;
  readonly contextLabel?: string;
  readonly caretRequest: { readonly revision: number; readonly selection: CaretSelection } | null;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
  readonly onImageRemove: (id: string) => void;
  readonly onCompletionCommit: () => void;
  readonly onCompletionMove: (delta: -1 | 1) => void;
  readonly onCompletionDismiss: () => void;
  readonly onCaretChange: (selection: CaretSelection) => void;
}

type ComposerViewMode = "compact" | "expanded";

const externalChange = Annotation.define<boolean>();

const composerHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--raw-foreground)", fontWeight: "600" },
  { tag: tags.quote, color: "var(--raw-muted)" },
  { tag: tags.url, color: "var(--raw-accent-ink)", textDecoration: "underline" },
  { tag: tags.monospace, color: "var(--raw-code-text)" },
  { tag: tags.keyword, color: "var(--raw-code-token-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--raw-code-token-string)" },
  { tag: [tags.number, tags.atom, tags.bool], color: "var(--raw-code-token-number)" },
  { tag: [tags.typeName, tags.className], color: "var(--raw-code-token-title)" },
  { tag: tags.comment, color: "var(--raw-code-token-comment)", fontStyle: "italic" },
]);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const buildAriaAttributes = (completion: SkillCompletionPresentation) => {
  const completionOpen = completion.kind !== "closed";
  const attributes: Record<string, string> = {
    role: "textbox",
    "aria-label": "Message pico",
    "aria-multiline": "true",
    "aria-describedby": "composer-status",
    autocapitalize: "off",
    autocomplete: "off",
    autocorrect: "off",
    spellcheck: "true",
  };
  if (completionOpen) {
    attributes["aria-autocomplete"] = "list";
    attributes["aria-controls"] = completion.listboxId;
  }
  if (completion.kind === "ready")
    attributes["aria-activedescendant"] = completion.activeDescendantId;
  return attributes;
};

const buildAriaSignature = (completion: SkillCompletionPresentation) =>
  completion.kind === "closed"
    ? "closed"
    : `${completion.kind}\u0000${completion.listboxId}\u0000${completion.activeDescendantId}`;

export function Composer({
  presentation,
  completion,
  contextLabel,
  caretRequest,
  onValueChange,
  onSubmit,
  onStop,
  onImageRemove,
  onCompletionCommit,
  onCompletionMove,
  onCompletionDismiss,
  onCaretChange,
}: ComposerProps) {
  const editorHost = useRef<HTMLDivElement>(null);
  const editorView = useRef<EditorView | null>(null);
  const appliedCaretRequest = useRef<number>(-1);
  const lastText = useRef(presentation.value);
  const resizeSnapshot = useRef<ReturnType<EditorView["scrollSnapshot"]> | null>(null);
  const [viewMode, setViewMode] = useState<ComposerViewMode>("compact");
  const viewModeRef = useRef<ComposerViewMode>(viewMode);
  viewModeRef.current = viewMode;
  const completionOpen = completion.kind !== "closed";
  const editableCompartment = useMemo(() => new Compartment(), []);
  const placeholderCompartment = useMemo(() => new Compartment(), []);
  const ariaCompartment = useMemo(() => new Compartment(), []);
  const configuration = useRef({
    editable: presentation.editable,
    placeholder: presentation.placeholder,
    ariaSignature: buildAriaSignature(completion),
  });
  const latest = useRef({
    completion,
    presentation,
    onValueChange,
    onSubmit,
    onCompletionCommit,
    onCompletionMove,
    onCompletionDismiss,
    onCaretChange,
  });
  latest.current = {
    completion,
    presentation,
    onValueChange,
    onSubmit,
    onCompletionCommit,
    onCompletionMove,
    onCompletionDismiss,
    onCaretChange,
  };

  const reportCaret = (view: EditorView) => {
    const selection = view.state.selection.main;
    latest.current.onCaretChange({
      start: selection.from,
      end: selection.to,
    });
  };

  const extensions = useMemo(
    () => [
      history(),
      markdown({
        base: markdownLanguage,
        addKeymap: false,
        completeHTMLTags: false,
        pasteURLAsLink: false,
        htmlTagLanguage: html({ autoCloseTags: false, matchClosingTags: false }),
      }),
      syntaxHighlighting(composerHighlightStyle),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const next = update.state.doc.toString();
          lastText.current = next;
          if (
            update.transactions.some(
              (transaction) => transaction.docChanged && !transaction.annotation(externalChange),
            )
          ) {
            latest.current.onValueChange(next);
          }
        }
        if (update.docChanged || update.selectionSet) reportCaret(update.view);
      }),
      Prec.high(
        EditorView.domEventHandlers({
          focus: (_event, view) => {
            reportCaret(view);
            return false;
          },
          keydown: (event, view) => {
            if (view.composing || view.compositionStarted || event.isComposing) return false;
            const current = latest.current;
            const menuOpen = current.completion.kind !== "closed";
            const bare = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
            if (menuOpen && bare) {
              if (event.key === "Tab" && current.completion.kind === "ready") {
                current.onCompletionCommit();
                return true;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                current.onCompletionMove(event.key === "ArrowDown" ? 1 : -1);
                return true;
              }
              if (event.key === "Escape") {
                current.onCompletionDismiss();
                return true;
              }
            }
            if (event.key !== "Enter" || event.altKey) return false;
            if (event.shiftKey) {
              if (event.ctrlKey || event.metaKey) return false;
              insertNewline(view);
              return true;
            }
            if (menuOpen) return true;
            if (bare && viewModeRef.current === "expanded") return false;
            if (current.presentation.mode === "send" && current.presentation.canSubmit)
              current.onSubmit();
            return true;
          },
        }),
      ),
      keymap.of([...markdownKeymap, ...historyKeymap, ...defaultKeymap]),
    ],
    [],
  );

  const createState = (doc: string, selection?: EditorSelection) => {
    const current = latest.current;
    configuration.current = {
      editable: current.presentation.editable,
      placeholder: current.presentation.placeholder,
      ariaSignature: buildAriaSignature(current.completion),
    };
    return EditorState.create({
      doc,
      ...(selection ? { selection } : {}),
      extensions: [
        extensions,
        editableCompartment.of([
          EditorView.editable.of(current.presentation.editable),
          EditorState.readOnly.of(!current.presentation.editable),
        ]),
        placeholderCompartment.of(placeholder(current.presentation.placeholder)),
        ariaCompartment.of(
          EditorView.contentAttributes.of(buildAriaAttributes(current.completion)),
        ),
      ],
    });
  };

  useLayoutEffect(() => {
    const parent = editorHost.current;
    if (!parent) return;
    const state = createState(latest.current.presentation.value);
    lastText.current = latest.current.presentation.value;
    appliedCaretRequest.current = -1;
    const view = new EditorView({ state, parent });
    editorView.current = view;
    return () => {
      editorView.current = null;
      view.destroy();
    };
  }, [ariaCompartment, editableCompartment, extensions, placeholderCompartment]);

  useLayoutEffect(() => {
    const view = editorView.current;
    if (!view) return;
    const nextAriaSignature = buildAriaSignature(completion);
    const effects: StateEffect<unknown>[] = [];
    if (configuration.current.editable !== presentation.editable) {
      effects.push(
        editableCompartment.reconfigure([
          EditorView.editable.of(presentation.editable),
          EditorState.readOnly.of(!presentation.editable),
        ]),
      );
      configuration.current.editable = presentation.editable;
    }
    if (configuration.current.placeholder !== presentation.placeholder) {
      effects.push(placeholderCompartment.reconfigure(placeholder(presentation.placeholder)));
      configuration.current.placeholder = presentation.placeholder;
    }
    if (configuration.current.ariaSignature !== nextAriaSignature) {
      effects.push(
        ariaCompartment.reconfigure(
          EditorView.contentAttributes.of(buildAriaAttributes(completion)),
        ),
      );
      configuration.current.ariaSignature = nextAriaSignature;
    }
    if (effects.length > 0) view.dispatch({ effects });
  }, [
    ariaCompartment,
    completion,
    editableCompartment,
    placeholderCompartment,
    presentation.editable,
    presentation.placeholder,
  ]);

  useLayoutEffect(() => {
    const view = editorView.current;
    if (!view) return;
    const textChanged = presentation.value !== lastText.current;
    const applyCaret =
      caretRequest !== null && appliedCaretRequest.current !== caretRequest.revision
        ? caretRequest
        : null;
    if (!textChanged && applyCaret === null) return;
    if (applyCaret !== null) appliedCaretRequest.current = applyCaret.revision;

    const selectionLength = textChanged ? presentation.value.length : view.state.doc.length;
    const selection =
      applyCaret === null
        ? undefined
        : EditorSelection.single(
            clamp(applyCaret.selection.start, 0, selectionLength),
            clamp(applyCaret.selection.end, 0, selectionLength),
          );

    if (textChanged && presentation.value.length === 0 && lastText.current.length > 0) {
      view.setState(createState(presentation.value, selection));
      lastText.current = presentation.value;
      if (applyCaret !== null) view.contentDOM.focus({ preventScroll: true });
      reportCaret(view);
      return;
    }

    view.dispatch({
      ...(textChanged
        ? { changes: { from: 0, to: view.state.doc.length, insert: presentation.value } }
        : {}),
      ...(selection ? { selection } : {}),
      annotations: [externalChange.of(true), isolateHistory.of("full")],
    });

    if (applyCaret !== null) view.contentDOM.focus({ preventScroll: true });
  }, [
    caretRequest,
    completion,
    presentation.editable,
    presentation.placeholder,
    presentation.value,
  ]);

  useLayoutEffect(() => {
    const view = editorView.current;
    const snapshot = resizeSnapshot.current;
    if (!view || !snapshot) return;
    resizeSnapshot.current = null;
    view.contentDOM.focus({ preventScroll: true });
    view.dispatch({ effects: snapshot });
  }, [viewMode]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!completionOpen && presentation.mode === "send" && presentation.canSubmit) onSubmit();
  };

  const expanded = viewMode === "expanded";
  const statusLabel =
    completion.kind === "ready"
      ? "Tab to complete · Esc to close"
      : completionOpen
        ? "Esc to close"
        : (presentation.statusLabel ??
          (expanded
            ? presentation.mode === "send"
              ? "Enter for a new line · Ctrl/⌘+Enter to send"
              : "Enter for a new line"
            : presentation.mode === "send"
              ? "Enter to send · Shift+Enter for a new line"
              : "Shift+Enter for a new line"));

  return (
    <form
      className={`composer relative isolate flex w-full flex-col gap-1.5 overflow-hidden border border-border bg-panel shadow-card${expanded ? " composer-expanded" : ""}`}
      data-view-mode={viewMode}
      onSubmit={submit}
    >
      {presentation.images.length > 0 && (
        <ul aria-label="Attached images" className="composer-images flex flex-wrap gap-2 px-2 pt-2">
          {presentation.images.map((image) => (
            <li className="group relative" key={image.id}>
              <img
                alt={image.name}
                className="size-14 rounded-control border border-border object-cover"
                src={`data:${image.mimeType};base64,${image.data}`}
              />
              <button
                aria-label={`Remove ${image.name}`}
                className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-border bg-panel text-subtle transition-colors hover:text-foreground"
                disabled={!presentation.editable}
                onClick={() => onImageRemove(image.id)}
                type="button"
              >
                <XIcon aria-hidden="true" size={11} weight="bold" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-input" ref={editorHost} />
      <div className="composer-toolbar flex min-h-7 items-center gap-1.5">
        {contextLabel && (
          <span
            className="composer-context flex min-w-0 max-w-[45%] items-center gap-1.5 px-1.5 text-meta text-muted"
            title={contextLabel}
          >
            <FolderSimpleIcon aria-hidden="true" className="shrink-0" size={14} />
            <span className="truncate">{contextLabel}</span>
          </span>
        )}
        <p
          aria-atomic="true"
          className="composer-status min-w-0 flex-1 truncate px-1.5 text-meta text-subtle"
          id="composer-status"
          role="status"
          title={statusLabel}
        >
          {statusLabel}
        </p>
        <Button
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse composer" : "Expand composer"}
          className="prompt-control"
          onClick={() => {
            resizeSnapshot.current = editorView.current?.scrollSnapshot() ?? null;
            setViewMode((current) => (current === "compact" ? "expanded" : "compact"));
          }}
          size="icon"
          tone="secondary"
          type="button"
        >
          {expanded ? (
            <ArrowsInSimpleIcon aria-hidden="true" size={14} weight="bold" />
          ) : (
            <ArrowsOutSimpleIcon aria-hidden="true" size={14} weight="bold" />
          )}
        </Button>
        {presentation.mode === "send" ? (
          <Button
            aria-label="Send message"
            className="prompt-control prompt-send"
            disabled={completionOpen || !presentation.canSubmit}
            size="icon"
            tone="primary"
            type="submit"
          >
            <ArrowUpIcon aria-hidden="true" size={16} weight="bold" />
          </Button>
        ) : (
          <Button
            aria-label="Stop response"
            className="prompt-control"
            disabled={!presentation.canStop}
            onClick={onStop}
            size="icon"
            tone="danger"
            type="button"
          >
            <StopIcon aria-hidden="true" size={14} weight="fill" />
          </Button>
        )}
      </div>
    </form>
  );
}
