import type { ContextUsageBreakdown } from "../../../../engine/conversations";
import { useThread } from "../runtime";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  return thousands >= 100
    ? `${Math.round(thousands)}k`
    : `${thousands.toFixed(1).replace(/\.0$/, "")}k`;
}

function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(cost >= 1 ? 2 : 3)}`;
}

const CATEGORY_LABELS: {
  key: keyof ContextUsageBreakdown;
  label: string;
}[] = [
  { key: "systemPrompt", label: "System prompt" },
  { key: "systemTools", label: "Tools" },
  { key: "systemContext", label: "Context" },
  { key: "skills", label: "Skills" },
  { key: "messages", label: "Messages" },
];

function UsageRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function ContextUsage() {
  const { usage } = useThread();
  if (!usage) return null;

  const percent = formatPercent(usage.percent);
  const capLabel = `${formatTokens(usage.tokens)} of ${formatTokens(
    usage.contextWindow,
  )} tokens`;

  return (
    <Popover>
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-muted hover:text-foreground">
              <span>{formatTokens(usage.tokens)}</span>
              <span className="opacity-70">({percent})</span>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{capLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent side="top">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm font-semibold">Context usage</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatTokens(usage.tokens)} of{" "}
                {formatTokens(usage.contextWindow)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground/80"
                style={{
                  width: `${Math.min(100, Math.max(0, usage.percent))}%`,
                }}
              />
            </div>
          </div>
          {usage.breakdown && (
            <div className="flex flex-col gap-1.5 border-t border-border/60 pt-3">
              {CATEGORY_LABELS.map(({ key, label }) => (
                <UsageRow
                  key={key}
                  label={label}
                  value={formatTokens(usage.breakdown?.[key] ?? 0)}
                />
              ))}
            </div>
          )}
          <div className="border-t border-border/60 pt-3">
            <UsageRow label="Session cost" value={formatCost(usage.cost)} />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
