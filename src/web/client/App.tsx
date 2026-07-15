import "./styles.css";
import { PanelLeftIcon } from "lucide-react";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { Sidebar } from "./components/sidebar";
import { Thread } from "./components/thread";
import { AssistantPane, RuntimeProvider, useShell } from "./runtime";

function ErrorBanner() {
  const { error, dismissError } = useShell();
  if (!error) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
      <span className="truncate">{error}</span>
      <button
        type="button"
        onClick={dismissError}
        className="shrink-0 rounded px-2 py-0.5 hover:bg-destructive/20"
      >
        Dismiss
      </button>
    </div>
  );
}

export function App() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <RuntimeProvider>
        <div className="flex h-dvh">
          <Sidebar
            collapsed={collapsed}
            onToggle={() => setCollapsed((v) => !v)}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <ErrorBanner />
            <div className="relative min-h-0 flex-1">
              {collapsed && (
                <TooltipIconButton
                  tooltip="Show sidebar"
                  side="right"
                  className="absolute top-2 left-2 z-10 size-8 bg-background/80 backdrop-blur-sm"
                  onClick={() => setCollapsed(false)}
                >
                  <PanelLeftIcon className="size-4" />
                </TooltipIconButton>
              )}
              <AssistantPane>
                <Thread />
              </AssistantPane>
            </div>
          </div>
        </div>
      </RuntimeProvider>
    </ThemeProvider>
  );
}
