import "./styles.css";
import { PanelLeftIcon } from "lucide-react";
import { ThemeProvider } from "next-themes";
import { z } from "zod";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { Sidebar } from "./components/sidebar";
import { Thread } from "./components/thread";
import { Toaster } from "./components/ui/sonner";
import { PERSIST_KEYS, usePersisted } from "./persist";
import { AssistantPane, RuntimeProvider } from "./runtime";

export function App() {
  const [collapsed, setCollapsed] = usePersisted(
    PERSIST_KEYS.sidebarHidden,
    z.boolean(),
    false,
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <RuntimeProvider>
        <div className="relative flex h-dvh">
          <TooltipIconButton
            tooltip={collapsed ? "Show sidebar" : "Hide sidebar"}
            side="right"
            className="absolute top-2 left-3 z-20 size-7"
            onClick={() => setCollapsed((v) => !v)}
          >
            <PanelLeftIcon className="size-4" />
          </TooltipIconButton>
          <Sidebar collapsed={collapsed} />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              <AssistantPane>
                <Thread />
              </AssistantPane>
            </div>
          </div>
        </div>
        <Toaster />
      </RuntimeProvider>
    </ThemeProvider>
  );
}
