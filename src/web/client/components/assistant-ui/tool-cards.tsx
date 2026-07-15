import {
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
  type ToolCallMessagePartStatus,
  useToolCallElapsed,
} from "@assistant-ui/react";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  FileDiffIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderSearchIcon,
  LoaderIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { z } from "zod";
import { cn } from "../../lib/utils";
import { CollapsibleTrigger } from "../ui/collapsible";
import {
  formatToolDuration,
  ToolFallback,
  ToolFallbackContent,
  ToolFallbackRoot,
} from "./tool-fallback";

const argRecordSchema = z.record(z.string(), z.unknown());

function readString(args: unknown, key: string): string | undefined {
  const parsed = argRecordSchema.safeParse(args);
  if (!parsed.success) return undefined;
  const value = parsed.data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstLine(value: string): string {
  const index = value.indexOf("\n");
  return index === -1 ? value : value.slice(0, index);
}

function resultText(result: unknown): string | undefined {
  if (result === undefined) return undefined;
  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return text.length > 0 ? text : undefined;
}

function editPath(args: unknown): string | undefined {
  const input = readString(args, "input");
  if (input) {
    const hashline = /^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/m.exec(input);
    if (hashline?.[1]) return hashline[1];
    const applyPatch = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(
      input,
    );
    if (applyPatch?.[1]) return applyPatch[1].trim();
  }
  return readString(args, "path");
}

type Summarize = (args: unknown) => string | undefined;

interface ToolCardConfig {
  label: string;
  icon: ComponentType<{ className?: string }>;
  summarize: Summarize;
}

function ToolCardTrigger({
  label,
  summary,
  icon: Icon,
  status,
  isError,
}: {
  label: string;
  summary?: string;
  icon: ComponentType<{ className?: string }>;
  status?: ToolCallMessagePartStatus;
  isError?: boolean;
}) {
  const isRunning = status?.type === "running";
  const elapsedMs = useToolCallElapsed();
  const durationText =
    elapsedMs === undefined ? undefined : formatToolDuration(elapsedMs);
  const GlyphIcon = isError ? CircleAlertIcon : isRunning ? LoaderIcon : Icon;

  return (
    <CollapsibleTrigger
      data-slot="tool-card-trigger"
      className="group/trigger flex w-fit min-w-0 max-w-full origin-left items-center gap-2 py-1 text-sm text-muted-foreground transition-[color,scale] hover:text-foreground active:scale-[0.98]"
    >
      <GlyphIcon
        className={cn(
          "size-4 shrink-0",
          isRunning && "animate-spin [animation-duration:0.6s]",
          isError && "text-destructive",
        )}
      />
      <span
        className={cn(
          "shrink-0 font-mono font-medium",
          isError ? "text-destructive" : "text-foreground/90",
        )}
      >
        {label}
      </span>
      {summary ? (
        <span
          className={cn(
            "min-w-0 truncate text-xs",
            isError ? "text-destructive/90" : "text-muted-foreground",
          )}
        >
          {summary}
        </span>
      ) : null}
      {durationText ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {durationText}
        </span>
      ) : null}
      <ChevronDownIcon
        className={cn(
          "size-4 shrink-0 -rotate-90 transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)]",
          "group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0",
          "motion-reduce:transition-none",
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolCardSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
        {label}
      </span>
      {children}
    </div>
  );
}

function ToolCardBox({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-md p-2.5 text-xs whitespace-pre-wrap",
        tone === "error"
          ? "bg-destructive/10 text-destructive"
          : "bg-muted/50 text-foreground/90",
      )}
    >
      {text}
    </pre>
  );
}

function makeToolCard(config: ToolCardConfig): ToolCallMessagePartComponent {
  function ToolCard(props: ToolCallMessagePartProps) {
    if (props.status?.type === "requires-action") {
      return <ToolFallback {...props} />;
    }

    const output = resultText(props.result);
    const errorSummary = props.isError
      ? firstLine(output?.trim() ?? "") || config.summarize(props.args)
      : undefined;
    const summary = errorSummary ?? config.summarize(props.args);
    const paramsText = JSON.stringify(props.args ?? {}, null, 2);

    return (
      <ToolFallbackRoot>
        <ToolCardTrigger
          label={config.label}
          summary={summary}
          icon={config.icon}
          status={props.status}
          isError={props.isError}
        />
        <ToolFallbackContent>
          <ToolCardSection label="Parameters">
            <ToolCardBox text={paramsText} />
          </ToolCardSection>
          {output !== undefined ? (
            <ToolCardSection label="Result">
              <ToolCardBox
                text={output}
                tone={props.isError ? "error" : undefined}
              />
            </ToolCardSection>
          ) : null}
        </ToolFallbackContent>
      </ToolFallbackRoot>
    );
  }

  ToolCard.displayName = `ToolCard(${config.label})`;
  return ToolCard;
}

const bashCard = makeToolCard({
  label: "bash",
  icon: TerminalIcon,
  summarize: (args) => {
    const command = readString(args, "command");
    return command ? firstLine(command) : undefined;
  },
});

const readCard = makeToolCard({
  label: "read",
  icon: FileTextIcon,
  summarize: (args) => {
    const path = readString(args, "path");
    if (!path) return undefined;
    const selector = readString(args, "selector");
    return selector ? `${path}:${selector}` : path;
  },
});

const writeCard = makeToolCard({
  label: "write",
  icon: FilePlusIcon,
  summarize: (args) => readString(args, "path"),
});

const editCard = makeToolCard({
  label: "edit",
  icon: FileDiffIcon,
  summarize: (args) => editPath(args),
});

const grepCard = makeToolCard({
  label: "grep",
  icon: SearchIcon,
  summarize: (args) => {
    const pattern = readString(args, "pattern");
    if (!pattern) return undefined;
    const path = readString(args, "path");
    return path ? `${pattern}  ·  ${path}` : pattern;
  },
});

const globCard = makeToolCard({
  label: "glob",
  icon: FolderSearchIcon,
  summarize: (args) => readString(args, "path"),
});

export const toolCardsByName: Record<string, ToolCallMessagePartComponent> = {
  bash: bashCard,
  read: readCard,
  write: writeCard,
  edit: editCard,
  grep: grepCard,
  glob: globCard,
};
